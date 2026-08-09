/**
 * TASK-12: CLI 探测（架构 6.2 步骤 2 —— 逐个探测所选工具，缺失则提示）
 * 探测即跑 `<binary> --version`：exit 0 视为已安装，版本取首行输出。
 */
import { describe, expect, it } from "vitest";
import { detectClis, TOOL_BINARIES, type RunnerResultLike } from "../src/detect.js";

function fakeRunner(map: Record<string, Partial<RunnerResultLike>>) {
  const calls: Array<{ bin: string; args: string[] }> = [];
  const run = async (bin: string, args: string[]) => {
    calls.push({ bin, args });
    const r = map[bin];
    if (!r) throw new Error(`spawn ${bin} ENOENT`);
    return { exitCode: r.exitCode ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  return { run, calls };
}

describe("detectClis", () => {
  it("exit 0 + stdout 版本 → installed，版本取首行", async () => {
    const { run } = fakeRunner({ qodercli: { stdout: "qodercli v1.2.3\nbuild 99" } });
    const [r] = await detectClis(["qoder"], run);
    expect(r.tool).toBe("qoder");
    expect(r.binary).toBe("qodercli");
    expect(r.installed).toBe(true);
    expect(r.version).toBe("qodercli v1.2.3");
  });

  it("工具映射：kilo/opencode/claude/codex 各自对应正确二进制", async () => {
    const { run, calls } = fakeRunner({
      kilo: { stdout: "7.4.17" },
      opencode: { stdout: "1.0.0" },
      claude: { stdout: "2.0.0" },
      codex: { stdout: "0.5.0" },
    });
    await detectClis(["kilo", "opencode", "claude", "codex"], run);
    expect(calls.map((c) => c.bin)).toEqual(["kilo", "opencode", "claude", "codex"]);
    expect(calls.every((c) => c.args.includes("--version"))).toBe(true);
    expect(TOOL_BINARIES.qoder).toBe("qodercli");
  });

  it("二进制不存在（spawn 抛错）→ installed=false，不抛出", async () => {
    const { run } = fakeRunner({});
    const [r] = await detectClis(["codex"], run);
    expect(r.installed).toBe(false);
    expect(r.version).toBeUndefined();
  });

  it("exit 非 0 → installed=false", async () => {
    const { run } = fakeRunner({ kilo: { exitCode: 127 } });
    const [r] = await detectClis(["kilo"], run);
    expect(r.installed).toBe(false);
  });

  it("版本信息只在 stderr 时也能提取", async () => {
    const { run } = fakeRunner({ claude: { stdout: "", stderr: "claude 2.1.0" } });
    const [r] = await detectClis(["claude"], run);
    expect(r.installed).toBe(true);
    expect(r.version).toBe("claude 2.1.0");
  });

  it("未知工具名 → installed=false 且带原因，不影响其他工具", async () => {
    const { run } = fakeRunner({ kilo: { stdout: "7.4.17" } });
    const results = await detectClis(["nosuchtool", "kilo"], run);
    expect(results[0].installed).toBe(false);
    expect(results[0].reason).toContain("未知");
    expect(results[1].installed).toBe(true);
  });
});
