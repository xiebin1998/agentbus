#!/usr/bin/env node
/**
 * agentbus CLI 入口（架构 6.1）
 * TASK-04 骨架：命令注册 + 版本；各命令实现见后续任务卡
 *   init/uninstall → TASK-12/TASK-14；doctor/status → TASK-12；daemon → TASK-06
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { ConfigError, loadConfig } from "./config.js";
import { Daemon } from "./daemon/daemon.js";
import { isProcessAlive } from "./daemon/pid.js";

const pkg = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf-8"),
) as { version: string };

/** 工作目录解析：--config 指定 config.json 路径，默认 ./.agentbus/config.json */
function resolveWorkDir(configOpt?: string): string {
  return configOpt ? dirname(resolve(configOpt)) : resolve(".agentbus");
}

function loadOrExit(configOpt?: string) {
  const workDir = resolveWorkDir(configOpt);
  try {
    const config = loadConfig(join(workDir, "config.json"));
    return { config, workDir };
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(`配置错误: ${e.message}`);
    } else {
      console.error(`配置读取失败: ${(e as Error).message}`);
    }
    process.exit(1);
  }
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("agentbus")
    .description("AgentBus 客户端 —— 把本机 AI CLI 接入 MQTT Agent 总线")
    .version(pkg.version);

  program
    .command("init")
    .description("交互式初始化本项目接入（写 .agentbus/、注册 MCP、装 skill、拉起 daemon）")
    .option("--yes", "非交互模式，全部用默认值/命令行参数")
    .option("--client-id <id>", "本机总线身份（默认取目录名）")
    .option("--tools <tools...>", "要接入的工具列表")
    .option("--scope <scope>", "MCP 注册范围（project/user）")
    .action(() => {
      console.error("agentbus init 尚未实现（TASK-12）");
      process.exitCode = 1;
    });

  program
    .command("uninstall")
    .description("完整卸载本项目接入（停 daemon、移除 MCP 注册/skill/托管块）")
    .action(() => {
      console.error("agentbus uninstall 尚未实现（TASK-14）");
      process.exitCode = 1;
    });

  program
    .command("doctor")
    .description("环境体检：broker/SSE/CLI/MCP 注册/daemon 逐项检查")
    .action(() => {
      console.error("agentbus doctor 尚未实现（TASK-12）");
      process.exitCode = 1;
    });

  program
    .command("status")
    .description("查看 daemon 连接状态、sessions 摘要与各工具连通性")
    .action(() => {
      console.error("agentbus status 尚未实现（TASK-12）");
      process.exitCode = 1;
    });

  const daemon = program.command("daemon").description("daemon 生命周期管理");
  daemon
    .command("start")
    .description("启动 AgentBus Daemon（前台运行，Ctrl+C 退出）")
    .option("-c, --config <path>", "config.json 路径（默认 .agentbus/config.json）")
    .action((opts: { config?: string }) => {
      const { config, workDir } = loadOrExit(opts.config);
      if (!existsSync(workDir)) mkdirSync(workDir, { recursive: true });
      const d = new Daemon({ config, workDir });
      const result = d.start();
      if (!result.started) {
        console.error(result.reason);
        process.exit(1);
      }
      console.log(result.reason);
      console.log(`订阅 /phnix/ai/channel/${config.ns}/${config.client_id}/message（Ctrl+C 退出）`);
      const shutdown = () => {
        d.stop();
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    });
  daemon
    .command("stop")
    .description("停止 daemon（向 pid 发送 SIGTERM）")
    .option("-c, --config <path>", "config.json 路径（默认 .agentbus/config.json）")
    .action((opts: { config?: string }) => {
      const pidFile = join(resolveWorkDir(opts.config), "daemon.pid");
      let raw: string;
      try {
        raw = readFileSync(pidFile, "utf-8").trim();
      } catch {
        console.error("daemon 未在运行（无 daemon.pid）");
        process.exit(1);
        return;
      }
      const pid = Number.parseInt(raw, 10);
      if (!Number.isInteger(pid) || pid <= 0 || !isProcessAlive(pid)) {
        console.error(`daemon 未在运行（stale pid 文件: ${raw}），可直接 daemon start 接管`);
        process.exit(1);
        return;
      }
      try {
        process.kill(pid, "SIGTERM");
        console.log(`已发送 SIGTERM 给 pid ${pid}`);
      } catch (e) {
        console.error(`无法停止 pid ${pid}: ${(e as Error).message}`);
        process.exit(1);
      }
    });
  daemon
    .command("status")
    .description("查看 daemon 是否在运行（pid 检查，含 stale 判定）")
    .option("-c, --config <path>", "config.json 路径（默认 .agentbus/config.json）")
    .action((opts: { config?: string }) => {
      const pidFile = join(resolveWorkDir(opts.config), "daemon.pid");
      let raw: string;
      try {
        raw = readFileSync(pidFile, "utf-8").trim();
      } catch {
        console.log("daemon 未运行（无 daemon.pid）");
        process.exit(1);
        return;
      }
      const pid = Number.parseInt(raw, 10);
      if (Number.isInteger(pid) && pid > 0 && isProcessAlive(pid)) {
        console.log(`daemon 运行中（pid ${pid}）`);
      } else {
        console.log(`daemon 未运行（stale pid 文件: ${raw}）`);
        process.exit(1);
      }
    });

  return program;
}
