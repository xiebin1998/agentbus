/**
 * TASK-18: Hermes 适配器（远端 Linux Agent，本机经 SSH 注入，架构 5.5/11.6）
 *
 * 契约要点（架构 11.6 用户提供参数面）：
 * - `-z <prompt>` oneshot：只输出最终结果（stdout 即回合输出），自动绕过审批
 * - `-c <名>` 按名建/续会话（会话名 = 推送来源 client_id），建/续同一命令形态（按名幂等）
 * - 无只读权限档（--safe-mode 仅禁自定义扩展）→ readonly 仅信封约束（架构 4.7 回退）
 * - 配 remote 时经 `ssh [-i key] [user@]host` 注入远端，远端命令为 `cd <workspace> && hermes ...`
 */
import { describe, expect, it } from "vitest";
import { HermesAdapter, shellQuote } from "../src/adapters/hermes.js";
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

const cfg = { workspace: "~/agent-home", timeoutMs: 300_000 };

describe("参数装配（本机直连形态）", () => {
  it("turnArgs：-z <msg> -c <名>，建/续同一命令形态（按名幂等）", () => {
    const adapter = new HermesAdapter(cfg);
    expect(adapter.turnArgs("第一条", "be-svc")).toEqual(["-z", "第一条", "-c", "be-svc"]);
    const a = new HermesAdapter(cfg);
    expect(a.createSessionArgs("x", "s")).toEqual(a.injectArgs("x", "s"));
  });

  it("readonly/full 参数形态相同：无只读权限档，readonly 仅信封约束；-z 已自动免确认", () => {
    const adapter = new HermesAdapter(cfg);
    expect(adapter.createSessionArgs("m", "be-svc", "readonly")).toEqual(
      adapter.createSessionArgs("m", "be-svc", "full"),
    );
  });
});

describe("输出提取（-z oneshot 的 stdout 即最终结果）", () => {
  const adapter = new HermesAdapter(cfg);

  it("裸文本 trim 即回合输出（多行保留）", () => {
    expect(adapter.extractText("  最终回复\n第二行  \n")).toBe("最终回复\n第二行");
  });

  it("空输出回退空串", () => {
    expect(adapter.extractText("")).toBe("");
    expect(adapter.extractText("   \n")).toBe("");
  });
});

describe("回合执行", () => {
  it("本机直连：cmd=binary、cwd=workspace", async () => {
    const { run, specs } = stubRun({ stdout: "ok" });
    const adapter = new HermesAdapter({ ...cfg, binary: "hermes-nightly" }, run);
    await adapter.inject("继续", "be-svc");
    expect(specs[0]!.cmd).toBe("hermes-nightly");
    expect(specs[0]!.cwd).toBe("~/agent-home");
  });

  it("createSession 返回 sessionName 作为 sessionId（按名续接语义）", async () => {
    const { run } = stubRun({ stdout: "建好了" });
    const adapter = new HermesAdapter(cfg, run);
    const turn = await adapter.createSession("你好", "be-svc");
    expect(turn.sessionId).toBe("be-svc");
    expect(turn.output).toBe("建好了");
  });

  it("超时与非零退出传播为 error（含二进制名）", async () => {
    const { run } = stubRun({ timedOut: true });
    const adapter = new HermesAdapter(cfg, run);
    const timedOut = await adapter.inject("x", "s");
    expect(timedOut.error).toContain("超时");
    expect(timedOut.error).toContain("hermes");
    const { run: run2 } = stubRun({ exitCode: 3, stderr: "conn refused" });
    const a2 = new HermesAdapter(cfg, run2);
    const failed = await a2.inject("x", "s");
    expect(failed.error).toContain("退出码 3");
    expect(failed.error).toContain("conn refused");
  });
});

describe("remote SSH 注入（架构 4.4：tools.hermes.remote）", () => {
  const remote = { host: "10.1.5.200", user: "root", sshKey: "~/.ssh/id_ed25519" };

  it("cmd=ssh：BatchMode + -i key + user@host + 远端 cd && hermes 命令串", async () => {
    const { run, specs } = stubRun({ stdout: "远端回复" });
    const adapter = new HermesAdapter({ ...cfg, remote }, run);
    const turn = await adapter.inject("继续", "be-svc");
    const spec = specs[0]!;
    expect(spec.cmd).toBe("ssh");
    expect(spec.args).toContain("-o");
    expect(spec.args).toContain("BatchMode=yes");
    expect(spec.args[spec.args.indexOf("-i") + 1]).toBe("~/.ssh/id_ed25519");
    expect(spec.args).toContain("root@10.1.5.200");
    const remoteCmd = spec.args[spec.args.length - 1]!;
    expect(remoteCmd).toContain("cd");
    expect(remoteCmd).toContain("hermes -z");
    expect(remoteCmd).toContain("-c 'be-svc'");
    expect(turn.output).toBe("远端回复");
  });

  it("无 user → 目标仅 host；无 ssh_key → 不带 -i", async () => {
    const { run, specs } = stubRun({ stdout: "" });
    const adapter = new HermesAdapter({ ...cfg, remote: { host: "10.1.5.200" } }, run);
    await adapter.inject("x", "s");
    const spec = specs[0]!;
    expect(spec.args).toContain("10.1.5.200");
    expect(spec.args).not.toContain("-i");
  });

  it("带 ConnectTimeout：远端不可达时 ssh 快速失败而非挂到回合超时（真机冒烟实测）", async () => {
    const { run, specs } = stubRun({ stdout: "" });
    const adapter = new HermesAdapter({ ...cfg, remote }, run);
    await adapter.inject("x", "s");
    const args = specs[0]!.args;
    expect(args).toContain("ConnectTimeout=10");
  });

  it("消息含单引号时 shell 转义（' → '\\''），防远端命令注入", () => {
    expect(shellQuote("don't")).toBe("'don'\\''t'");
    const { run, specs } = stubRun({ stdout: "" });
    const adapter = new HermesAdapter({ ...cfg, remote }, run);
    void adapter.inject("it's $(rm -rf /) 注入尝试", "s");
    const remoteCmd = specs[0]!.args[specs[0]!.args.length - 1]!;
    expect(remoteCmd).toContain("'it'\\''s $(rm -rf /) 注入尝试'");
    expect(remoteCmd).not.toContain("$(rm -rf /)'");
  });

  it("remote 回合超时与非零退出同样传播为 error", async () => {
    const { run } = stubRun({ exitCode: 255, stderr: "ssh: connect timeout" });
    const adapter = new HermesAdapter({ ...cfg, remote }, run);
    const failed = await adapter.inject("x", "s");
    expect(failed.error).toContain("退出码 255");
    expect(failed.error).toContain("ssh: connect timeout");
  });
});
