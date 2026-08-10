/**
 * TASK-30: OS 级隔离（架构 4.7 三层防线之隔离层，PLAN T26）
 *
 * readonly 回合期间对工作目录施加 OS 层只读——参数层（CLI 只读模式）被绕过时
 * 仍物理禁写：
 * - Windows：icacls 递归 deny 当前用户的写/删权限（不含 WDAC，保证可解除）
 * - Linux：chmod -R a-w（低权限账号运行为进阶方案，见 TASKS.md 待补）
 *
 * .agentbus/ 排除：daemon 自身数据目录（sessions.json / logs）必须保持可写。
 */
import { spawnSync } from "node:child_process";
import { unlinkSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export interface IsolateStep {
  cmd: string;
  args: string[];
}

export interface IsolatePlan {
  steps: IsolateStep[];
}

export interface IsolateReport {
  ok: boolean;
  lines: string[];
}

export interface IsolateOptions {
  /** deny 目标用户（默认当前登录用户——CLI 子进程继承同一身份） */
  user?: string;
  platform?: NodeJS.Platform;
  /** 步骤执行器（测试注入；缺省 spawnSync） */
  run?: (step: IsolateStep) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

/**
 * deny 写数据/新建：WD（写数据/新建文件）、AD（追加/新建子目录）、DC（禁删子项）。
 * 真机权限矩阵勘误（两个陷阱均实测复现）：
 * 1) 不可含 D（DELETE）—— deny D 会把纯读连 native type 都拒（访问检查特性），
 *    readonly 回合必须保持可读；副作用：对既有文件的删除/重命名不被拦截。
 * 2) 不可用 W —— W 含 WA（FILE_WRITE_ATTRIBUTES），libuv 只读打开请求该位。
 * 不含 WDAC 才能事后 remove 解除。(OI)(CI) 只设根目录，继承自动传播全树；
 * .agentbus 需先断继承（NTFS 陷阱：继承 ACE 无法 /remove:d，必须先
 * /inheritance:d 转显式再移除）。
 */
export function planApplyReadonly(workspace: string, user: string, platform: NodeJS.Platform): IsolatePlan {
  const agentbusDir = join(workspace, ".agentbus");
  if (platform === "win32") {
    return {
      steps: [
        { cmd: "icacls", args: [workspace, "/deny", `${user}:(OI)(CI)(WD,AD,DC)`] },
        { cmd: "icacls", args: [agentbusDir, "/inheritance:d"] },
        // daemon 数据目录排除：移除转显式后的 deny，恢复 daemon 自身写
        { cmd: "icacls", args: [agentbusDir, "/remove:d", user, "/T", "/C", "/Q"] },
      ],
    };
  }
  return {
    steps: [
      { cmd: "chmod", args: ["-R", "a-w", workspace] },
      { cmd: "chmod", args: ["-R", "u+w", agentbusDir] },
    ],
  };
}

/** 与 apply 对称的解除计划（win32：移根 deny 后后代继承自动失效 + 恢复 .agentbus 继承） */
export function planRemoveReadonly(workspace: string, user: string, platform: NodeJS.Platform): IsolatePlan {
  if (platform === "win32") {
    return {
      steps: [
        // /T 递归：apply 半途失败可能在后代留下显式 deny，一并清理
        { cmd: "icacls", args: [workspace, "/remove:d", user, "/T", "/C", "/Q"] },
        { cmd: "icacls", args: [join(workspace, ".agentbus"), "/inheritance:e"] },
      ],
    };
  }
  return { steps: [{ cmd: "chmod", args: ["-R", "u+w", workspace] }] };
}

const defaultRun = async (step: IsolateStep) => {
  const r = spawnSync(step.cmd, step.args, { encoding: "utf-8", windowsHide: true, timeout: 120_000 });
  return { exitCode: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

async function runPlan(plan: IsolatePlan, opts?: IsolateOptions): Promise<IsolateReport> {
  const run = opts?.run ?? defaultRun;
  const lines: string[] = [];
  for (const step of plan.steps) {
    const r = await run(step);
    if (r.exitCode !== 0) {
      const tail = r.stderr.trim().split(/\r?\n/).slice(-3).join("；");
      lines.push(`${step.cmd} 失败（exit ${r.exitCode}）：${tail || "无错误输出"}`);
      return { ok: false, lines };
    }
  }
  return { ok: true, lines };
}

function defaults(opts?: IsolateOptions): { user: string; platform: NodeJS.Platform } {
  return {
    user: opts?.user ?? userInfo().username,
    platform: opts?.platform ?? process.platform,
  };
}

/** 施加只读隔离；某步失败即停（已施加的部分保留，removeReadonly 可恢复） */
export function applyReadonly(workspace: string, opts?: IsolateOptions): Promise<IsolateReport> {
  const { user, platform } = defaults(opts);
  return runPlan(planApplyReadonly(workspace, user, platform), opts);
}

/** 解除只读隔离（幂等：未施加过也成功） */
export function removeReadonly(workspace: string, opts?: IsolateOptions): Promise<IsolateReport> {
  const { user, platform } = defaults(opts);
  return runPlan(planRemoveReadonly(workspace, user, platform), opts);
}

/** 探针检测：目录当前是否处于只读隔离（试写临时文件，失败即隔离中） */
export function probeReadonly(workspace: string): boolean {
  const probe = join(workspace, `.agentbus-isolate-probe-${randomUUID()}`);
  try {
    writeFileSync(probe, "probe");
    unlinkSync(probe);
    return false;
  } catch {
    return true;
  }
}

/** CLI 入口：施加只读隔离（幂等：已隔离时直接返回） */
export async function runIsolateApply(workspace: string): Promise<IsolateReport> {
  if (probeReadonly(workspace)) {
    return { ok: true, lines: ["已处于只读隔离，无需重复施加"] };
  }
  const r = await applyReadonly(workspace);
  return { ok: r.ok, lines: r.ok ? ["已施加只读隔离（agentbus isolate remove 解锁）"] : r.lines };
}

/** CLI 入口：解除只读隔离（幂等） */
export async function runIsolateRemove(workspace: string): Promise<IsolateReport> {
  const r = await removeReadonly(workspace);
  return { ok: r.ok, lines: r.ok ? ["已解除只读隔离"] : r.lines };
}

/** CLI 入口：查询隔离状态（ok 恒 true，仅报告；隔离中时附解锁提示） */
export async function runIsolateStatus(workspace: string): Promise<IsolateReport> {
  if (probeReadonly(workspace)) {
    return { ok: true, lines: ["只读隔离中（工作目录禁写；若为 daemon 残留请 agentbus isolate remove 解锁）"] };
  }
  return { ok: true, lines: ["未处于只读隔离（工作目录可写）"] };
}
