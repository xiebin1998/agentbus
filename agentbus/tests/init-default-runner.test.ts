/**
 * TASK-14 顺修：生产 CLI 入口不注入 runner 时，cli 型 MCP 注册必须走真实默认执行器
 * （此前 init 直接取 deps.runner，未注入时 cli 型注册恒失败 "no runner"）
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 拦截真实子进程：默认执行器最终落到 runCommand
vi.mock("../src/adapters/base.js", () => ({
  runCommand: vi.fn(async ({ args }: { args: string[] }) =>
    args.includes("--version")
      ? { exitCode: 0, stdout: "codex 1.0.0", stderr: "", error: undefined }
      : { exitCode: 0, stdout: "", stderr: "", error: undefined },
  ),
}));

// 在 vi.mock 之后导入，确保模块图使用假 runCommand
const { runInit } = await import("../src/init.js");

let root: string;
let home: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agentbus-dr-"));
  home = mkdtempSync(join(tmpdir(), "agentbus-drhome-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("runInit 未注入 runner 时的默认执行器回退", () => {
  it("codex（cli 型）注册不再报 no runner，走默认执行器成功", async () => {
    const report = await runInit(
      { yes: true, tools: ["codex"], scope: "project" },
      { projectRoot: root, homeDir: home, spawnDaemon: () => {} },
    );
    expect(report.lines.join("\n")).not.toContain("no runner");
    expect(report.ok).toBe(true);
    expect(report.lines.join("\n")).toContain("codex");
  });
});
