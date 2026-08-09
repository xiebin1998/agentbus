/**
 * TASK-14: uninstall 全链路（架构 6.1：移除本项目的 MCP 注册与守护进程）
 *
 * 与 init 严格互逆：停 daemon → 移除 MCP 注册（红线 1：只删 agentbus 键）
 * → 删 skill/AGENTS.md 托管块 → 清 .agentbus/。全程幂等，目标缺失只提示不报错。
 * DoD：卸载后 doctor 零残留（config 不存在 → "未初始化"）。
 */
import { existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isProcessAlive } from "./daemon/pid.js";
import { defaultCliRunner, type CliRunner } from "./detect.js";
import { cliRemoveArgs, MCP_NAME, planMcpUninstall, removeMcpJsonEntry } from "./mcp-registry.js";
import { SKILL_DIRS, uninstallSkill } from "./skill.js";
import { removeAgentsMdBlock } from "./agents-md.js";

export interface UninstallDeps {
  projectRoot: string;
  homeDir: string;
  runner?: CliRunner;
  /** 停 daemon 注入点（测试用）；返回是否成功停止 */
  stopDaemon?: (pid: number) => boolean;
}

export interface UninstallReport {
  ok: boolean;
  lines: string[];
}

/** 同步短睡（不引入 async，保持 stopDaemon 签名简洁） */
function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 默认停 daemon：SIGTERM 后最多等 3s 退出 */
function defaultStopDaemon(pid: number): boolean {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return !isProcessAlive(pid);
  }
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    sleepMs(100);
  }
  return !isProcessAlive(pid);
}

export async function runUninstall(deps: UninstallDeps): Promise<UninstallReport> {
  const lines: string[] = [];
  const { projectRoot, homeDir } = deps;
  const configPath = join(projectRoot, ".agentbus", "config.json");

  if (!existsSync(configPath)) {
    lines.push("项目未初始化（无 .agentbus/config.json），无需卸载");
    return { ok: true, lines };
  }

  let ok = true;

  // 步骤 0：读配置拿工具清单（损坏时降级为空清单，后续清理照常进行）
  let tools: string[] = [];
  try {
    const cfg = JSON.parse(readFileSync(configPath, "utf-8")) as { tools?: Record<string, unknown> };
    tools = Object.keys(cfg.tools ?? {});
  } catch (e) {
    lines.push(`⚠ config.json 解析失败（${(e as Error).message}），按空工具清单继续清理`);
  }

  // 步骤 1：停 daemon（无 pid/已退出均视为完成）
  const pidFile = join(projectRoot, ".agentbus", "daemon.pid");
  if (existsSync(pidFile)) {
    const pid = Number.parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
    if (Number.isInteger(pid) && pid > 0 && isProcessAlive(pid)) {
      const stopDaemon = deps.stopDaemon ?? defaultStopDaemon;
      if (stopDaemon(pid)) {
        lines.push(`✓ daemon 已停止（pid ${pid}）`);
      } else {
        lines.push(`✗ daemon（pid ${pid}）停止失败，请手动处理后重试`);
        ok = false;
      }
    } else {
      lines.push("✓ daemon 未在运行（stale pid 文件，跳过停止）");
    }
  } else {
    lines.push("✓ daemon 未在运行（无 daemon.pid）");
  }

  // 步骤 2：移除 MCP 注册（红线 1：file 型只删 agentbus 键；cli 型尽力 mcp remove）
  const runner = deps.runner ?? defaultCliRunner;
  for (const tool of tools) {
    const target = planMcpUninstall(tool, projectRoot, homeDir);
    for (const f of target.files) {
      if (!existsSync(f.path)) continue;
      try {
        const updated = removeMcpJsonEntry(readFileSync(f.path, "utf-8"), f.sectionKey, MCP_NAME);
        if (updated === null) {
          lines.push(`✓ ${tool}: ${f.path} 无 agentbus 注册（跳过）`);
        } else {
          writeFileSync(f.path, updated, "utf-8");
          lines.push(`✓ ${tool}: 已从 ${f.path} 移除 agentbus 注册（其余条目保留）`);
        }
      } catch (e) {
        lines.push(`✗ ${tool}: 移除 ${f.path} 中的注册失败：${(e as Error).message}`);
        ok = false;
      }
    }
    if (target.cliBinary) {
      try {
        const r = await runner(target.cliBinary, cliRemoveArgs());
        if (r.exitCode === 0) {
          lines.push(`✓ ${tool}: ${target.cliBinary} ${cliRemoveArgs().join(" ")} 执行成功`);
        } else {
          lines.push(`⚠ ${tool}: ${target.cliBinary} mcp remove 退出码 ${r.exitCode}（全局注册可能本就不存在，继续）`);
        }
      } catch {
        lines.push(`⚠ ${tool}: ${target.cliBinary} 不可用，跳过 CLI 全局移除（若曾全局注册请手动清理）`);
      }
    }
  }

  // 步骤 3：删 skill 与 AGENTS.md 托管块（块外用户内容无损）
  for (const tool of tools) {
    if (tool in SKILL_DIRS) {
      const r = uninstallSkill(projectRoot, tool);
      lines.push(r.changed ? `✓ 已移除 ${tool} skill` : `✓ ${tool} skill 不存在（跳过）`);
    }
  }
  const mdPath = join(projectRoot, "AGENTS.md");
  if (existsSync(mdPath)) {
    const original = readFileSync(mdPath, "utf-8");
    const updated = removeAgentsMdBlock(original);
    if (updated !== original) {
      if (updated === "") {
        unlinkSync(mdPath);
        lines.push("✓ 已移除 AGENTS.md（仅含 agentbus 托管块）");
      } else {
        writeFileSync(mdPath, updated, "utf-8");
        lines.push("✓ 已移除 AGENTS.md 托管块（块外内容保留）");
      }
    }
  }

  // 步骤 4：清 .agentbus/（doctor 零残留的前提）
  rmSync(join(projectRoot, ".agentbus"), { recursive: true, force: true });
  lines.push("✓ 已删除 .agentbus/（config/日志/会话注册表）");

  lines.push(ok ? "卸载完成：本项目已退出 AgentBus 总线" : "卸载完成，但存在失败项，请按上方 ✗ 提示处理");
  return { ok, lines };
}
