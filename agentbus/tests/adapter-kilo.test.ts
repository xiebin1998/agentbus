/**
 * TASK-08: OpenCode/Kilo 适配器（同族共用，二进制名参数化）
 * 实测 kilo 7.4.17 run 子命令（2026-08-09）：
 * - `--title` 会话命名原生支持；`-s/--session <id>` 续接
 * - `--format json` 原始 JSON 事件流（NDJSON）；`--auto` 全自动批准
 * - `--dir` 工作目录；无只读权限档 → readonly 仅信封约束（架构 4.7 回退）
 */
import { describe, expect, it } from "vitest";
import { OpenCodeKiloAdapter } from "../src/adapters/opencode-kilo.js";
import type { RunnerResult, SpawnSpec } from "../src/adapters/base.js";

function stubRun(result: Partial<RunnerResult>): { run: (s: SpawnSpec) => Promise<RunnerResult>; specs: SpawnSpec[] } {
  const specs: SpawnSpec[] = [];
  return {
    specs,
    run: (s: SpawnSpec) => {
      specs.push(s);
      return Promise.resolve({
        exitCode: result.exitCode ?? 0,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        timedOut: result.timedOut ?? false,
        error: result.error,
      });
    },
  };
}

const cfg = { workspace: "/proj", timeoutMs: 300_000 };

describe("参数装配", () => {
  it("createSessionArgs：run --title --format json --dir + 消息收尾", () => {
    const adapter = new OpenCodeKiloAdapter(cfg);
    const args = adapter.createSessionArgs("第一条消息", "be-svc");
    expect(args[0]).toBe("run");
    expect(args).toContain("--title");
    expect(args[args.indexOf("--title") + 1]).toBe("be-svc");
    expect(args).toContain("--format");
    expect(args[args.indexOf("--format") + 1]).toBe("json");
    expect(args).toContain("--dir");
    expect(args[args.indexOf("--dir") + 1]).toBe("/proj");
    expect(args[args.length - 1]).toBe("第一条消息");
  });

  it("injectArgs：-s <session> 续接", () => {
    const adapter = new OpenCodeKiloAdapter(cfg);
    const args = adapter.injectArgs("继续", "ses-abc");
    expect(args).toContain("-s");
    expect(args[args.indexOf("-s") + 1]).toBe("ses-abc");
    expect(args).toContain("--format");
  });

  it("fullArgs 追加 --auto；readonlyArgs 不加权限参数（仅信封约束）", () => {
    const adapter = new OpenCodeKiloAdapter(cfg);
    expect(adapter.fullArgs("m", "be-svc")).toContain("--auto");
    expect(adapter.readonlyArgs("m", "be-svc")).not.toContain("--auto");
  });

  it("binary 参数化：kilo 与 opencode 同族共用", () => {
    const { run, specs } = stubRun({ stdout: "" });
    const kilo = new OpenCodeKiloAdapter({ ...cfg, binary: "kilo" }, run);
    const oc = new OpenCodeKiloAdapter({ ...cfg, binary: "opencode" }, run);
    void kilo.inject("a", "s1");
    void oc.inject("b", "s2");
    expect(specs[0]!.cmd).toBe("kilo");
    expect(specs[1]!.cmd).toBe("opencode");
  });
});

describe("输出提取（--format json NDJSON 事件流，取末条文本事件）", () => {
  const adapter = new OpenCodeKiloAdapter(cfg);

  it("从事件流中取末条文本事件的 text", () => {
    const stream = [
      JSON.stringify({ type: "step_start" }),
      JSON.stringify({ type: "text", text: "第一段" }),
      JSON.stringify({ type: "text", text: "最终回复" }),
      JSON.stringify({ type: "done" }),
    ].join("\n");
    expect(adapter.extractText(stream)).toBe("最终回复");
  });

  it("兼容 message.content/parts 形状的事件", () => {
    const stream = JSON.stringify({ type: "message", message: { content: "内容回复" } });
    expect(adapter.extractText(stream)).toBe("内容回复");
    const parts = JSON.stringify({ type: "message", parts: [{ type: "text", text: "parts 回复" }] });
    expect(adapter.extractText(parts)).toBe("parts 回复");
  });

  it("事件流无文本事件 → 回退整段 trim", () => {
    expect(adapter.extractText('{"type":"done"}')).toBe('{"type":"done"}');
    expect(adapter.extractText("")).toBe("");
  });

  it("非法 JSON 行被跳过，仍取到有效末条", () => {
    const stream = 'garbage line\n{"type":"text","text":"有效回复"}\nmore garbage';
    expect(adapter.extractText(stream)).toBe("有效回复");
  });
});

describe("回合执行", () => {
  it("createSession 从事件流提取 session id（新会话无 -s）", async () => {
    const stream = [
      JSON.stringify({ type: "session", session_id: "ses-new-1" }),
      JSON.stringify({ type: "text", text: "建好了" }),
    ].join("\n");
    const { run, specs } = stubRun({ stdout: stream });
    const adapter = new OpenCodeKiloAdapter(cfg, run);
    const turn = await adapter.createSession("你好", "be-svc");
    expect(turn.sessionId).toBe("ses-new-1");
    expect(turn.output).toBe("建好了");
    expect(specs[0]!.args).not.toContain("-s"); // 新会话不续接
  });

  it("session 事件缺失时 sessionId 回退为 null（注册表需另行处理）", async () => {
    const { run } = stubRun({ stdout: JSON.stringify({ type: "text", text: "ok" }) });
    const adapter = new OpenCodeKiloAdapter(cfg, run);
    const turn = await adapter.createSession("你好", "be-svc");
    expect(turn.sessionId).toBeNull();
  });

  it("inject 复用会话：-s 传入注册表 session id", async () => {
    const { run, specs } = stubRun({ stdout: JSON.stringify({ type: "text", text: "回复" }) });
    const adapter = new OpenCodeKiloAdapter(cfg, run);
    const turn = await adapter.inject("继续", "ses-new-1");
    expect(turn.output).toBe("回复");
    expect(specs[0]!.args).toContain("-s");
  });

  it("超时与非零退出传播为 error", async () => {
    const { run } = stubRun({ timedOut: true });
    const adapter = new OpenCodeKiloAdapter(cfg, run);
    expect((await adapter.inject("x", "s")).error).toContain("超时");
    const { run: run2 } = stubRun({ exitCode: 2, stderr: "boom" });
    const a2 = new OpenCodeKiloAdapter(cfg, run2);
    expect((await a2.inject("x", "s")).error).toContain("boom");
  });
});
