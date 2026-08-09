/**
 * TASK-12: init 编排（架构 6.2 五步流程）
 *
 *   步骤 1 交互确认（--yes 时用默认值/传参值）
 *   步骤 2 探测 CLI（缺失不带病推进：全部未安装直接失败）
 *   步骤 3 写配置与契约（.agentbus/ 骨架 + Skill/AGENTS.md 兜底块）
 *   步骤 4 注册 MCP（见 mcp-registry 七红线）
 *   步骤 5 拉起守护进程（detached spawn daemon start）
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { detectClis, defaultCliRunner, type CliRunner } from "./detect.js";
import { planMcpRegistration, registerMcpFile, type McpScope } from "./mcp-registry.js";
import { installSkill, SKILL_DIRS } from "./skill.js";
import { AGENTBUS_BLOCK, upsertAgentsMdBlock } from "./agents-md.js";

export interface InitCliOptions {
  yes?: boolean;
  clientId?: string;
  tools?: string[];
  scope?: McpScope;
  ns?: string;
  /** "host:port"，默认 localhost:18830 */
  broker?: string;
  /** 显式 SSE URL；缺省按 broker host 派生 */
  sseUrl?: string;
}

export interface InitReport {
  ok: boolean;
  lines: string[];
}

/** 交互问答注入点：key ∈ ns/clientId/tools/scope/broker/sseUrl（生产实现走 @inquirer/prompts） */
export type Prompter = (key: string, defaultValue: unknown) => Promise<unknown>;

export interface InitDeps {
  projectRoot: string;
  homeDir: string;
  runner?: CliRunner;
  spawnDaemon?: (cmd: string, args: string[]) => void;
  prompter?: Prompter;
}

export interface RawInitConfig {
  client_id: string;
  ns: string;
  broker: { host: string; port: number };
  sse_url: string;
  default_tool: string;
  allowed_senders: string[];
  tools: Record<string, Record<string, unknown>>;
  ack: boolean;
  inbound_mode: "readonly";
}

/** 解析 "host:port"；非法即抛错（init 是唯一入口，必须当场拦下） */
export function parseBroker(input: string): { host: string; port: number } {
  const idx = input.lastIndexOf(":");
  if (idx <= 0 || idx === input.length - 1) {
    throw new Error(`broker 格式必须是 host:port（收到 "${input}"）`);
  }
  const host = input.slice(0, idx);
  const port = Number.parseInt(input.slice(idx + 1), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`broker 端口非法（收到 "${input}"）`);
  }
  return { host, port };
}

/** 由默认值/传参生成 config.json 原始对象（纯函数，不碰磁盘） */
export function buildInitConfig(
  opts: Pick<InitCliOptions, "tools" | "ns" | "clientId" | "broker" | "sseUrl">,
  projectRoot: string,
): RawInitConfig {
  const tools = opts.tools ?? [];
  if (tools.length === 0) {
    throw new Error("未选择任何工具（至少接入一个 AI CLI）");
  }
  const client_id = opts.clientId?.trim() || basename(projectRoot);
  const ns = opts.ns?.trim() || "default";
  const broker = parseBroker(opts.broker?.trim() || "localhost:18830");
  const sse_url =
    opts.sseUrl?.trim() || `http://${broker.host}:8000/sse?client_id=${client_id}&ns=${ns}`;
  const toolCfg: Record<string, Record<string, unknown>> = {};
  for (const t of tools) toolCfg[t] = {};
  return {
    client_id,
    ns,
    broker,
    sse_url,
    default_tool: tools[0],
    allowed_senders: [],
    tools: toolCfg,
    ack: true,
    inbound_mode: "readonly",
  };
}

const defaultSpawnDaemon = (cmd: string, args: string[]) => {
  spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
};

