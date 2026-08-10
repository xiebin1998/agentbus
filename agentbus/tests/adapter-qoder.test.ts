/**
 * TASK-07: Qoder 适配器（qodercli 实测参数语义 2026-08-09）
 * - -p 是布尔开关，prompt 走位置参数（`--` 分隔防吞）
 * - --session-id <id> 幂等：新 id 建会话，已有 id 续接（create/inject 同一命令形态）
 * - -o json 输出结构化结果；readonly 无 plan 档 → 回退 --tools ""（禁全部内置工具）
 */
import { describe, expect, it } from "vitest";
import { newQoderSessionId, QoderAdapter } from "../src/adapters/qoder.js";
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
  it("fullArgs：dont_ask 权限 + 会话 + json 输出 + prompt 收尾", () => {
    const adapter = new QoderAdapter(cfg);
    const args = adapter.fullArgs("请修复 bug", "sess-1");
    expect(args).toContain("--permission-mode");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("dont_ask");
    expect(args).toContain("--session-id");
    expect(args[args.indexOf("--session-id") + 1]).toBe("sess-1");
    expect(args).toContain("-p");
    expect(args).toContain("-o");
    expect(args[args.indexOf("-o") + 1]).toBe("json");
    expect(args).toContain("-w");
    expect(args[args.indexOf("-w") + 1]).toBe("/proj");
    expect(args[args.length - 1]).toBe("请修复 bug");
    expect(args[args.length - 2]).toBe("--"); // prompt 前有 -- 分隔
  });

  it("readonlyArgs：--tools 空串禁用全部内置工具（无 plan 档的回退方案）", () => {
    const adapter = new QoderAdapter(cfg);
    const args = adapter.readonlyArgs("只许看不许改", "sess-1");
    const i = args.indexOf("--tools");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe("");
    expect(args).not.toContain("dont_ask"); // 只读回合不放宽权限
  });

  it("binary 可参数化（默认 qodercli）", () => {
    const a = new QoderAdapter({ ...cfg, binary: "my-qoder" });
    const { run, specs } = stubRun({ stdout: '{"result":"ok"}' });
    const adapter = new QoderAdapter({ ...cfg, binary: "my-qoder" }, run);
    void a;
    void adapter.createSession("hi", "s1");
    expect(specs[0]!.cmd).toBe("my-qoder");
  });
});

describe("回合执行与输出提取", () => {
  it("createSession 返回 sessionId 与结构化输出（result 字段）", async () => {
    const { run } = stubRun({ stdout: JSON.stringify({ session_id: "sess-1", result: "已完成修复" }) });
    const adapter = new QoderAdapter(cfg, run);
    const turn = await adapter.createSession("请修复 bug", "sess-1");
    expect(turn.sessionId).toBe("sess-1");
    expect(turn.output).toBe("已完成修复");
    expect(turn.exitCode).toBe(0);
    expect(turn.timedOut).toBe(false);
  });

  it("inject 与 createSession 同一命令形态（--session-id 幂等续接）", async () => {
    const { run, specs } = stubRun({ stdout: '{"result":"第二轮回复"}' });
    const adapter = new QoderAdapter(cfg, run);
    const turn = await adapter.inject("继续", "sess-1");
    expect(turn.output).toBe("第二轮回复");
    expect(specs[0]!.args).toContain("--session-id");
  });

  it("非 JSON stdout 回退为裸文本（trim）", async () => {
    const { run } = stubRun({ stdout: "  纯文本回复  \n" });
    const adapter = new QoderAdapter(cfg, run);
    const turn = await adapter.inject("hi", "s1");
    expect(turn.output).toBe("纯文本回复");
  });

  it("JSON 无 result 字段时按 message/text/content 降级", async () => {
    const { run } = stubRun({ stdout: JSON.stringify({ message: "降级字段" }) });
    const adapter = new QoderAdapter(cfg, run);
    expect((await adapter.inject("hi", "s1")).output).toBe("降级字段");
  });

  it("超时传播：turn.timedOut=true 且 error 有说明", async () => {
    const { run } = stubRun({ timedOut: true, stdout: "" });
    const adapter = new QoderAdapter(cfg, run);
    const turn = await adapter.inject("hi", "s1");
    expect(turn.timedOut).toBe(true);
    expect(turn.error).toContain("超时");
  });

  it("非零退出码携带 stderr 摘要到 error", async () => {
    const { run } = stubRun({ exitCode: 1, stderr: "auth failed", stdout: "" });
    const adapter = new QoderAdapter(cfg, run);
    const turn = await adapter.inject("hi", "s1");
    expect(turn.exitCode).toBe(1);
    expect(turn.error).toContain("auth failed");
  });

  it("is_error=true 且 exitCode=0 仍识别为失败（实测：未登录时进程正常退出）", async () => {
    const { run } = stubRun({
      exitCode: 0,
      stdout: JSON.stringify({ type: "result", is_error: true, result: "Not logged in · Please run /login" }),
    });
    const adapter = new QoderAdapter(cfg, run);
    const turn = await adapter.inject("hi", "s1");
    expect(turn.error).toContain("Not logged in");
  });

  it("spawn 失败（binary 缺失 ENOENT）：error 保真不被逻辑检查覆写（TASK-29 实测缺陷）", async () => {
    const { run } = stubRun({ exitCode: -1, stdout: "", stderr: "", error: "spawn 失败: spawn no-such-bin ENOENT" });
    const adapter = new QoderAdapter(cfg, run);
    const turn = await adapter.inject("hi", "s1");
    expect(turn.error).toContain("ENOENT"); // 回归：此前被 detectLogicalError 覆写成 undefined → daemon 静默“成功”
  });
});

describe("extractText 边界", () => {
  const adapter = new QoderAdapter(cfg);
  it("空 stdout → 空串", () => {
    expect(adapter.extractText("")).toBe("");
  });
  it("JSON result 为对象时序列化回退原文", () => {
    expect(adapter.extractText('{"result":{"deep":1}}')).toContain("deep");
  });
});

describe("newQoderSessionId", () => {
  it("生成合法 UUID（qodercli --session-id 的硬约束）", () => {
    expect(newQoderSessionId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});
