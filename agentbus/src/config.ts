/**
 * TASK-04: 配置系统（架构 4.4 / 8.3）
 * .agentbus/config.json 的读写、校验、缺省值与 ${ENV_VAR} 凭证解析。
 *
 * 红线：凭证不落明文 —— username/password 写 ${ENV_VAR} 引用，运行时解析；
 * 环境变量缺失必须明确报错（不带病运行）。
 */
import { readFileSync } from "node:fs";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface BrokerConfig {
  host: string;
  port: number;
  username?: string;
  password?: string;
  tls?: boolean;
  /** TASK-25：自签 CA 证书路径（支持 ${ENV} 引用），TLS 时作为信任锚 */
  ca?: string;
}

export interface AgentBusConfig {
  /** 本机总线身份（client_id） */
  client_id: string;
  /** 命名空间，缺省 default */
  ns: string;
  broker: BrokerConfig;
  /** hub SSE 地址（init 写入，doctor 检查） */
  sse_url?: string;
  /** 多工具时入站默认承接工具 */
  default_tool: string;
  /** 允许向本机发消息的来源白名单（一期强制） */
  allowed_senders: string[];
  /** 环路熔断跳数上限 */
  hop_limit: number;
  /** 同一来源 60s 内消息条数上限 */
  rate_limit: number;
  /** 本机工具配置（适配器参数） */
  tools: Record<string, Record<string, unknown>>;
  /** 是否回 ack（type=control） */
  ack: boolean;
  /** TASK-30：OS 级只读隔离（架构 4.7 隔离层）；入站回合恒只读，物理禁写，默认关闭（可选，validate 后恒有值） */
  isolation?: boolean;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  config?: AgentBusConfig;
}

/** 解析字符串中的 ${VAR} 环境变量引用；缺失时抛 ConfigError 并指明变量名 */
export function resolveEnvRefs(value: unknown): unknown {
  if (typeof value !== "string" || !value.includes("${")) {
    return value;
  }
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => {
    const v = process.env[name];
    if (v === undefined) {
      throw new ConfigError(
        `环境变量 ${name} 未设置（config.json 中引用了 \${${name}}，请先设置该环境变量）`,
      );
    }
    return v;
  });
}

/** 校验原始配置对象并补齐架构默认值；不抛异常，错误汇总到 errors */
export function validateConfig(raw: unknown): ValidationResult {
  const errors: string[] = [];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["配置必须是 JSON 对象"] };
  }
  const obj = raw as Record<string, unknown>;

  const client_id = obj.client_id;
  if (typeof client_id !== "string" || !client_id.trim()) {
    errors.push("client_id 缺失或为空（本机总线身份）");
  }

  const ns = typeof obj.ns === "string" && obj.ns.trim() ? obj.ns.trim() : "default";

  const broker = obj.broker as Record<string, unknown> | undefined;
  let brokerCfg: BrokerConfig = { host: "", port: 18830 };
  if (!broker || typeof broker !== "object") {
    errors.push("broker 配置缺失");
  } else {
    if (typeof broker.host !== "string" || !broker.host.trim()) {
      errors.push("broker.host 缺失或为空");
    }
    const port = broker.port;
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
      errors.push("broker.port 必须是 1-65535 的整数");
    }
    brokerCfg = {
      host: typeof broker.host === "string" ? broker.host : "",
      port: typeof port === "number" ? port : 0,
      username: typeof broker.username === "string" ? broker.username : "",
      password: typeof broker.password === "string" ? broker.password : "",
      tls: broker.tls === true,
      // TASK-25：自签 CA 路径（可选）；非字符串忽略
      ...(typeof broker.ca === "string" && broker.ca.trim() ? { ca: broker.ca } : {}),
    };
  }

  const tools =
    obj.tools && typeof obj.tools === "object" && !Array.isArray(obj.tools)
      ? (obj.tools as Record<string, Record<string, unknown>>)
      : {};

  const default_tool = obj.default_tool;
  if (typeof default_tool !== "string" || !default_tool.trim()) {
    errors.push("default_tool 缺失（多工具时入站默认承接工具）");
  } else if (Object.keys(tools).length > 0 && !(default_tool in tools)) {
    errors.push(`default_tool "${default_tool}" 不在 tools 配置中（可选：${Object.keys(tools).join(", ") || "无"}）`);
  }

  const allowed_senders = Array.isArray(obj.allowed_senders)
    ? obj.allowed_senders.filter((s): s is string => typeof s === "string")
    : [];

  const hop_limit =
    typeof obj.hop_limit === "number" && Number.isInteger(obj.hop_limit) && obj.hop_limit >= 1
      ? obj.hop_limit
      : obj.hop_limit === undefined
        ? 3
        : (errors.push("hop_limit 必须是 ≥1 的整数"), 3);

  const rate_limit =
    typeof obj.rate_limit === "number" && Number.isInteger(obj.rate_limit) && obj.rate_limit >= 1
      ? obj.rate_limit
      : obj.rate_limit === undefined
        ? 5
        : (errors.push("rate_limit 必须是 ≥1 的整数"), 5);

  // 定位收敛：inbound_mode/trust_map 字段已移除（入站恒只读）；旧配置带这两字段自然被忽略，静默兼容

  const ack = obj.ack === undefined ? true : obj.ack === true;

  // TASK-30：OS 级只读隔离（可选，默认关闭）
  let isolation = false;
  if (obj.isolation !== undefined) {
    if (typeof obj.isolation === "boolean") {
      isolation = obj.isolation;
    } else {
      errors.push(`isolation 必须是布尔值（收到 "${String(obj.isolation)}"）`);
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    errors: [],
    config: {
      client_id: (client_id as string).trim(),
      ns,
      broker: brokerCfg,
      sse_url: typeof obj.sse_url === "string" ? obj.sse_url : undefined,
      default_tool: (default_tool as string).trim(),
      allowed_senders,
      hop_limit,
      rate_limit,
      tools,
      ack,
      isolation,
    },
  };
}

/** 读取 config.json → 校验 → 解析 ${ENV_VAR} 凭证；失败一律抛 ConfigError */
export function loadConfig(path: string): AgentBusConfig {
  let rawText: string;
  try {
    rawText = readFileSync(path, "utf-8");
  } catch (e) {
    throw new ConfigError(`无法读取配置文件 ${path}: ${(e as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(rawText);
  } catch {
    throw new ConfigError(`配置文件不是合法 JSON: ${path}`);
  }
  const result = validateConfig(raw);
  if (!result.ok || !result.config) {
    throw new ConfigError(`配置校验失败:\n- ${result.errors.join("\n- ")}`);
  }
  const cfg = result.config;
  cfg.broker.username = resolveEnvRefs(cfg.broker.username) as string;
  cfg.broker.password = resolveEnvRefs(cfg.broker.password) as string;
  if (cfg.broker.ca) {
    cfg.broker.ca = resolveEnvRefs(cfg.broker.ca) as string;
  }
  return cfg;
}
