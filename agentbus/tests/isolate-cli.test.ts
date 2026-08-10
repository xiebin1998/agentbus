/**
 * TASK-30: agentbus isolate 子命令（apply/remove/status，架构 4.7 隔离层手动入口）
 *
 * 用途：手动锁/解锁工作目录 OS 级只读（daemon 自动隔离的兜底恢复手段：
 * daemon 被强杀可能残留隔离态，isolate remove 是解锁出口）。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildProgram } from "../src/cli.js";
import { runIsolateApply, runIsolateRemove, runIsolateStatus } from "../src/isolate.js";

describe("isolate 命令注册", () => {
  it("agentbus isolate apply|remove|status 三子命令就位", () => {
    const program = buildProgram();
    const isolate = program.commands.find((c) => c.name() === "isolate");
    expect(isolate).toBeDefined();
    const subs = isolate!.commands.map((c) => c.name()).sort();
    expect(subs).toEqual(["apply", "remove", "status"]);
  });
});

describe.skipIf(process.platform !== "win32")("runIsolate* 真机：apply → status → remove 闭环", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "agentbus-cli-iso-"));
    mkdirSync(join(root, ".agentbus"), { recursive: true });
  });

  afterEach(async () => {
    await runIsolateRemove(root);
    rmSync(root, { recursive: true, force: true });
  });

  it("apply 施加只读；status 如实反映隔离态；remove 解锁", async () => {
    const applied = await runIsolateApply(root);
    expect(applied.ok).toBe(true);
    // 隔离期间写被拒（物理禁写证据）
    expect(() => writeFileSync(join(root, "x.txt"), "x")).toThrow();

    const mid = await runIsolateStatus(root);
    expect(mid.ok).toBe(true);
    expect(mid.lines.join()).toContain("只读隔离中");

    const removed = await runIsolateRemove(root);
    expect(removed.ok).toBe(true);
    writeFileSync(join(root, "y.txt"), "y"); // 解锁后恢复可写

    const back = await runIsolateStatus(root);
    expect(back.lines.join()).toContain("未处于");
  }, 30_000);

  it("status 在 .agentbus 可写但工作区被锁时给出残留提示（daemon 强杀场景）", async () => {
    const applied = await runIsolateApply(root);
    expect(applied.ok).toBe(true);
    const s = await runIsolateStatus(root);
    expect(s.lines.join()).toContain("isolate remove");
  }, 30_000);
});
