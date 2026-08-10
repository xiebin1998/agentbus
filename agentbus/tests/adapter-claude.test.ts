/**
 * TASK-15: Claude 适配器（claude CLI 实测参数语义，架构 11.3）
 * - create：--session-id <uuid>（daemon 预生成，合法 UUID 硬约束）+ -n 会话名
 * - inject：-r <uuid> 续接（与 create 不同命令形态，区别于 qoder 族的幂等 --session-id）
 * - -p 布尔开关 + --output-format json 结构化输出（result 字段）
 * - readonly → --permission-mode plan（实测档，禁写禁执行，架构 4.7）
 * - full → --permission-mode dontAsk
 */
import { describe, expect, it } from "vitest";
import { newClaudeSessionId, ClaudeAdapter } from "../src/adapters/claude.js";
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
  it("createArgs（full）：--session-id + -n 会话名 + -p + json 输出 + dontAsk + prompt 收尾", () => {
    const adapter = new ClaudeAdapter({ ...cfg, sessionName: "qoder-agent" });
    const args = adapter.createArgs("请修复 bug", "sess-1", "full");
    expect(args).toContain("--session-id");
    expect(args[args.indexOf("--session-id") + 1]).toBe("sess-1");
    expect(args).toContain("-n");
    expect(args[args.indexOf("-n") + 1]).toBe("qoder-agent");
    expect(args).toContain("-p");
    expect(args).toContain("--output-format");
    expect(args[args.indexOf("--output-format") + 1]).toBe("json");
    expect(args).toContain("--permission-mode");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(args[args.length - 1]).toBe("请修复 bug");
    expect(args[args.length - 2]).toBe("--"); // prompt 前有 -- 分隔防吞
  });

  it("injectArgs：-r <uuid> 续接（不再带 --session-id/-n）", () => {
    const adapter = new ClaudeAdapter({ ...cfg, sessionName: "x" });
    const args = adapter.injectArgs("继续", "sess-1", "full");
    expect(args).toContain("-r");
    expect(args[args.indexOf("-r") + 1]).toBe("sess-1");
    expect(args).not.toContain("--session-id");
    expect(args).not.toContain("-n");
    expect(args[args.length - 1]).toBe("继续");
  });

  it("readonly 档 → --permission-mode plan（实测只读档，禁写禁执行）", () => {
    const adapter = new ClaudeAdapter(cfg);
    const args = adapter.injectArgs("只许看不许改", "sess-1", "readonly");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("plan");
    expect(args).not.toContain("dontAsk");
  });

  it("sessionName 缺省时不传 -n", () => {
    const adapter = new ClaudeAdapter(cfg);
    expect(adapter.createArgs("hi", "s1", "full")).not.toContain("-n");
  });

  it("binary 可参数化（默认 claude）", async () => {
    const { run, specs } = stubRun({ stdout: '{"result":"ok"}' });
    const adapter = new ClaudeAdapter({ ...cfg, binary: "my-claude" }, run);
    await adapter.createSession("hi", "s1", "full");
    expect(specs[0]!.cmd).toBe("my-claude");
  });
});

describe("回合执行与输出提取", () => {
  it("createSession 返回结构化输出（result 字段）", async () => {
    const { run, specs } = stubRun({ stdout: JSON.stringify({ type: "result", session_id: "sess-1", result: "已完成修复" }) });
    const adapter = new ClaudeAdapter(cfg, run);
    const turn = await adapter.createSession("请修复 bug", "sess-1", "full");
    expect(turn.sessionId).toBe("sess-1");
    expect(turn.output).toBe("已完成修复");
    expect(turn.exitCode).toBe(0);
    expect(specs[0]!.args).toContain("--session-id");
    expect(specs[0]!.cwd).toBe("/proj");
  });

  it("inject 走 -r 续接形态，readonly 档用 plan", async () => {
    const { run, specs } = stubRun({ stdout: '{"result":"第二轮回复"}' });
    const adapter = new ClaudeAdapter(cfg, run);
    const turn = await adapter.injectWith("继续", "sess-1", "readonly");
    expect(turn.output).toBe("第二轮回复");
    expect(specs[0]!.args).toContain("-r");
    expect(specs[0]!.args[specs[0]!.args.indexOf("--permission-mode") + 1]).toBe("plan");
  });

  it("非 JSON stdout 回退为裸文本（trim）", async () => {
    const { run } = stubRun({ stdout: "  纯文本回复  \n" });
    const adapter = new ClaudeAdapter(cfg, run);
    const turn = await adapter.injectWith("hi", "s1", "full");
    expect(turn.output).toBe("纯文本回复");
  });

  it("JSON 无 result 字段时按 message/text/content 降级", async () => {
    const { run } = stubRun({ stdout: JSON.stringify({ message: "降级字段" }) });
    const adapter = new ClaudeAdapter(cfg, run);
    expect((await adapter.injectWith("hi", "s1", "full")).output).toBe("降级字段");
  });

  it("超时传播：turn.timedOut=true 且 error 有说明", async () => {
    const { run } = stubRun({ timedOut: true, stdout: "" });
    const adapter = new ClaudeAdapter(cfg, run);
    const turn = await adapter.injectWith("hi", "s1", "full");
    expect(turn.timedOut).toBe(true);
    expect(turn.error).toContain("超时");
  });

  it("非零退出码携带 stderr 摘要到 error", async () => {
    const { run } = stubRun({ exitCode: 1, stderr: "auth failed", stdout: "" });
    const adapter = new ClaudeAdapter(cfg, run);
    const turn = await adapter.injectWith("hi", "s1", "full");
    expect(turn.exitCode).toBe(1);
    expect(turn.error).toContain("auth failed");
  });

  it("is_error=true 且 exitCode=0 仍识别为失败（实测：未登录时进程正常退出）", async () => {
    const { run } = stubRun({
      exitCode: 0,
      stdout: JSON.stringify({ type: "result", is_error: true, result: "Not logged in · Please run /login" }),
    });
    const adapter = new ClaudeAdapter(cfg, run);
    const turn = await adapter.injectWith("hi", "s1", "full");
    expect(turn.error).toContain("Not logged in");
  });

  it("spawn 失败（binary 缺失 ENOENT）：error 保真不被逻辑检查覆写（TASK-29 实测缺陷）", async () => {
    const { run } = stubRun({ exitCode: -1, stdout: "", stderr: "", error: "spawn 失败: spawn no-such-bin ENOENT" });
    const adapter = new ClaudeAdapter(cfg, run);
    const turn = await adapter.injectWith("hi", "s1", "full");
    expect(turn.error).toContain("ENOENT");
  });
});

describe("extractText 边界", () => {
  const adapter = new ClaudeAdapter(cfg);
  it("空 stdout → 空串", () => {
    expect(adapter.extractText("")).toBe("");
  });
  it("JSON result 为对象时序列化回退原文", () => {
    expect(adapter.extractText('{"result":{"deep":1}}')).toContain("deep");
  });
});

describe("newClaudeSessionId", () => {
  it("生成合法 UUID（claude --session-id 的硬约束）", () => {
    expect(newClaudeSessionId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});
