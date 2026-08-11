/**
 * TASK-32 Task 7: init 随机 ID / 名称必答 / --from / 注册上报
 *
 * - client_id 默认 ag-+8hex；存量 config 保留原 ID（幂等）
 * - 交互名称必答（空值重问）；--yes 名称兜底目录名，--agent-name/--agent-description 覆盖
 * - --from 继承 broker/ns/凭证/tools；client_id 重随机；源缺失/非法 JSON 不推进
 * - 写 config 后 POST {hub}/api/agent/register（Basic=broker 凭证）；失败不阻断
 * - .gitignore 托管条目含 .agentbus/agents.json
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomClientId, runInit, type InitDeps } from "../src/init.js";

let root: string;
let home: string;

interface FetchCall {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

function fakeDeps(extra: Partial<InitDeps> = {}) {
  const runner = async (bin: string, args: string[]) => {
    if (args.includes("--version")) return { exitCode: 0, stdout: `${bin} 1.0.0`, stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const spawns: Array<{ cmd: string; args: string[] }> = [];
  const fetchCalls: FetchCall[] = [];
  const fetcher = async (url: string, init: Omit<FetchCall, "url">) => {
    fetchCalls.push({ ...init, url });
    return { ok: true, status: 200, text: async () => "{}" };
  };
  const deps: InitDeps = {
    projectRoot: root,
    homeDir: home,
    runner,
    spawnDaemon: (cmd, args) => spawns.push({ cmd, args }),
    fetcher: fetcher as unknown as InitDeps["fetcher"],
    ...extra,
  };
  return { deps, spawns, fetchCalls };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agentbus-prof-"));
  home = mkdtempSync(join(tmpdir(), "agentbus-profhome-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("randomClientId", () => {
  it("格式 ag- + 8 位 hex 且连发不重复", () => {
    const a = randomClientId();
    const b = randomClientId();
    expect(a).toMatch(/^ag-[0-9a-f]{8}$/);
    expect(b).toMatch(/^ag-[0-9a-f]{8}$/);
    expect(a).not.toBe(b);
  });
});

describe("client_id 默认随机 / 存量保留", () => {
  it("--yes 新项目：client_id 为随机 ag-+8hex", async () => {
    const { deps } = fakeDeps();
    const report = await runInit({ yes: true, tools: ["qoder"] }, deps);
    expect(report.ok).toBe(true);
    const cfg = JSON.parse(readFileSync(join(root, ".agentbus", "config.json"), "utf-8"));
    expect(cfg.client_id).toMatch(/^ag-[0-9a-f]{8}$/);
  });

  it("存量 config 重跑：保留原 client_id（幂等）", async () => {
    mkdirSync(join(root, ".agentbus"), { recursive: true });
    writeFileSync(join(root, ".agentbus", "config.json"), JSON.stringify({
      client_id: "legacy-id", ns: "pay",
      broker: { host: "localhost", port: 18830 }, sse_url: "http://localhost:8000/sse",
      default_tool: "qoder", allowed_senders: [], tools: { qoder: {} },
      ack: true, inbound_mode: "readonly",
    }), "utf-8");
    const { deps } = fakeDeps();
    const report = await runInit({ yes: true, tools: ["qoder"] }, deps);
    expect(report.ok).toBe(true);
    const cfg = JSON.parse(readFileSync(join(root, ".agentbus", "config.json"), "utf-8"));
    expect(cfg.client_id).toBe("legacy-id");
  });

  it("显式 --client-id 优先于存量与随机", async () => {
    mkdirSync(join(root, ".agentbus"), { recursive: true });
    writeFileSync(join(root, ".agentbus", "config.json"), JSON.stringify({
      client_id: "legacy-id", ns: "pay",
      broker: { host: "localhost", port: 18830 }, sse_url: "http://x:8000/sse",
      default_tool: "qoder", allowed_senders: [], tools: { qoder: {} },
      ack: true, inbound_mode: "readonly",
    }), "utf-8");
    const { deps } = fakeDeps();
    await runInit({ yes: true, tools: ["qoder"], clientId: "my-id" }, deps);
    const cfg = JSON.parse(readFileSync(join(root, ".agentbus", "config.json"), "utf-8"));
    expect(cfg.client_id).toBe("my-id");
  });
});

describe("--from 克隆源配置", () => {
  function writeSource(extra: Record<string, unknown> = {}): string {
    const src = join(home, "source-config.json");
    writeFileSync(src, JSON.stringify({
      client_id: "src-id", ns: "team-a",
      broker: { host: "10.0.0.9", port: 1883, username: "bob", password: "pw2" },
      sse_url: "http://10.0.0.9:8000/sse?client_id=src-id&ns=team-a",
      default_tool: "kilo", allowed_senders: [], tools: { kilo: {}, qoder: {} },
      ack: true, inbound_mode: "readonly", ...extra,
    }), "utf-8");
    return src;
  }

  it("继承 broker/ns/凭证/tools；client_id 重新随机；名称重新必答（--yes 兜底目录名）", async () => {
    const src = writeSource();
    const { deps, fetchCalls } = fakeDeps();
    const report = await runInit({ yes: true, from: src }, deps);
    expect(report.ok).toBe(true);
    const cfg = JSON.parse(readFileSync(join(root, ".agentbus", "config.json"), "utf-8"));
    expect(cfg.broker).toMatchObject({ host: "10.0.0.9", port: 1883, username: "bob", password: "pw2" });
    expect(cfg.ns).toBe("team-a");
    expect(Object.keys(cfg.tools).sort()).toEqual(["kilo", "qoder"]);
    expect(cfg.client_id).toMatch(/^ag-[0-9a-f]{8}$/);
    expect(cfg.client_id).not.toBe("src-id");
    // 注册上报用了新身份与目录名兜底名称
    expect(fetchCalls.length).toBe(1);
    const body = JSON.parse(fetchCalls[0].body!);
    expect(body.client_id).toBe(cfg.client_id);
    expect(body.name).toBe(basename(root));
  });

  it("源文件缺失：报错不推进（不写任何配置）", async () => {
    const { deps } = fakeDeps();
    const report = await runInit({ yes: true, from: join(home, "nope.json") }, deps);
    expect(report.ok).toBe(false);
    expect(report.lines.join("\n")).toMatch(/--from/);
    expect(existsSync(join(root, ".agentbus", "config.json"))).toBe(false);
  });

  it("源 JSON 非法：报错不推进", async () => {
    const src = join(home, "bad.json");
    writeFileSync(src, "{not json", "utf-8");
    const { deps } = fakeDeps();
    const report = await runInit({ yes: true, from: src }, deps);
    expect(report.ok).toBe(false);
    expect(existsSync(join(root, ".agentbus", "config.json"))).toBe(false);
  });
});

describe("注册上报 POST /api/agent/register", () => {
  it("成功：hub 由 sse_url 派生去路径；Basic=broker 凭证；body 含身份/名称/工具", async () => {
    const { deps, fetchCalls } = fakeDeps();
    const report = await runInit(
      { yes: true, tools: ["qoder"], broker: "10.1.5.100:18830", user: "bob", password: "pw2",
        agentName: "支付助手", agentDescription: "处理支付" },
      deps,
    );
    expect(report.ok).toBe(true);
    expect(fetchCalls.length).toBe(1);
    const call = fetchCalls[0];
    expect(call.url).toMatch(/^http:\/\/10\.1\.5\.100:8000\/api\/agent\/register$/);
    expect(call.method).toBe("POST");
    const basic = Buffer.from("bob:pw2").toString("base64");
    expect(call.headers?.["Authorization"]).toBe(`Basic ${basic}`);
    const body = JSON.parse(call.body!);
    const cfg = JSON.parse(readFileSync(join(root, ".agentbus", "config.json"), "utf-8"));
    expect(body.ns).toBe("default");
    expect(body.client_id).toBe(cfg.client_id);
    expect(body.name).toBe("支付助手");
    expect(body.description).toBe("处理支付");
    expect(body.tools).toEqual(["qoder"]);
    expect(report.lines.join("\n")).toMatch(/注册上报/);
  });

  it("hub 不可达：不阻断 init（ok=true），提示稍后重跑补注册", async () => {
    const { deps } = fakeDeps({
      fetcher: (async () => { throw new Error("ECONNREFUSED"); }) as unknown as InitDeps["fetcher"],
    });
    const report = await runInit(
      { yes: true, tools: ["qoder"], user: "bob", password: "pw2" }, deps,
    );
    expect(report.ok).toBe(true);
    expect(report.lines.join("\n")).toMatch(/稍后重跑 agentbus init 补注册/);
  });

  it("无 broker 凭证：跳过上报并提示（不阻断）", async () => {
    const { deps, fetchCalls } = fakeDeps();
    const report = await runInit({ yes: true, tools: ["qoder"] }, deps);
    expect(report.ok).toBe(true);
    expect(fetchCalls.length).toBe(0);
    expect(report.lines.join("\n")).toMatch(/凭证/);
  });
});

describe("交互名称必答与描述可选", () => {
  it("名称空值重问直到非空；描述回车跳过", async () => {
    const answers: Record<string, unknown[]> = {
      ns: ["pay"], clientId: ["ag-fixed01"], tools: [["qoder"]], scope: ["project"],
      broker: ["localhost:18830"], sseUrl: [""],
      agentName: ["", "  ", "真名"], agentDescription: [""],
    };
    const seen: string[] = [];
    const prompter = async (key: string, _d: unknown) => {
      seen.push(key);
      return answers[key].shift();
    };
    const { deps, fetchCalls } = fakeDeps({ prompter });
    const report = await runInit({ user: "bob", password: "pw" }, deps);
    expect(report.ok).toBe(true);
    // agentName 被问了 3 次（两次空值重问）
    expect(seen.filter((k) => k === "agentName").length).toBe(3);
    const body = JSON.parse(fetchCalls[0].body!);
    expect(body.name).toBe("真名");
    expect(body.description).toBe("");
  });

  it("交互默认建议：clientId 随机 ID、名称取目录名", async () => {
    const defaults: Record<string, unknown> = {};
    const prompter = async (key: string, d: unknown) => {
      defaults[key] = d;
      if (key === "tools") return ["qoder"];
      return d;
    };
    const { deps } = fakeDeps({ prompter });
    await runInit({}, deps);
    expect(String(defaults.clientId)).toMatch(/^ag-[0-9a-f]{8}$/);
    expect(defaults.agentName).toBe(basename(root));
  });
});

describe("gitignore 托管条目", () => {
  it("无凭证也写入 .agentbus/agents.json 条目（daemon 快照勿提交）", async () => {
    const { deps } = fakeDeps();
    await runInit({ yes: true, tools: ["qoder"] }, deps);
    const gi = readFileSync(join(root, ".gitignore"), "utf-8");
    expect(gi).toContain(".agentbus/");
    expect(gi).toContain(".agentbus/agents.json");
  });
});
