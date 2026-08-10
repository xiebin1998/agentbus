/**
 * TASK-19: daemon 指标上报接线
 * - 启动即报一次 + 按 metricIntervalMs 周期上报（测试注入短间隔）
 * - 计数挂点：注入成功/失败、去重、白名单丢弃
 * - 通道：publish 到 /phnix/ai/metric/<ns>/<client_id>，payload type=metric
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import aedes from "aedes";
import mqtt, { type MqttClient } from "mqtt";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentBusConfig } from "../src/config.js";
import { Daemon } from "../src/daemon/daemon.js";

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

async function waitFor(cond: () => boolean, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitFor 超时");
    await new Promise((r) => setTimeout(r, 20));
  }
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

/** 指标收集客户端：订阅 /phnix/ai/metric/# */
async function makeMetricCollector(): Promise<{ client: MqttClient; reports: Array<{ topic: string; payload: Record<string, unknown> }> }> {
  const reports: Array<{ topic: string; payload: Record<string, unknown> }> = [];
  const client = mqtt.connect(`mqtt://127.0.0.1:${port}`, { clientId: "metric-collector" });
  await new Promise<void>((resolve) => client.on("connect", () => resolve()));
  await new Promise<void>((resolve) => client.subscribe("/phnix/ai/metric/#", { qos: 1 }, () => resolve()));
  client.on("message", (topic, payload) => {
    try {
      reports.push({ topic, payload: JSON.parse(payload.toString("utf-8")) as Record<string, unknown> });
    } catch {
      // 非 JSON 忽略
    }
  });
  return { client, reports };
}

function publishToDaemon(msg: Record<string, unknown>): void {
  broker.publish({
    cmd: "publish",
    topic: "/phnix/ai/channel/default/fe-test/message",
    payload: JSON.stringify({ type: "text", hop: 0, expect_reply: false, ...msg }),
    qos: 1,
    retain: false,
    dup: false,
  }, () => {});
}

const latestMetrics = (reports: Array<{ payload: Record<string, unknown> }>) =>
  (reports[reports.length - 1]?.payload.metrics ?? {}) as Record<string, number>;

describe("daemon 指标上报", { timeout: 30000 }, () => {
  it("启动即报 + 周期上报到 metric topic；注入成功/失败、去重、白名单丢弃均计数", async () => {
    const collector = await makeMetricCollector();
    const dir = mkdtempSync(join(tmpdir(), "agentbus-metrics-"));
    let failNext = false;
    const daemon = new Daemon({
      config: makeConfig({ ack: false, allowed_senders: ["be-svc"] }),
      workDir: dir,
      metricIntervalMs: 300,
      inject: async () => {
        if (failNext) {
          failNext = false;
          throw new Error("模拟注入失败");
        }
        return { output: "ok" };
      },
    });
    expect(daemon.start()).toMatchObject({ started: true });

    // 启动即报一次（无需等注入发生）
    await waitFor(() => collector.reports.length >= 1);
    expect(collector.reports[0]!.topic).toBe("/phnix/ai/metric/default/fe-test");
    expect(collector.reports[0]!.payload.type).toBe("metric");
    expect(collector.reports[0]!.payload.from).toBe("default/fe-test");

    // 注入成功计数
    publishToDaemon({ id: "m-1", from: "be-svc", to: "fe-test", text: "hi" });
    await waitFor(() => latestMetrics(collector.reports).injected_ok >= 1);

    // 注入失败计数
    failNext = true;
    publishToDaemon({ id: "m-2", from: "be-svc", to: "fe-test", text: "boom" });
    await waitFor(() => latestMetrics(collector.reports).injected_fail >= 1);

    // 去重计数（同 id 重发）
    publishToDaemon({ id: "m-1", from: "be-svc", to: "fe-test", text: "hi" });
    await waitFor(() => latestMetrics(collector.reports).deduped >= 1);

    // 白名单丢弃计数
    publishToDaemon({ id: "m-3", from: "evil", to: "fe-test", text: "not allowed" });
    await waitFor(() => latestMetrics(collector.reports).dropped >= 1);

    // 周期性：报告条数持续增长（300ms 间隔）
    const before = collector.reports.length;
    await waitFor(() => collector.reports.length >= before + 2);

    await daemon.stop();
    collector.client.end(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
