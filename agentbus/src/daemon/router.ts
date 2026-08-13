/**
 * TASK-05: Daemon 路由管线（架构 4.2 步骤 0–8）
 *
 * 纯逻辑实现（不依赖 MQTT/文件系统），供 listener 调用与单元测试。
 * 每个决策都携带 reason，调用方负责记日志。
 */
import { makeAck, normalize, type BusMessage } from "../protocol.js";

export interface RouterConfig {
  /** 本机总线身份（ack 的 from） */
  selfIdentity: string;
  /** 允许入站的来源白名单（空 = 不限制；支持按 client 段匹配 ns 形态发件人） */
  allowedSenders: string[];
  /** 环路熔断跳数上限 */
  hopLimit: number;
  /** 同一来源窗口内直通条数上限 */
  rateLimit: number;
  /** 限速窗口（毫秒，默认 60s） */
  rateWindowMs: number;
  /** to 未带 @tool 时的默认承接工具 */
  defaultTool: string;
  /** 本机已配置工具表 */
  tools: Record<string, unknown>;
  /** 是否回 ack（type=control） */
  ack: boolean;
  /** 去重 LRU 容量 */
  dedupCapacity: number;
  /** 限速队列最大深度（超过逐出最旧） */
  queueMax: number;
}

export type RouteDecision =
  /** 丢弃；alert=true 需记告警日志（白名单外/环路），false 静默（去重/非法）；kind 供指标分类（TASK-19） */
  | { action: "drop"; kind: "invalid" | "whitelist" | "dedup" | "hop"; reason: string; alert: boolean }
  /** control 消息：仅记日志，不注入不回 ack（环路抑制核心） */
  | { action: "control"; reason: string }
  /** 目标工具未配置等：忽略 */
  | { action: "ignore"; reason: string }
  /** 注入：queued=被限速排队；evictOldest=队列满需逐出最旧；isNewSender=需 create_session */
  | {
      action: "inject";
      tool: string;
      queued: boolean;
      evictOldest: boolean;
      isNewSender: boolean;
      reason: string;
    };

export interface RouteResult {
  decision: RouteDecision;
  /** config.ack=true 且 type=text 且放行注入时的 ack 消息（否则 null） */
  ack: BusMessage | null;
  /** 规整后的消息（drop 非法输入时为 null） */
  message: BusMessage | null;
}

export interface RouterOptions {
  /** 注入式时钟（测试用） */
  now?: () => number;
  // 简化方案：不再使用 knownSenders，isNew 判定改为看消息是否带 session 字段
}

/** 有界去重集合（LRU：has 访问也刷新热度，容量满逐出最旧） */
class LruSet {
  private map = new Map<string, true>();
  constructor(private capacity: number) {}

  has(key: string): boolean {
    if (!this.map.has(key)) return false;
    // 刷新热度
    this.map.delete(key);
    this.map.set(key, true);
    return true;
  }

  add(key: string): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, true);
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }
}

/** 从 to 中提取 @tool 后缀（字符串或数组取首元素） */
function extractTool(to: BusMessage["to"]): string | null {
  const first = Array.isArray(to) ? to[0] : to;
  if (typeof first !== "string") return null;
  const at = first.lastIndexOf("@");
  return at >= 0 ? first.slice(at + 1).trim() || null : null;
}

export class Router {
  private seen: LruSet;
  /** 每个来源的直通时间戳窗口 */
  private rateWindows = new Map<string, number[]>();
  /** 每个来源的排队深度 */
  private queueDepths = new Map<string, number>();
  private now: () => number;

  constructor(
    private cfg: RouterConfig,
    opts: RouterOptions = {},
  ) {
    this.seen = new LruSet(cfg.dedupCapacity);
    this.now = opts.now ?? Date.now;
    // 简化方案：不再维护 knownSenders，isNew 判定改为看消息是否带 session 字段
  }

  /** 队列消费一条后调用，释放排队深度 */
  dequeue(sender: string): void {
    const d = this.queueDepths.get(sender) ?? 0;
    if (d <= 1) this.queueDepths.delete(sender);
    else this.queueDepths.set(sender, d - 1);
  }

