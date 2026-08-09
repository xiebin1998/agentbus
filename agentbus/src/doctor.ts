/**
 * TASK-12: doctor 环境体检（架构 6.1 / 6.5-D 红线 7）
 *
 * 检查项：配置 / Broker 可达 / SSE 可达 / CLI 探测 / MCP 注册回验 / daemon 存活。
 * 网络探测（TCP/HTTP）均可注入，测试不依赖真实网络。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { connect } from "node:net";
import { ConfigError, loadConfig, type AgentBusConfig } from "./config.js";
import { detectClis, isRemoteTool, type CliRunner } from "./detect.js";
import { MCP_NAME, planMcpRegistration, verifyMcpFile } from "./mcp-registry.js";
import { isProcessAlive } from "./daemon/pid.js";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

export interface DoctorDeps {
  workDir: string;
  projectRoot: string;
  homeDir: string;
  runner?: CliRunner;
  checkTcp?: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
  checkHttp?: (url: string, timeoutMs: number) => Promise<boolean>;
}

const tcpOnce = (host: string, port: number, timeoutMs: number) =>
  new Promise<boolean>((resolve) => {
    const socket = connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });

/** Windows 上 localhost 可能优先解析到 ::1（旧 relay/无监听脑裂，TASK-20/22 实测）；不可达时回退 127.0.0.1 重试 */
const ipv4Fallback = (host: string) => (host.toLowerCase() === "localhost" ? "127.0.0.1" : undefined);

export const defaultCheckTcp = async (host: string, port: number, timeoutMs: number) => {
  if (await tcpOnce(host, port, timeoutMs)) return true;
  const fb = ipv4Fallback(host);
  return fb ? tcpOnce(fb, port, timeoutMs) : false;
};

const httpOnce = async (url: string, timeoutMs: number) => {
  try {
    await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return true; // 任意 HTTP 响应都说明服务可达
  } catch {
    return false;
  }
};

export const defaultCheckHttp = async (url: string, timeoutMs: number) => {
  if (await httpOnce(url, timeoutMs)) return true;
  try {
    const u = new URL(url);
    if (u.hostname.toLowerCase() !== "localhost") return false;
    u.hostname = "127.0.0.1";
    return await httpOnce(u.toString(), timeoutMs);
  } catch {
    return false;
  }
};

async function verifyMcpRegistrations(
  config: AgentBusConfig,
  deps: DoctorDeps,
): Promise<DoctorCheck> {
  const details: string[] = [];
  let allOk = true;
  for (const tool of Object.keys(config.tools)) {
    const plan = planMcpRegistration(tool, "project", config.sse_url ?? "", deps.projectRoot, deps.homeDir);
    if (plan.method === "file") {
      const ok = verifyMcpFile(plan.path!, plan.sectionKey!, MCP_NAME);
      details.push(`${tool}: ${ok ? "✓" : "✗"} ${plan.path}`);
      if (!ok) allOk = false;
    } else if (plan.method === "cli") {
      if (!deps.runner) {
        details.push(`${tool}: ⚠ 无执行器，跳过 mcp list 验证`);
        continue;
      }
      try {
        const r = await deps.runner(plan.binary!, ["mcp", "list"]);
        const ok = r.exitCode === 0 && `${r.stdout}\n${r.stderr}`.includes(MCP_NAME);
        details.push(`${tool}: ${ok ? "✓" : "✗"} ${plan.binary} mcp list`);
        if (!ok) allOk = false;
      } catch {
        details.push(`${tool}: ✗ ${plan.binary} mcp list 执行失败`);
        allOk = false;
      }
    } else {
      details.push(`${tool}: ⚠ ${plan.warnings.join("；")}`);
    }
  }
  return { name: "MCP 注册", ok: allOk, detail: details.join("；") || "无工具配置" };
}

export async function runDoctor(deps: DoctorDeps): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const checkTcp = deps.checkTcp ?? defaultCheckTcp;
  const checkHttp = deps.checkHttp ?? defaultCheckHttp;

  // 1. 配置
  let config: AgentBusConfig | undefined;
  try {
    config = loadConfig(join(deps.workDir, "config.json"));
    checks.push({ name: "配置", ok: true, detail: `身份 ${config.ns}/${config.client_id}，校验通过` });
  } catch (e) {
    const msg = e instanceof ConfigError ? e.message : (e as Error).message;
    checks.push({ name: "配置", ok: false, detail: msg });
  }

  // 2. Broker TCP
  if (config) {
    const reachable = await checkTcp(config.broker.host, config.broker.port, 3000);
    checks.push({
      name: "Broker",
      ok: reachable,
      detail: reachable
        ? `${config.broker.host}:${config.broker.port} 可达`
        : `${config.broker.host}:${config.broker.port} 不可达（检查 broker/docker 服务）`,
    });

    // 3. SSE hub
    if (config.sse_url) {
      const up = await checkHttp(config.sse_url, 3000);
      checks.push({
        name: "SSE",
        ok: up,
        detail: up ? config.sse_url : `${config.sse_url} 不可达（hub 未启动或地址有误）`,
      });
    } else {
      checks.push({ name: "SSE", ok: true, detail: "未配置 sse_url，跳过" });
    }

    // 4. CLI 探测；配 remote 段的工具（如 hermes 远端，架构 4.4/5.5）不在本机，跳过本机探测
    const toolNames = Object.keys(config.tools);
    const localTools = toolNames.filter((t) => !isRemoteTool(config.tools[t]));
    const remoteTools = toolNames.filter((t) => isRemoteTool(config.tools[t]));
    const detected = await detectClis(localTools, deps.runner);
    const missing = detected.filter((d) => !d.installed);
    const remoteNote = remoteTools.map((t) => `${t} ✓（远端 SSH 工具，跳过本机探测）`).join("；");
    const localNote = missing.length === 0
      ? detected.map((d) => `${d.binary} ✓`).join("；")
      : missing.map((d) => `${d.binary} ✗ ${d.reason}`).join("；");
    checks.push({
      name: "CLI",
      ok: missing.length === 0,
      detail: [localNote, remoteNote].filter(Boolean).join("；"),
    });

    // 5. MCP 注册回验（红线 7）
    checks.push(await verifyMcpRegistrations(config, deps));
  }

  // 6. daemon 存活
  let pidAlive = false;
  let pidDetail = "无 daemon.pid（agentbus daemon start 未运行）";
  try {
    const raw = readFileSync(join(deps.workDir, "daemon.pid"), "utf-8").trim();
    const pid = Number.parseInt(raw, 10);
    if (Number.isInteger(pid) && pid > 0 && isProcessAlive(pid)) {
      pidAlive = true;
      pidDetail = `运行中（pid ${pid}）`;
    } else {
      pidDetail = `stale pid 文件（${raw}），可重新 daemon start`;
    }
  } catch {
    // 保持默认提示
  }
  checks.push({ name: "daemon", ok: pidAlive, detail: pidDetail });

  return { ok: checks.every((c) => c.ok), checks };
}
