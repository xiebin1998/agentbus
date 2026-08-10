/**
 * TASK-06/09: Daemon 集成测试（aedes 进程内 MQTT broker，无需 Docker）
 * 覆盖：连接订阅 → 路由注入（信封+信任）→ ack 回发 → 代回通道 → 失败通知 → 会话复用 → 去重 → pid 防护
 */
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import aedes from "aedes";
import mqtt, { type MqttClient } from "mqtt";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentBusConfig } from "../src/config.js";
import { Daemon, type InjectContext } from "../src/daemon/daemon.js";
import type { BusMessage } from "../src/protocol.js";

let broker: aedes.Aedes;
let server: Server;
let port: number;

function makeConfig(overrides: Partial<AgentBusConfig> = {}): AgentBusConfig {
  return {
    client_id: "fe-test",
    ns: "default",
    broker: { host: "127.0.0.1", port },
    default_tool: "kilo",
    allowed_senders: [],
    hop_limit: 3,
    rate_limit: 100,
    inbound_mode: "readonly",
    trust_map: {},
    tools: { kilo: {} },
    ack: true,
    ...overrides,
  };
}

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitFor 超时");
    await new Promise((r) => setTimeout(r, 20));
  }
}

interface Recorded {
  ctx: InjectContext;
}

beforeAll(async () => {
  broker = aedes();
  server = createServer(broker.handle);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => broker.close(() => resolve()));
  server.close();
});

/** 发件人客户端：订阅自身 flat topic 收 ack/代回/失败通知 */
async function makeSender(): Promise<{ client: MqttClient; received: BusMessage[] }> {
  const received: BusMessage[] = [];
  const client = mqtt.connect(`mqtt://127.0.0.1:${port}`, { clientId: "be-svc" });
  await new Promise<void>((resolve) => client.on("connect", () => resolve()));
  await new Promise<void>((resolve) =>
    client.subscribe("/agenthub/ai/channel/be-svc/message", { qos: 1 }, () => resolve()),
  );
  client.on("message", (_t, payload) => {
    received.push(JSON.parse(payload.toString("utf-8")) as BusMessage);
  });
  return { client, received };
}

function publishToDaemon(msg: Record<string, unknown>): void {
  broker.publish({
    cmd: "publish",
    topic: "/agenthub/ai/channel/default/fe-test/message",
    payload: JSON.stringify({ type: "text", hop: 0, expect_reply: true, ...msg }),
    qos: 1,
    retain: false,
    dup: false,
  }, () => {});
}