/** 五步编排；任何一步失败立即收敛进报告（ok=false），不带病推进 */
export async function runInit(opts: InitCliOptions, deps: InitDeps): Promise<InitReport> {
  const lines: string[] = [];
  const { projectRoot, homeDir } = deps;

  // 步骤 1：交互确认（--yes 全部取默认/传参）
  let answers: Required<Pick<InitCliOptions, "tools" | "scope" | "ns" | "broker" | "sseUrl">> & { clientId: string };
  if (opts.yes) {
    answers = {
      ns: opts.ns ?? "default",
      clientId: opts.clientId ?? "",
      tools: opts.tools ?? [],
      scope: opts.scope ?? "project",
      broker: opts.broker ?? "localhost:18830",
      sseUrl: opts.sseUrl ?? "",
    };
  } else {
    const prompter = deps.prompter;
    if (!prompter) {
      return { ok: false, lines: ["非 --yes 模式需要交互问答器（终端环境请走 CLI 入口）"] };
    }
    answers = {
      ns: String(await prompter("ns", opts.ns ?? "default")),
      clientId: String(await prompter("clientId", opts.clientId ?? basename(projectRoot))),
      tools: (await prompter("tools", opts.tools ?? [])) as string[],
      scope: (await prompter("scope", opts.scope ?? "project")) as McpScope,
      broker: String(await prompter("broker", opts.broker ?? "localhost:18830")),
      sseUrl: String(await prompter("sseUrl", opts.sseUrl ?? "")),
    };
  }

  let raw: RawInitConfig;
  try {
    raw = buildInitConfig(answers, projectRoot);
  } catch (e) {
    return { ok: false, lines: [`✗ ${(e as Error).message}`] };
  }

  // 步骤 2：探测 CLI
  const detected = await detectClis(Object.keys(raw.tools), deps.runner);
  const installed = detected.filter((d) => d.installed);
  for (const d of detected) {
    lines.push(d.installed ? `✓ 探测到 CLI: ${d.binary}（${d.version}）` : `✗ ${d.binary} 未安装：${d.reason}`);
  }
  if (installed.length === 0) {
    lines.push("所选工具全部未安装，请先安装后重试（不写入任何配置）");
    return { ok: false, lines };
  }

  // 步骤 3：写配置与契约
  const agentbusDir = join(projectRoot, ".agentbus");
  mkdirSync(join(agentbusDir, "logs"), { recursive: true });
  mkdirSync(join(agentbusDir, "inbox"), { recursive: true });
  const configPath = join(agentbusDir, "config.json");
  writeFileSync(configPath, `${JSON.stringify(raw, null, 2)}\n`, "utf-8");
  lines.push(`✓ 已写入 .agentbus/config.json（身份 ${raw.ns}/${raw.client_id}）`);

  let needAgentsMd = false;
  for (const tool of Object.keys(raw.tools)) {
    if (tool in SKILL_DIRS) {
      const r = installSkill(projectRoot, tool);
      lines.push(`✓ 已安装 ${tool} skill: ${r.path}`);
    } else {
      needAgentsMd = true;
    }
  }
  if (needAgentsMd) {
    const mdPath = join(projectRoot, "AGENTS.md");
    const existing = existsSync(mdPath) ? readFileSync(mdPath, "utf-8") : "";
    writeFileSync(mdPath, upsertAgentsMdBlock(existing, AGENTBUS_BLOCK), "utf-8");
    lines.push("✓ 已写入 AGENTS.md 托管块（不支持 skill 的工具兜底）");
  }

  // 步骤 4：注册 MCP（七红线见 mcp-registry.ts）
  for (const tool of Object.keys(raw.tools)) {
    const plan = planMcpRegistration(tool, answers.scope, raw.sse_url, projectRoot, homeDir);
    for (const w of plan.warnings) lines.push(`⚠ ${w}`);
    if (plan.method === "file") {
      try {
        const r = registerMcpFile(plan);
        lines.push(r.verified ? `✓ 已注册 MCP: ${tool}（${plan.path}，回写验证通过）` : `✗ ${tool} 注册回写验证失败（${plan.path}）`);
        if (!r.verified) return { ok: false, lines };
      } catch (e) {
        lines.push(`✗ ${tool} 注册失败：${(e as Error).message}`);
        return { ok: false, lines };
      }
    } else if (plan.method === "cli") {
      // 生产 CLI 入口不注入 runner，回退默认执行器（否则 cli 型注册恒失败）
      const runner = deps.runner ?? defaultCliRunner;
      let r;
      try {
        r = await runner(plan.binary!, plan.cliArgs!);
      } catch (e) {
        r = { exitCode: 1, stdout: "", stderr: (e as Error).message };
      }
      if (r.exitCode === 0) {
        lines.push(`✓ 已注册 MCP: ${plan.binary} ${plan.cliArgs!.join(" ")}`);
      } else {
        lines.push(`✗ ${plan.binary} mcp 注册失败（退出码 ${r.exitCode}）`);
        return { ok: false, lines };
      }
    }
  }

  // 步骤 5：拉起守护进程
  const spawnDaemon = deps.spawnDaemon ?? defaultSpawnDaemon;
  const binPath = join(dirname(fileURLToPath(import.meta.url)), "bin.js");
  spawnDaemon(process.execPath, [binPath, "daemon", "start", "-c", configPath]);
  lines.push(`✓ 守护进程已拉起（日志: .agentbus/logs/daemon.log）`);

  lines.push(`完成！本项目已以身份 "${raw.ns}/${raw.client_id}" 接入 MQTT 总线。`);
  return { ok: true, lines };
}
