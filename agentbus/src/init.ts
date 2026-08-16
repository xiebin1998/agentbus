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
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { detectClis, defaultCliRunner, TOOL_BINARIES, type CliRunner } from "./detect.js";
import { cliRemoveArgs, planMcpRegistration, registerMcpFile, type McpScope } from "./mcp-registry.js";
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
  /** 四期：broker 接入凭证（控制台发放，dynsec 强制认证） */
  user?: string;
  password?: string;
  /** TASK-32：档案名称（≤50，注册上报用；交互模式必答） */
  agentName?: string;
  /** TASK-32：档案描述（可选） */
  agentDescription?: string;
  /** TASK-32：能力列表（可选） */
  capabilities?: string[];
  /** TASK-32：源 config.json 路径——继承 broker/ns/凭证/tools，client_id 重随机 */
  from?: string;
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
  /** TASK-32：注册上报 HTTP 注入点（测试 mock；生产走全局 fetch） */
  fetcher?: (url: string, init: { method: string; headers: Record<string, string>; body: string }) =>
    Promise<{ ok: boolean; status: number }>;
}

/** TASK-32：默认身份 ag- + 8 位 hex（跨项目克隆不再撞名） */
export function randomClientId(): string {
  return `ag-${randomBytes(4).toString("hex")}`;
}

export interface RawInitConfig {
  client_id: string;
  ns: string;
  broker: { host: string; port: number; username?: string; password?: string };
  sse_url: string;
  default_tool: string;
  allowed_senders: string[];
  tools: Record<string, Record<string, unknown>>;
  ack: boolean;
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
  opts: Pick<InitCliOptions, "tools" | "ns" | "clientId" | "broker" | "sseUrl" | "user" | "password">,
  projectRoot: string,
): RawInitConfig {
  const tools = opts.tools ?? [];
  if (tools.length === 0) {
    throw new Error("未选择任何工具（至少接入一个 AI CLI）");
  }
  const client_id = opts.clientId?.trim() || randomClientId();
  const ns = opts.ns?.trim() || "default";
  const broker = parseBroker(opts.broker?.trim() || "localhost:18830");
  const sse_url =
    opts.sseUrl?.trim() || `http://${broker.host}:8000/sse?client_id=${client_id}&ns=${ns}`;
  const toolCfg: Record<string, Record<string, unknown>> = {};
  for (const t of tools) toolCfg[t] = {};
  return {
    client_id,
    ns,
    // 四期：接入凭证仅在显式传入时写入（写盘前 runInit 保障 .agentbus/ 入 .gitignore）
    broker: {
      ...broker,
      ...(opts.user?.trim() ? { username: opts.user.trim() } : {}),
      ...(opts.password ? { password: opts.password } : {}),
    },
    sse_url,
    default_tool: tools[0],
    allowed_senders: [],
    tools: toolCfg,
    ack: true,
  };
}

const defaultSpawnDaemon = (cmd: string, args: string[]) => {
  spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
};

/** 幂等追加托管条目到项目 .gitignore（不存在则创建）：
 * .agentbus/（凭证）+ .agentbus/agents.json（TASK-32 daemon 同伴快照，勿提交） */
const GITIGNORE_ENTRIES = [".agentbus/", ".agentbus/agents.json"];

function ensureGitignoreEntry(projectRoot: string): void {
  const giPath = join(projectRoot, ".gitignore");
  const existing = existsSync(giPath) ? readFileSync(giPath, "utf-8") : "";
  const lines = existing.split(/\r?\n/).map((l) => l.trim());
  const missing = GITIGNORE_ENTRIES.filter((e) => !lines.includes(e));
  if (missing.length === 0) return;
  const body = existing && !existing.endsWith("\n") ? `${existing}\n` : existing;
  writeFileSync(giPath, `${body}${missing.join("\n")}\n`, "utf-8");
}

