#!/usr/bin/env node
/**
 * agentbus CLI 入口（架构 6.1）
 * TASK-04 骨架：命令注册 + 版本；各命令实现见后续任务卡
 *   init/uninstall → TASK-12/TASK-14；doctor/status → TASK-12；daemon → TASK-06
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";

const pkg = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf-8"),
) as { version: string };

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
    .description("启动 AgentBus Daemon（前台运行）")
    .action(() => {
      console.error("agentbus daemon start 尚未实现（TASK-05/06）");
      process.exitCode = 1;
    });
  daemon
    .command("stop")
    .description("停止 daemon（优雅断开 MQTT）")
    .action(() => {
      console.error("agentbus daemon stop 尚未实现（TASK-06）");
      process.exitCode = 1;
    });
  daemon
    .command("status")
    .description("查看 daemon 是否在运行（pid 检查，含 stale 判定）")
    .action(() => {
      console.error("agentbus daemon status 尚未实现（TASK-06）");
      process.exitCode = 1;
    });

  return program;
}
