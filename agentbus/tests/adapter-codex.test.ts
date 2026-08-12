/**
 * TASK-16: Codex 适配器（codex-cli 0.146.0 实测参数语义，架构 11.4）
 * - `codex exec [PROMPT]` 非交互；`--json` stdout JSONL 事件流
 * - 会话 id 实测在 `{"type":"thread.started","thread_id":"<uuid>"}`（2026-08-09 真实回合捕获）
 * - 最终回复实测走 `-o, --output-last-message <file>` 写文件，daemon 读文件（架构 4.6）
 * - `exec resume <id> [PROMPT]` 续接（UUID 或 thread name）
 * - 沙箱档恒为 `-s read-only`（架构 4.7；沟通定位：入站恒只读）
 * - 实测陷阱：stdin 为未关闭管道时 codex 阻塞等 EOF（base.runCommand 已顺修关闭 stdin）
 */
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodexAdapter } from "../src/adapters/codex.js";
import type { RunnerResult, SpawnSpec } from "../src/adapters/base.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentbus-codex-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** stub run：模拟 codex 行为——把 stdout 事件流回给适配器，并按 -o 参数写回复文件 */
function stubRun(opts: { stdout?: string; exitCode?: number; timedOut?: boolean; lastMessage?: string }) {
  const specs: SpawnSpec[] = [];
  const run = (s: SpawnSpec): Promise<RunnerResult> => {
    specs.push(s);
    const i = s.args.indexOf("-o");
    if (i >= 0 && opts.lastMessage !== undefined) {
      writeFileSync(s.args[i + 1]!, opts.lastMessage, "utf-8");
    }
    return Promise.resolve({
      exitCode: opts.exitCode ?? 0,
      stdout: opts.stdout ?? "",
      stderr: "",
      timedOut: opts.timedOut ?? false,
    });
  };
  return { run, specs };
}

const cfg = { workspace: "/proj" };

describe("参数装配", () => {
  it("createArgs：exec + --json + -s read-only + -C + -o + prompt 收尾", () => {
    const adapter = new CodexAdapter(cfg);
    const args = adapter.createArgs("请修复 bug", "/tmp/last.txt");
    expect(args[0]).toBe("exec");
    expect(args).toContain("--json");
    expect(args[args.indexOf("-s") + 1]).toBe("read-only");
    expect(args[args.indexOf("-C") + 1]).toBe("/proj");
    expect(args[args.indexOf("-o") + 1]).toBe("/tmp/last.txt");
    expect(args[args.length - 1]).toBe("请修复 bug");
  });

  it("resumeArgs：exec resume <id> + 同套选项 + prompt 收尾", () => {
    const adapter = new CodexAdapter(cfg);
    const args = adapter.resumeArgs("继续", "sess-uuid-1", "/tmp/last.txt");
    expect(args[0]).toBe("exec");
    expect(args[1]).toBe("resume");
    expect(args[2]).toBe("sess-uuid-1");
    expect(args).toContain("--json");
    expect(args[args.length - 1]).toBe("继续");
  });

  it("binary 可参数化（默认 codex）", async () => {
    const { run, specs } = stubRun({ lastMessage: "ok" });
    const adapter = new CodexAdapter({ ...cfg, binary: "my-codex", tmpDir: dir }, run);
    await adapter.createSession("hi");
    expect(specs[0]!.cmd).toBe("my-codex");
  });
});

describe("回合执行：会话 id 解析 + 文件输出", () => {
  it("createSession：从 thread.started 事件解析 thread_id，输出读 -o 文件", async () => {
    const stdout = [
      '{"type":"thread.started","thread_id":"019fe698-902b-71c0-af14-eb6bdf8e2876"}',
      '{"type":"turn.started"}',
      '{"type":"turn.completed"}',
    ].join("\n");
    const { run, specs } = stubRun({ stdout, lastMessage: "PONG" });
    const adapter = new CodexAdapter({ ...cfg, tmpDir: dir }, run);
    const turn = await adapter.createSession("Reply PONG");
    expect(turn.sessionId).toBe("019fe698-902b-71c0-af14-eb6bdf8e2876");
    expect(turn.output).toBe("PONG");
    expect(turn.error).toBeUndefined();
    // -o 文件回合后被清理
    const outFile = specs[0]!.args[specs[0]!.args.indexOf("-o") + 1]!;
    expect(existsSync(outFile)).toBe(false);
  });

  it("injectWith 走 resume 形态并复用 -o 文件读取", async () => {
    const { run, specs } = stubRun({
      stdout: '{"type":"thread.started","thread_id":"id-2"}',
      lastMessage: "第二轮",
    });
    const adapter = new CodexAdapter({ ...cfg, tmpDir: dir }, run);
    const turn = await adapter.injectWith("继续", "id-1");
    expect(turn.output).toBe("第二轮");
    expect(specs[0]!.args.slice(0, 3)).toEqual(["exec", "resume", "id-1"]);
  });

  it("无 thread.started 事件 → sessionId=null（调用方记告警，不崩）", async () => {
    const { run } = stubRun({ stdout: '{"type":"turn.completed"}', lastMessage: "ok" });
    const adapter = new CodexAdapter({ ...cfg, tmpDir: dir }, run);
    const turn = await adapter.createSession("hi");
    expect(turn.sessionId).toBeNull();
    expect(turn.output).toBe("ok");
  });

  it("-o 文件缺失时输出回退空串（不抛异常）", async () => {
    const { run } = stubRun({ stdout: '{"type":"thread.started","thread_id":"x"}' });
    const adapter = new CodexAdapter({ ...cfg, tmpDir: dir }, run);
    const turn = await adapter.createSession("hi");
    expect(turn.output).toBe("");
  });

  it("超时传播与非零退出码携带说明", async () => {
    const a1 = new CodexAdapter({ ...cfg, tmpDir: dir }, stubRun({ timedOut: true }).run);
    expect((await a1.createSession("hi")).error).toContain("超时");
    const a2 = new CodexAdapter({ ...cfg, tmpDir: dir }, stubRun({ exitCode: 2 }).run);
    expect((await a2.createSession("hi")).error).toContain("退出码 2");
  });
});