/** 五步编排；任何一步失败立即收敛进报告（ok=false），不带病推进 */
export async function runInit(opts: InitCliOptions, deps: InitDeps): Promise<InitReport> {
  const lines: string[] = [];
  const { projectRoot, homeDir } = deps;

  // TASK-32：存量 config 保留原 client_id / agent_name / agent_description（幂等重跑不撞名）
  const existingConfigPath = join(projectRoot, ".agentbus", "config.json");
  let existingClientId = "";
  let existingAgentName = "";
  let existingAgentDescription = "";
  if (existsSync(existingConfigPath)) {
    try {
      const prev = JSON.parse(readFileSync(existingConfigPath, "utf-8")) as {
        client_id?: unknown; agent_name?: unknown; agent_description?: unknown;
      };
      if (typeof prev.client_id === "string" && prev.client_id.trim()) existingClientId = prev.client_id.trim();
      if (typeof prev.agent_name === "string" && prev.agent_name.trim()) existingAgentName = prev.agent_name.trim();
      if (typeof prev.agent_description === "string" && prev.agent_description.trim()) existingAgentDescription = prev.agent_description.trim();
    } catch {
      /* 存量不可解析则按新建处理 */
    }
  }

  // TASK-32：--from 克隆源配置（继承 broker/ns/凭证/tools；client_id 重随机，名称重答）
  let eff = { ...opts };
  if (opts.from) {
    if (!existsSync(opts.from)) {
      return { ok: false, lines: [`✗ --from 源配置不存在：${opts.from}`] };
    }
    let src: Record<string, unknown>;
    try {
      src = JSON.parse(readFileSync(opts.from, "utf-8")) as Record<string, unknown>;
    } catch {
      return { ok: false, lines: [`✗ --from 源配置非法 JSON：${opts.from}`] };
    }
    const sb = (src.broker ?? {}) as { host?: string; port?: number; username?: string; password?: string };
    const srcTools = Object.keys((src.tools ?? {}) as Record<string, unknown>);
    eff = {
      ...eff,
      broker: eff.broker ?? (sb.host ? `${sb.host}:${sb.port ?? 18830}` : undefined),
      ns: eff.ns ?? (typeof src.ns === "string" ? src.ns : undefined),
      user: eff.user ?? sb.username,
      password: eff.password ?? sb.password,
      tools: eff.tools ?? (srcTools.length > 0 ? srcTools : undefined),
    };
    lines.push(`✓ 已从 --from 继承 broker/ns/凭证/tools（client_id 重新随机）`);
  }

  // 步骤 1：交互确认（--yes 全部取默认/传参）
  let answers: Required<Pick<InitCliOptions, "tools" | "scope" | "ns" | "broker" | "sseUrl">> & { clientId: string };
  let agentName: string;
  let agentDescription: string;
  // 已有 client_id 说明已存在 Agent 身份，跳过 Agent 信息问答和上报
  const hasExistingAgent = !!existingClientId;
  const defaultClientId = eff.clientId?.trim() || existingClientId || randomClientId();
  if (eff.yes) {
    // TASK-28 一键安装契约：--yes 未指定工具时自动探测全部已知 CLI，取已安装集
    let tools = eff.tools ?? [];
    if (tools.length === 0) {
      const scan = await detectClis(Object.keys(TOOL_BINARIES), deps.runner);
      tools = scan.filter((d) => d.installed).map((d) => d.tool);
      if (tools.length > 0) {
        lines.push(`自动探测到可接入工具：${tools.join(", ")}`);
      } else {
        lines.push("✗ 未探测到任何已安装的 AI CLI（qodercli/kilo/opencode/claude/codex/hermes），请先安装后重试");
        return { ok: false, lines };
      }
    }
    answers = {
      ns: eff.ns ?? "default",
      clientId: defaultClientId,
      tools,
      scope: eff.scope ?? "project",
      broker: eff.broker ?? "localhost:18830",
      sseUrl: eff.sseUrl ?? "",
    };
    // 已有 Agent 身份则保留原档案，否则用默认值
    if (hasExistingAgent) {
      agentName = existingAgentName;
      agentDescription = existingAgentDescription;
      lines.push(`✓ 已有 Agent 身份（${existingClientId}），保留原档案`);
    } else {
      agentName = (eff.agentName ?? "").trim() || basename(projectRoot);
      agentDescription = (eff.agentDescription ?? "").trim();
    }
  } else {
    const prompter = deps.prompter;
    if (!prompter) {
      return { ok: false, lines: ["非 --yes 模式需要交互问答器（终端环境请走 CLI 入口）"] };
    }
    answers = {
      ns: String(await prompter("ns", eff.ns ?? "default")),
      clientId: String(await prompter("clientId", defaultClientId)),
      tools: (await prompter("tools", eff.tools ?? [])) as string[],
      scope: (await prompter("scope", eff.scope ?? "project")) as McpScope,
      broker: String(await prompter("broker", eff.broker ?? "localhost:18830")),
      sseUrl: String(await prompter("sseUrl", eff.sseUrl ?? "")),
    };
    // 已有 Agent 身份则跳过问答，保留原档案
    if (hasExistingAgent) {
      agentName = existingAgentName;
      agentDescription = existingAgentDescription;
      lines.push(`✓ 已有 Agent 身份（${existingClientId}），保留原档案`);
    } else {
      // TASK-32：名称必答（默认建议目录名，空值重问）；描述可选（回车跳过）
      agentName = "";
      while (!agentName.trim()) {
        agentName = String(await prompter("agentName", eff.agentName?.trim() || basename(projectRoot)));
      }
      agentName = agentName.trim();
      agentDescription = String(await prompter("agentDescription", eff.agentDescription ?? "")).trim();
    }
  }

  let raw: RawInitConfig;
  try {
    raw = buildInitConfig({ ...answers, user: eff.user, password: eff.password }, projectRoot);
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

  // 步骤 3：写配置与契约（含 agent_name / agent_description 持久化，下次 init 自动跳过）
  const agentbusDir = join(projectRoot, ".agentbus");
  mkdirSync(join(agentbusDir, "logs"), { recursive: true });
  mkdirSync(join(agentbusDir, "inbox"), { recursive: true });
  const configPath = join(agentbusDir, "config.json");
  const configWithAgent = {
    ...raw,
    ...(agentName ? { agent_name: agentName } : {}),
    ...(agentDescription ? { agent_description: agentDescription } : {}),
    ...(opts.capabilities && opts.capabilities.length > 0 ? { capabilities: opts.capabilities } : {}),
  };
  writeFileSync(configPath, `${JSON.stringify(configWithAgent, null, 2)}\n`, "utf-8");
  lines.push(`✓ 已写入 .agentbus/config.json（身份 ${raw.ns}/${raw.client_id}）`);

  // TASK-32：托管条目无条件入 .gitignore（凭证 + daemon 同伴快照 agents.json，幂等）
  ensureGitignoreEntry(projectRoot);
  if (raw.broker.password) {
    lines.push("✓ 已保障 .agentbus/ 入 .gitignore（config.json 含接入凭证，勿提交）");
  }

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
      // 幂等（TASK-22 回归发现）：codex mcp add 对已注册同名项返回非零，先 remove 再 add（remove 失败忽略：未注册时可直接 add）
      try {
        await runner(plan.binary!, cliRemoveArgs());
      } catch {
        /* remove 失败不阻断 */
      }
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

  // TASK-32：注册上报（已有 Agent 信息时跳过；hub 由 sse_url 派生去路径；Basic=broker 凭证；失败不阻断）
  if (hasExistingAgent) {
    lines.push("✓ 已有 Agent 档案，跳过注册上报");
  } else {
    await reportRegistration(raw, agentName, agentDescription, deps.fetcher, lines);
  }

  lines.push(`完成！本项目已以身份 "${raw.ns}/${raw.client_id}" 接入 MQTT 总线。`);
  return { ok: true, lines };
}

/** TASK-32：向 hub 上报档案（POST /api/agent/register）；任何失败仅提示，不阻断 init */
async function reportRegistration(
  raw: RawInitConfig,
  agentName: string,
  agentDescription: string,
  fetcher: InitDeps["fetcher"],
  lines: string[],
): Promise<void> {
  const { username, password } = raw.broker;
  if (!username || !password) {
    lines.push("⚠ 未提供 broker 凭证，跳过注册上报（可稍后重跑 agentbus init 补注册）");
    return;
  }
  let hub: string;
  try {
    hub = new URL(raw.sse_url).origin;
  } catch {
    lines.push("⚠ sse_url 非法，跳过注册上报（可稍后重跑 agentbus init 补注册）");
    return;
  }
  const doFetch = fetcher ?? ((url, init) => globalThis.fetch(url, init as RequestInit)
    .then((r) => ({ ok: r.ok, status: r.status })));
  try {
    const resp = await doFetch(`${hub}/api/agent/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
      },
      body: JSON.stringify({
        ns: raw.ns,
        client_id: raw.client_id,
        name: agentName,
        description: agentDescription,
        capabilities: [],
        tools: Object.keys(raw.tools),
      }),
    });
    if (resp.ok) {
      lines.push(`✓ 注册上报成功（hub ${hub}，名称 "${agentName}"）`);
    } else {
      lines.push(`⚠ 注册上报失败（HTTP ${resp.status}），可稍后重跑 agentbus init 补注册`);
    }
  } catch (e) {
    lines.push(`⚠ 注册上报失败（${(e as Error).message}），可稍后重跑 agentbus init 补注册`);
  }
}
