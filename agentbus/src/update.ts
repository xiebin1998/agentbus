/**
 * agentbus update —— 客户端一键更新（npm 升级 → 停旧 daemon → 提示拉起）
 *
 * 为什么不重跑 iwr 安装脚本：其内部 init --yes 会无条件重写 config.json
 * （broker/凭证/ns 被重置为默认），升级必须绕开 init。
 * 更新只动两处：npm 全局包、运行中的 daemon 进程；配置/MCP 注册/skill 不受影响。
 * 包来源与 install.ps1 同一机制：AGENTBUS_PACKAGE 可指本地目录/tarball（离线）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isProcessAlive } from "./daemon/pid.js";

export const DEFAULT_UPDATE_SOURCE = "@xiebin1998/agentbus@latest";

export interface UpdatePlan {
  steps: { cmd: string; args: string[] }[];
}

/** 升级包来源：AGENTBUS_PACKAGE 优先（离线环境），默认 npm registry latest */
export function resolveUpdateSource(env: Record<string, string | undefined>): string {
  return env.AGENTBUS_PACKAGE || DEFAULT_UPDATE_SOURCE;
}

/** 升级步骤计划（纯函数，不落盘不执行） */
export function planUpgrade(pkg: string): UpdatePlan {
  return { steps: [{ cmd: "npm", args: ["install", "-g", pkg] }] };
}

/** daemon 运行判定：与 daemon stop/status 同口径（pid 文件 + 活进程，stale 判未运行） */
export function isDaemonRunning(workDir: string): { running: boolean; pid?: number } {
  let raw: string;
  try {
    raw = readFileSync(join(workDir, "daemon.pid"), "utf-8").trim();
  } catch {
    return { running: false };
  }
  const pid = Number.parseInt(raw, 10);
  if (!Number.isInteger(pid) || pid <= 0 || !isProcessAlive(pid)) return { running: false };
  return { running: true, pid };
}