describe("extractSessionId：20 次解析正确率 100%（任务卡验证项）", () => {
  const adapter = new CodexAdapter(cfg);
  const cases: Array<{ name: string; stdout: string; expect: string | null }> = [
    // 真实格式（2026-08-09 实测捕获）
    { name: "真实事件单行", stdout: '{"type":"thread.started","thread_id":"019fe698-902b-71c0-af14-eb6bdf8e2876"}', expect: "019fe698-902b-71c0-af14-eb6bdf8e2876" },
    { name: "事件流中段出现", stdout: '{"type":"turn.started"}\n{"type":"thread.started","thread_id":"aaa-bbb"}\n{"type":"turn.completed"}', expect: "aaa-bbb" },
    { name: "前后有噪声事件", stdout: '{"type":"error","message":"Reconnecting... 1/5"}\n{"type":"thread.started","thread_id":"ccc"}', expect: "ccc" },
    { name: "行尾 CRLF", stdout: '{"type":"thread.started","thread_id":"ddd"}\r\n', expect: "ddd" },
    { name: "行首空白", stdout: '  {"type":"thread.started","thread_id":"eee"}', expect: "eee" },
    // 形态兼容（字段名漂移防御）
    { name: "session_id 形态", stdout: '{"type":"thread.started","session_id":"fff"}', expect: "fff" },
    { name: "sessionId 形态", stdout: '{"type":"thread.started","sessionId":"ggg"}', expect: "ggg" },
    { name: "嵌套 properties", stdout: '{"type":"session.created","properties":{"thread_id":"hhh"}}', expect: "hhh" },
    // 负例（必须返回 null，不得误报）
    { name: "空 stdout", stdout: "", expect: null },
    { name: "只有空白", stdout: "  \n  ", expect: null },
    { name: "无 thread 事件", stdout: '{"type":"turn.started"}\n{"type":"turn.completed"}', expect: null },
    { name: "非法 JSON 行", stdout: "codex 0.146.0 banner\nnot-json", expect: null },
    { name: "thread_id 为空串", stdout: '{"type":"thread.started","thread_id":""}', expect: null },
    { name: "thread_id 非字符串", stdout: '{"type":"thread.started","thread_id":123}', expect: null },
    { name: "JSON 数组顶层", stdout: '[{"type":"thread.started","thread_id":"zzz"}]', expect: null },
    { name: "error 事件含 message 不误导", stdout: '{"type":"error","message":"thread_id: fake"}', expect: null },
    { name: "混合：非法行后跟真实事件", stdout: "garbage\n{\"type\":\"thread.started\",\"thread_id\":\"iii\"}", expect: "iii" },
    { name: "多个 thread.started 取首个", stdout: '{"type":"thread.started","thread_id":"first"}\n{"type":"thread.started","thread_id":"second"}', expect: "first" },
    { name: "unicode 转义内容不影响解析", stdout: '{"type":"thread.started","thread_id":"jjj","note":"\\u4e2d\\u6587"}', expect: "jjj" },
    { name: "超长事件流", stdout: Array.from({ length: 50 }, (_, i) => `{"type":"item.completed","i":${i}}`).join("\n") + '\n{"type":"thread.started","thread_id":"kkk"}', expect: "kkk" },
  ];

  it(`共 ${cases.length} 个样本`, () => {
    expect(cases.length).toBe(20);
    for (const c of cases) {
      expect(adapter.extractSessionId(c.stdout), c.name).toBe(c.expect);
    }
  });
});
