/**
 * TASK-30: OS 级隔离（架构 4.7 三层防线之隔离层，PLAN T26）
 *
 * 语义：readonly 回合期间对工作目录施加 OS 层只读（Windows icacls deny 写 /
 * Linux chmod a-w），参数层被绕过时仍物理禁写；.agentbus/ 排除（daemon 自身
 * 数据目录必须保持可写：sessions.json / logs）。
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyReadonly,
  planApplyReadonly,
  planRemoveReadonly,
  probeReadonly,
  removeReadonly,
  type IsolateStep,
} from "../src/isolate.js";

describe("planApplyReadonly：命令计划（纯函数）", () => {
  it("win32：icacls deny（OI/CI 继承传播）+ .agentbus 断继承后移除 deny；deny 不含 D/WDAC/WA", () => {
    const plan = planApplyReadonly("/proj", "alice", "win32");
    expect(plan.steps.length).toBe(3);
    const deny = plan.steps[0]!;
    expect(deny.cmd).toBe("icacls");
    expect(deny.args[0]).toBe("/proj");
    const denyAce = deny.args.find((a) => a.includes("alice:("));
    // 精确权限：WD 禁写数据/新建文件，AD 禁追加/新建子目录，DC 禁删子项。
    // 实测陷阱 1：不可含 D（DELETE）—— 真机矩阵证实 deny D 会把纯读连 native type
    // 都拒（读必须保持可用，readonly 回合要能读源码）。
    // 实测陷阱 2：不可用 W —— W 含 WA（FILE_WRITE_ATTRIBUTES），libuv 只读打开请求该位。
    // 不含 WDAC 才能事后 remove 解除。
    expect(denyAce).toContain("(OI)(CI)(WD,AD,DC)");
    expect(denyAce).not.toContain(",D,");
    // NTFS 陷阱：继承 ACE 无法 /remove:d —— .agentbus 先断继承转显式再移除 deny
    expect(plan.steps[1]!.args).toContain("/inheritance:d");
    expect(plan.steps[1]!.args[0]).toBe(join("/proj", ".agentbus"));
    const exclude = plan.steps[2]!;
    expect(exclude.args[0]).toBe(join("/proj", ".agentbus"));
    expect(exclude.args.some((a) => a.startsWith("/remove:d"))).toBe(true);
  });

  it("linux：chmod -R a-w 全树 + .agentbus u+w 恢复 daemon 写", () => {
    const plan = planApplyReadonly("/proj", "alice", "linux");
    expect(plan.steps[0]).toEqual({ cmd: "chmod", args: ["-R", "a-w", "/proj"] });
    expect(plan.steps[1]).toEqual({ cmd: "chmod", args: ["-R", "u+w", join("/proj", ".agentbus")] });
  });

  it("remove 计划与 apply 对称（win32 移除 deny + 恢复继承，linux 单步 u+w）", () => {
    const win = planRemoveReadonly("/proj", "alice", "win32");
    expect(win.steps.length).toBe(2);
    expect(win.steps[0]!.args.some((a) => a.startsWith("/remove:d"))).toBe(true);
    expect(win.steps[1]!.args).toContain("/inheritance:e");
    const linux = planRemoveReadonly("/proj", "alice", "linux");
    expect(linux.steps[0]).toEqual({ cmd: "chmod", args: ["-R", "u+w", "/proj"] });
  });
});

describe("applyReadonly / removeReadonly：执行与错误收敛", () => {
  it("按 plan 顺序逐步执行；某步失败即停且 ok=false 带 stderr", async () => {
    const calls: IsolateStep[] = [];
    const run = async (step: IsolateStep) => {
      calls.push(step);
      if (step.args.some((a) => a.includes("/remove:d"))) {
        return { exitCode: 1, stdout: "", stderr: "拒绝访问" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const report = await applyReadonly("/proj", { run, user: "alice", platform: "win32" });
    expect(calls.length).toBe(3);
    expect(report.ok).toBe(false);
    expect(report.lines.join()).toContain("拒绝访问");
  });

  it("全部步骤成功 → ok=true", async () => {
    const run = async () => ({ exitCode: 0, stdout: "", stderr: "" });
    const report = await applyReadonly("/proj", { run, user: "alice", platform: "win32" });
    expect(report.ok).toBe(true);
    const back = await removeReadonly("/proj", { run, user: "alice", platform: "win32" });
    expect(back.ok).toBe(true);
  });
});

describe("真机集成（仅 win32）：icacls deny 物理禁写 + 可解除", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "agentbus-isolate-"));
    mkdirSync(join(root, ".agentbus"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "readable.txt"), "可读");
  });

  afterEach(async () => {
    // 保险：异常路径下先解除隔离再删目录，避免 rmSync 失败留垃圾
    await removeReadonly(root);
    rmSync(root, { recursive: true, force: true });
  });

  const tryWrite = (dir: string, name: string) => {
    try {
      writeFileSync(join(dir, name), "x");
      return true;
    } catch {
      return false;
    }
  };

  it.skipIf(process.platform !== "win32")(
    "apply 后根目录与子目录写被拒、.agentbus 仍可写；remove 后全部恢复",
    async () => {
      expect(probeReadonly(root)).toBe(false);
      expect(tryWrite(root, "a.txt")).toBe(true);
      rmSync(join(root, "a.txt"));

      const applied = await applyReadonly(root);
      expect(applied.ok).toBe(true);
      expect(probeReadonly(root)).toBe(true);
      expect(tryWrite(join(root, "src"), "b.txt")).toBe(false); // 子目录同样被拒（继承传播）
      expect(tryWrite(join(root, ".agentbus"), "s.json")).toBe(true); // daemon 数据目录排除
      // 实测陷阱回归：deny 不得波及读（deny D/W 均会把读拒，矩阵已证）
      expect(readFileSync(join(root, "src", "readable.txt"), "utf-8")).toBe("可读");

      const removed = await removeReadonly(root);
      expect(removed.ok).toBe(true);
      expect(probeReadonly(root)).toBe(false);
      expect(tryWrite(join(root, "src"), "c.txt")).toBe(true);
    },
    30_000,
  );
});
