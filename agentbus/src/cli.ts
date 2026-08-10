#!/usr/bin/env node
/**
 * agentbus CLI 入口（架构 6.1）
 * TASK-12：init/doctor/status 落地；TASK-14：uninstall 落地；daemon → TASK-06
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkbox, input, select } from "@inquirer/prompts";
import { Command } from "commander";
import { ConfigError, loadConfig } from "./config.js";
import { runAutostartInstall, runAutostartStatus, runAutostartUninstall } from "./autostart.js";
import { Daemon } from "./daemon/daemon.js";
import { isProcessAlive } from "./daemon/pid.js";
import { killServePort, reclaimServePorts } from "./daemon/serve-manager.js";
import { detectClis, TOOL_BINARIES } from "./detect.js";
import { runDoctor } from "./doctor.js";
import { runInit, type Prompter } from "./init.js";
import { runIsolateApply, runIsolateRemove, runIsolateStatus } from "./isolate.js";
import type { McpScope } from "./mcp-registry.js";
import { readDaemonStatus, readSessionsSummary } from "./status.js";
import { runUninstall } from "./uninstall.js";

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

/** 交互问答器（架构 6.2 交互控件：checkbox/select/input） */
function makeInteractivePrompter(): Prompter {
  return async (key, defaultValue) => {
    switch (key) {
      case "ns":
        return input({ message: "命名空间 ns（团队/环境）", default: String(defaultValue) });
      case "clientId":
        return input({ message: `client_id（默认: ${defaultValue}）`, default: String(defaultValue) });
      case "tools": {
        const detected = await detectClis(Object.keys(TOOL_BINARIES));
        return checkbox({
          message: "要接入的工具（空格勾选，回车确认）",
          choices: detected.map((d) => ({
            name: `${d.tool.padEnd(10)} ${d.installed ? `✓ 已探测到 ${d.binary}（${d.version}）` : `✗ ${d.reason}`}`,
            value: d.tool,
            checked: d.installed,
          })),
        });
      }
      case "scope":
        return select({
          message: "MCP 配置范围",
          choices: [
            { name: "project  写项目配置，可提交 git（推荐）", value: "project" },
            { name: "global   写用户全局配置", value: "global" },
          ],
          default: String(defaultValue),
        });
      case "broker":
        return input({ message: "Broker 地址（中心节点 host:port）", default: String(defaultValue) });
      case "sseUrl": {
        const v = await input({ message: "MCP Server SSE URL（回车自动派生）", default: "" });
        return v;
      }
      default:
        return defaultValue;
    }
  };
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
    .option("--scope <scope>", "MCP 注册范围（project/global）")
    .option("--ns <ns>", "命名空间（默认 default）")
    .option("--broker <host:port>", "Broker 地址（默认 localhost:18830）")
    .option("--sse-url <url>", "MCP Server SSE URL（默认按 broker host 派生）")
    .action(async (opts: { yes?: boolean; clientId?: string; tools?: string[]; scope?: string; ns?: string; broker?: string; sseUrl?: string }) => {
      const projectRoot = process.cwd();
      const scope = (opts.scope ?? "project") as McpScope;
      const report = await runInit(
        {
          yes: opts.yes,
          clientId: opts.clientId,
          tools: opts.tools,
          scope,
          ns: opts.ns,
          broker: opts.broker,
          sseUrl: opts.sseUrl,
        },
        {
          projectRoot,
          homeDir: process.env.USERPROFILE ?? process.env.HOME ?? "",
          prompter: opts.yes ? undefined : makeInteractivePrompter(),
        },
      );
      for (const line of report.lines) console.log(line);
      if (!report.ok) process.exit(1);
    });

  program
    .command("uninstall")
    .description("完整卸载本项目接入（停 daemon、移除 MCP 注册/skill/托管块、清 .agentbus/）")
    .option("--yes", "非交互模式，直接执行")
    .action(async (opts: { yes?: boolean }) => {
      if (!opts.yes) {
        const { confirm } = await import("@inquirer/prompts");
        const go = await confirm({
          message: "将移除本项目的 AgentBus 接入（MCP 注册/skill/.agentbus/），继续？",
          default: false,
        });
        if (!go) {
          console.log("已取消");
          return;
        }
      }
      const report = await runUninstall({
        projectRoot: process.cwd(),
        homeDir: process.env.USERPROFILE ?? process.env.HOME ?? "",
      });
      for (const line of report.lines) console.log(line);
      if (!report.ok) process.exit(1);
    });

  program
    .command("doctor")
    .description("环境体检：配置/broker/SSE/CLI/MCP 注册/daemon 逐项检查")
    .option("-c, --config <path>", "config.json 路径（默认 .agentbus/config.json）")
    .action(async (opts: { config?: string }) => {
      const workDir = resolveWorkDir(opts.config);
      const projectRoot = dirname(workDir);
      const report = await runDoctor({
        workDir,
        projectRoot,
        homeDir: process.env.USERPROFILE ?? process.env.HOME ?? "",
      });
      for (const c of report.checks) {
        console.log(`${c.ok ? "✓" : "✗"} ${c.name}：${c.detail}`);
      }
      console.log(report.ok ? "体检通过" : "体检未通过，请按上述提示修复");
      if (!report.ok) process.exit(1);
    });

  program
    .command("status")
    .description("查看 daemon 连接状态、sessions 摘要与各工具连通性")
    .option("-c, --config <path>", "config.json 路径（默认 .agentbus/config.json）")
    .action((opts: { config?: string }) => {
      const workDir = resolveWorkDir(opts.config);
      const status = readDaemonStatus(workDir);
      if (status.running) {
        console.log(`daemon 运行中（pid ${status.pid}）`);
      } else if (status.stale) {
        console.log("daemon 未运行（stale pid 文件，可 agentbus daemon start 接管）");
      } else {
        console.log("daemon 未运行（无 daemon.pid）");
      }
      const summary = readSessionsSummary(workDir);
      console.log(`会话注册表：${summary.senderCount} 个来源${summary.senders.length ? `（${summary.senders.join(", ")}）` : ""}`);
      try {
        const config = loadConfig(join(workDir, "config.json"));
        console.log(`身份 ${config.ns}/${config.client_id}，订阅 /agenthub/ai/channel/${config.ns}/${config.client_id}/message`);
        console.log(`离线丢消息声明：broker 持久会话容量有限，daemon 长时间离线期间的消息可能丢失`);
      } catch {
        console.log("（config.json 未初始化，先跑 agentbus init）");
      }
      if (!status.running) process.exit(1);
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
      console.log(`订阅 /agenthub/ai/channel/${config.ns}/${config.client_id}/message（Ctrl+C 退出）`);
      const shutdown = () => {
        // stop 异步：等 MQTT 关闭完成再退，避免关闭日志丢失
        void d.stop().finally(() => process.exit(0));
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
      // Windows 实测 SIGTERM 为强杀（handler 不运行，serve 优雅回收不会执行）→ 按 config 端口定向回收孤儿 serve
      if (process.platform === "win32") {
        try {
          const cfg = loadConfig(join(resolveWorkDir(opts.config), "config.json"));
          reclaimServePorts(cfg.tools, (port) => killServePort(port, { warn: (m) => console.warn(m) }));
        } catch {
          /* config 不可读时跳过回收，不影响 stop 本身 */
        }
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

  // TASK-23：开机自启（架构 4.5 三期：Windows HKCU Run / Linux systemd 用户单元）
  const autostart = program.command("autostart").description("开机自启管理（登录时自动拉起 daemon）");
  const autostartSpec = (opts: { config?: string }) => {
    const workDir = resolveWorkDir(opts.config);
    const { config } = loadOrExit(opts.config);
    return {
      platform: (process.platform === "win32" ? "win32" : "linux") as "win32" | "linux",
      projectRoot: dirname(workDir),
      binPath: join(dirname(fileURLToPath(import.meta.url)), "bin.js"),
      configPath: join(workDir, "config.json"),
      clientId: config.client_id,
      ns: config.ns,
      nodePath: process.execPath,
      homeDir: process.env.HOME ?? process.env.USERPROFILE ?? "",
    };
  };
  autostart
    .command("install")
    .description("注册开机自启（Windows 计划任务 ONLOGON / Linux systemd --user，幂等覆盖）")
    .option("-c, --config <path>", "config.json 路径（默认 .agentbus/config.json）")
    .action(async (opts: { config?: string }) => {
      const report = await runAutostartInstall(autostartSpec(opts));
      for (const line of report.lines) console.log(line);
      if (!report.ok) process.exit(1);
    });
  autostart
    .command("uninstall")
    .description("移除开机自启注册")
    .option("-c, --config <path>", "config.json 路径（默认 .agentbus/config.json）")
    .action(async (opts: { config?: string }) => {
      const report = await runAutostartUninstall(autostartSpec(opts));
      for (const line of report.lines) console.log(line);
      if (!report.ok) process.exit(1);
    });
  autostart
    .command("status")
    .description("查看开机自启是否已注册")
    .option("-c, --config <path>", "config.json 路径（默认 .agentbus/config.json）")
    .action(async (opts: { config?: string }) => {
      const s = await runAutostartStatus(autostartSpec(opts));
      console.log(`${s.registered ? "✓" : "✗"} ${s.detail}`);
      if (!s.registered) process.exit(1);
    });

  // TASK-30：OS 级隔离（架构 4.7 三层防线之隔离层，手动锁/解锁入口）
  const isolate = program
    .command("isolate")
    .description("工作目录 OS 级只读隔离（readonly 回合物理禁写的手动入口与恢复手段）");
  isolate
    .command("apply")
    .description("对工作目录施加只读隔离（Windows icacls deny 写 / Linux chmod a-w，幂等）")
    .option("-c, --config <path>", "config.json 路径（默认 .agentbus/config.json）")
    .action(async (opts: { config?: string }) => {
      const report = await runIsolateApply(dirname(resolveWorkDir(opts.config)));
      for (const line of report.lines) console.log(line);
      if (!report.ok) process.exit(1);
    });
  isolate
    .command("remove")
    .description("解除只读隔离（daemon 被强杀残留时的解锁出口，幂等）")
    .option("-c, --config <path>", "config.json 路径（默认 .agentbus/config.json）")
    .action(async (opts: { config?: string }) => {
      const report = await runIsolateRemove(dirname(resolveWorkDir(opts.config)));
      for (const line of report.lines) console.log(line);
      if (!report.ok) process.exit(1);
    });
  isolate
    .command("status")
    .description("查询工作目录当前隔离状态")
    .option("-c, --config <path>", "config.json 路径（默认 .agentbus/config.json）")
    .action(async (opts: { config?: string }) => {
      const report = await runIsolateStatus(dirname(resolveWorkDir(opts.config)));
      for (const line of report.lines) console.log(line);
    });

  return program;
}