  route(raw: unknown): RouteResult {
    const m = normalize(raw);

    // 非法输入：静默丢弃
    if (m === null) {
      return {
        decision: { action: "drop", kind: "invalid", reason: "非法消息（非对象或缺 from）", alert: false },
        ack: null,
        message: null,
      };
    }

    const sender = m.from;
    const senderClient = sender.includes("/") ? sender.slice(sender.indexOf("/") + 1) : sender;

    // 步骤 0：白名单
    if (
      this.cfg.allowedSenders.length > 0 &&
      !this.cfg.allowedSenders.includes(sender) &&
      !this.cfg.allowedSenders.includes(senderClient)
    ) {
      return {
        decision: { action: "drop", kind: "whitelist", reason: `来源 ${sender} 不在 allowed_senders 白名单`, alert: true },
        ack: null,
        message: m,
      };
    }

    // 步骤 1：去重
    if (this.seen.has(m.id)) {
      return {
        decision: { action: "drop", kind: "dedup", reason: `重复消息 id=${m.id}`, alert: false },
        ack: null,
        message: m,
      };
    }

    // 步骤 2：hop 熔断
    if (m.hop > this.cfg.hopLimit) {
      this.seen.add(m.id);
      return {
        decision: { action: "drop", kind: "hop", reason: `hop=${m.hop} 超过 hop_limit=${this.cfg.hopLimit}（环路熔断）`, alert: true },
        ack: null,
        message: m,
      };
    }

    // 步骤 3：control 短路（ack/心跳只记日志，切断自动回复环路）
    if (m.type === "control") {
      this.seen.add(m.id);
      return {
        decision: { action: "control", reason: "control 消息仅记日志，不注入" },
        ack: null,
        message: m,
      };
    }

    // 握手消息走控制路径（不注入 AI 回合）
    if (m.type === "hello" || m.type === "hello_ack") {
      this.seen.add(m.id);
      return {
        decision: { action: "control", reason: `${m.type}：握手消息，走控制路径` },
        ack: null,
        message: m,
      };
    }

    // 步骤 4：目标工具判定（@tool 限定 → default_tool → 未配置则忽略）
    const tool = extractTool(m.to) ?? this.cfg.defaultTool;
    if (!(tool in this.cfg.tools)) {
      this.seen.add(m.id);
      return {
        decision: { action: "ignore", reason: `工具 ${tool} 未在本机 config.tools 中配置` },
        ack: null,
        message: m,
      };
    }

    // 步骤 5：限速（滑动窗口；溢出排队，队列超 queueMax 逐出最旧）
    const t = this.now();
    const window = (this.rateWindows.get(sender) ?? []).filter(
      (ts) => t - ts < this.cfg.rateWindowMs,
    );
    const queued = window.length >= this.cfg.rateLimit;
    window.push(t);
    this.rateWindows.set(sender, window);

    let evictOldest = false;
    if (queued) {
      const depth = (this.queueDepths.get(sender) ?? 0) + 1;
      this.queueDepths.set(sender, depth);
      evictOldest = depth > this.cfg.queueMax;
    }

    // 步骤 6：会话判定已移至 daemon 层（通道管理器负责）
    // 路由器不再判断 isNew，由 daemon 根据通道是否存在来决定
    const isNewSender = false;

    // 步骤 7：记入去重 LRU
    this.seen.add(m.id);

    // 步骤 8：ack（一律 type=control，不触发对方回合）
    const ack = this.cfg.ack ? makeAck(this.cfg.selfIdentity, m) : null;

    return {
      decision: {
        action: "inject",
        tool,
        queued,
        evictOldest,
        isNewSender,
        reason: queued
          ? `来源 ${sender} 超过限速（${this.cfg.rateLimit} 条/${this.cfg.rateWindowMs}ms），排队处理`
          : "正常入站",
      },
      ack,
      message: m,
    };
  }
}