describe("daemon 端到端：路由 + ack + 会话", () => {
  const records: Recorded[] = [];
  let daemon: Daemon;
  let sender: { client: MqttClient; received: BusMessage[] };
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "agentbus-daemon-"));
    daemon = new Daemon({
      config: makeConfig(),
      workDir: dir,
      inject: async (ctx) => {
        records.push({ ctx });
        return { output: `回合输出-${records.length}` };
      },
    });
    expect(daemon.start()).toMatchObject({ started: true });
    sender = await makeSender();
    await waitFor(() => daemon.status().connected);
  });

  afterAll(async () => {
    await daemon.stop();
    sender.client.end(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("入站注入默认工具，信封携带 [AgentBus] 元数据与 readonly 指令", async () => {
    publishToDaemon({ id: "msg-e2e-1", from: "be-svc", to: "fe-test", text: "你好" });
    await waitFor(() => records.length === 1);
    const env = records[0]!.ctx.envelope;
    expect(env.split("\n")[0]).toBe("[AgentBus] id=msg-e2e-1 from=be-svc hop=0 expect_reply=true mode=readonly");
    expect(env).toContain("禁止修改任何文件");
    expect(env.trimEnd().endsWith("你好")).toBe(true);
    expect(records[0]!.ctx.mode).toBe("readonly");
    expect(records[0]!.ctx.tool).toBe("kilo");
  });

  it("ack 与代回先后送达发件人：代回三字段（reply_to/hop+1/expect_reply=false）", async () => {
    await waitFor(() => sender.received.length >= 2);
    const ack = sender.received.find((m) => m.type === "control")!;
    expect(ack.reply_to).toBe("msg-e2e-1");
    const reply = sender.received.find((m) => m.type === "text")!;
    expect(reply.reply_to).toBe("msg-e2e-1");
    expect(reply.hop).toBe(1);
    expect(reply.expect_reply).toBe(false);
    expect(reply.text).toBe("回合输出-1");
    expect(reply.from).toBe("default/fe-test");
  });

  it("会话写入 sessions.json（UUID），同一发件人复用", async () => {
    const reg = JSON.parse(readFileSync(join(dir, "sessions.json"), "utf-8"));
    const firstSession = reg.senders["be-svc"].kilo.sessionId;
    expect(firstSession).toMatch(/^[0-9a-f-]{36}$/);
    expect(records[0]!.ctx.sessionId).toBe(firstSession);

    publishToDaemon({ id: "msg-e2e-2", from: "be-svc", to: "fe-test", text: "再来一条" });
    await waitFor(() => records.length === 2);
    expect(records[1]!.ctx.sessionId).toBe(firstSession);
    expect(records[1]!.ctx.isNew).toBe(false);
  });

  it("重复 msg id 被去重", async () => {
    publishToDaemon({ id: "msg-e2e-1", from: "be-svc", to: "fe-test", text: "重复投递" });
    await new Promise((r) => setTimeout(r, 300));
    expect(records.length).toBe(2);
  });

  it("第二次 start 被 pid 锁拒绝；stop 清理", async () => {
    const second = new Daemon({ config: makeConfig(), workDir: dir });
    expect(second.start().started).toBe(false);
    expect(existsSync(join(dir, "daemon.pid"))).toBe(true);
    await daemon.stop();
    expect(existsSync(join(dir, "daemon.pid"))).toBe(false);
  });
});

describe("代回通道分支语义", () => {
  let dir: string;
  let sender: { client: MqttClient; received: BusMessage[] };

  it("expect_reply=false → 注入执行但不代回不回 ack 外的文本", async () => {
    dir = mkdtempSync(join(tmpdir(), "agentbus-daemon-noreply-"));
    const records: Recorded[] = [];
    const daemon = new Daemon({
      config: makeConfig({ ack: false }),
      workDir: dir,
      inject: async (ctx) => {
        records.push({ ctx });
        return { output: "不应被回传的输出" };
      },
    });
    daemon.start();
    sender = await makeSender();
    await waitFor(() => daemon.status().connected);

    publishToDaemon({ id: "msg-nr-1", from: "be-svc", to: "fe-test", text: "通知你一下", expect_reply: false });
    await waitFor(() => records.length === 1);
    expect(records[0]!.ctx.envelope).toContain("无需回复");
    await new Promise((r) => setTimeout(r, 400));
    expect(sender.received.filter((m) => m.type === "text")).toEqual([]); // 无代回

    await daemon.stop();
    sender.client.end(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("注入抛错 → 发 control 失败通知（防对方干等）", async () => {
    dir = mkdtempSync(join(tmpdir(), "agentbus-daemon-fail-"));
    const daemon = new Daemon({
      config: makeConfig({ ack: false }),
      workDir: dir,
      inject: async () => {
        throw new Error("CLI 超时模拟");
      },
    });
    daemon.start();
    sender = await makeSender();
    await waitFor(() => daemon.status().connected);

    publishToDaemon({ id: "msg-fail-1", from: "be-svc", to: "fe-test", text: "请处理" });
    await waitFor(() => sender.received.length >= 1);
    const notice = sender.received[0]!;
    expect(notice.type).toBe("control");
    expect(notice.text).toContain("CLI 超时模拟");
    expect(notice.reply_to).toBe("msg-fail-1");
    expect(notice.expect_reply).toBe(false);

    await daemon.stop();
    sender.client.end(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("trust_map 覆盖：ci-bot 获得 full，信封 mode=full 无只读禁令", async () => {
    dir = mkdtempSync(join(tmpdir(), "agentbus-daemon-trust-"));
    const records: Recorded[] = [];
    const daemon = new Daemon({
      config: makeConfig({ trust_map: { "be-svc": "full" }, ack: false }),
      workDir: dir,
      inject: async (ctx) => {
        records.push({ ctx });
        return { output: "ok" };
      },
    });
    daemon.start();
    sender = await makeSender();
    await waitFor(() => daemon.status().connected);

    publishToDaemon({ id: "msg-trust-1", from: "be-svc", to: "fe-test", text: "全权处理" });
    await waitFor(() => records.length === 1);
    expect(records[0]!.ctx.mode).toBe("full");
    expect(records[0]!.ctx.envelope.split("\n")[0]).toContain("mode=full");
    expect(records[0]!.ctx.envelope).not.toContain("禁止修改任何文件");

    await daemon.stop();
    sender.client.end(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("daemon 日志路径（架构 6.2：.agentbus/logs/daemon.log）", () => {
  it("日志写入 logs/daemon.log 且 logs 目录不存在时自动创建", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentbus-logpath-"));
    const daemon = new Daemon({
      config: makeConfig(),
      workDir: dir,
      inject: async () => ({ output: "" }),
    });
    expect(daemon.start()).toMatchObject({ started: true });
    await waitFor(() => daemon.status().connected);
    await daemon.stop();
    expect(existsSync(join(dir, "logs", "daemon.log"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("一期安全验收（架构第 10 章）", () => {
  it("非白名单来源：丢弃 + 告警落盘，不发生注入", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentbus-sec-"));
    const records: Recorded[] = [];
    const daemon = new Daemon({
      config: makeConfig({ allowed_senders: ["trusted-only"] }),
      workDir: dir,
      inject: async (ctx) => {
        records.push({ ctx });
        return { output: "" };
      },
    });
    expect(daemon.start()).toMatchObject({ started: true });
    await waitFor(() => daemon.status().connected);

    publishToDaemon({ id: "msg-sec-1", from: "evil-src", to: "fe-test", text: "恶意试探" });
    await new Promise((r) => setTimeout(r, 400));
    expect(records.length).toBe(0);
    const log = readFileSync(join(dir, "logs", "daemon.log"), "utf-8");
    expect(log).toContain("WARN");
    expect(log).toContain("不在 allowed_senders 白名单");

    await daemon.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("hop 熔断：hop 超限时丢弃 + 告警落盘，不发生注入", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentbus-hop-"));
    const records: Recorded[] = [];
    const daemon = new Daemon({
      config: makeConfig(), // hop_limit=3
      workDir: dir,
      inject: async (ctx) => {
        records.push({ ctx });
        return { output: "" };
      },
    });
    expect(daemon.start()).toMatchObject({ started: true });
    await waitFor(() => daemon.status().connected);

    publishToDaemon({ id: "msg-hop-1", from: "be-svc", to: "fe-test", text: "环路消息", hop: 4 });
    await new Promise((r) => setTimeout(r, 400));
    expect(records.length).toBe(0);
    const log = readFileSync(join(dir, "logs", "daemon.log"), "utf-8");
    expect(log).toContain("环路熔断");

    await daemon.stop();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("TASK-29：并发不串话（同一发件人回合串行，PLAN T25）", () => {
  it("同源 3 条消息同时到达：回合严格按到达顺序串行，无并发重叠", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentbus-conc-"));
    let active = 0;
    let maxActive = 0;
    const order: string[] = [];
    const daemon = new Daemon({
      config: makeConfig({ ack: false, rate_limit: 100 }),
      workDir: dir,
      inject: async (ctx) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 60)); // 慢回合放大竞争窗口
        order.push(ctx.msg.id);
        active -= 1;
        return { output: "ok" };
      },
    });
    expect(daemon.start()).toMatchObject({ started: true });
    await waitFor(() => daemon.status().connected);

    for (let i = 1; i <= 3; i++) {
      publishToDaemon({ id: `msg-conc-${i}`, from: "be-svc", to: "fe-test", text: `第${i}条` });
    }
    await waitFor(() => order.length === 3, 8000);
    expect(maxActive).toBe(1); // 不串话核心：同一会话零重叠
    expect(order).toEqual(["msg-conc-1", "msg-conc-2", "msg-conc-3"]);

    await daemon.stop();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("TASK-29：重连自愈（broker 抖动后自动恢复，PLAN T25）", () => {
  it("broker 断连重启后 daemon 自动重连并继续注入", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentbus-recon-"));
    const records: Recorded[] = [];
    const daemon = new Daemon({
      config: makeConfig({ ack: false }),
      workDir: dir,
      inject: async (ctx) => {
        records.push({ ctx });
        return { output: "ok" };
      },
    });
    expect(daemon.start()).toMatchObject({ started: true });
    await waitFor(() => daemon.status().connected);

    // broker 抖动：先关 aedes（断开全部客户端）再关 TCP 监听，否则 close 互相等待挂死
    await new Promise<void>((resolve) => broker.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise((r) => setTimeout(r, 200));
    expect(daemon.status().connected).toBe(false);

    // 同端口重建 broker（mqtt.js reconnectPeriod=2s 自动恢复）
    broker = aedes();
    server = createServer(broker.handle);
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    await waitFor(() => daemon.status().connected, 15_000);

    publishToDaemon({ id: "msg-recon-1", from: "be-svc", to: "fe-test", text: "重连后第一条" });
    await waitFor(() => records.length === 1, 8000);
    expect(records[0]!.ctx.msg.id).toBe("msg-recon-1");

    await daemon.stop();
    rmSync(dir, { recursive: true, force: true });
  }, 20_000);
});
