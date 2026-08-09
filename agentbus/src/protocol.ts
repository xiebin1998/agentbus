/**
 * AgentBus 总线消息协议（架构 3.2）—— daemon/adapter 的单一事实来源
 *
 * 设计红线：normalize 对任何非法输入都不抛异常（旧客户端兼容 + 防恶意消息打挂路由）
 */
import { randomBytes } from "node:crypto";

/** 总线消息（qwenpaw 兼容格式 + v1.1 新增字段） */
export interface BusMessage {
  id: string;
  /** 发送方总线身份（flat 客户端为 client_id；ns 客户端为 <ns>/<client_id>） */
  from: string;
  /** 兼容 qwenpaw 的冗余发送方字段 */
  redirect_client_id: string;
  /** 目标：client_id / <ns>/<client_id> / 带 @tool 后缀 / 数组群发 */
  to: string | string[];
  text: string;
  /** text=触发完整回合；control=仅记日志不注入（环路抑制） */
  type: "text" | "control";
  /** 本消息回复的目标消息 id（回复必填） */
  reply_to: string | null;
  /** 跳数，缺省 0；超过 hop_limit 丢弃（环路熔断） */
  hop: number;
  /** 是否期望对方回复；自动回复/ack 一律 false（终止互询） */
  expect_reply: boolean;
  timestamp: string;
}

/** 生成消息 id：msg- + 12 位 hex */
export function newMsgId(): string {
  return `msg-${randomBytes(6).toString("hex")}`;
}

/**
 * 将任意入站原始对象规整为 BusMessage；非法输入返回 null（不抛异常）。
 * 缺省值：type→text、hop→0、expect_reply→true、reply_to→null、timestamp→当前。
 */
export function normalize(raw: unknown): BusMessage | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const from = obj.from;
  if (typeof from !== "string" || !from) {
    return null;
  }

  const type = obj.type === "control" ? "control" : "text";
  const hopRaw = obj.hop;
  const hop = typeof hopRaw === "number" && Number.isFinite(hopRaw) && hopRaw >= 0
    ? Math.floor(hopRaw)
    : 0;

  return {
    id: typeof obj.id === "string" && obj.id ? obj.id : newMsgId(),
    from,
    redirect_client_id:
      typeof obj.redirect_client_id === "string" && obj.redirect_client_id
        ? obj.redirect_client_id
        : from,
    to: (obj.to as BusMessage["to"]) ?? "",
    text: typeof obj.text === "string" ? obj.text : "",
    type,
    reply_to: typeof obj.reply_to === "string" && obj.reply_to ? obj.reply_to : null,
    hop,
    expect_reply: typeof obj.expect_reply === "boolean" ? obj.expect_reply : true,
    timestamp:
      typeof obj.timestamp === "string" && obj.timestamp
        ? obj.timestamp
        : new Date().toISOString(),
  };
}

/**
 * 组装 ack（架构 4.2 步骤 8）：type=control 不触发对方回合，expect_reply=false 终止互询。
 */
export function makeAck(selfId: string, original: BusMessage): BusMessage {
  return {
    id: newMsgId(),
    from: selfId,
    redirect_client_id: selfId,
    to: original.from,
    text: "ack",
    type: "control",
    reply_to: original.id,
    hop: original.hop + 1,
    expect_reply: false,
    timestamp: new Date().toISOString(),
  };
}

/**
 * 组装代回复（架构 4.6）：daemon 捕获注入输出后回传给发件人，expect_reply=false 终止链条。
 */
export function makeReply(selfId: string, original: BusMessage, text: string): BusMessage {
  return {
    id: newMsgId(),
    from: selfId,
    redirect_client_id: selfId,
    to: original.from,
    text,
    type: "text",
    reply_to: original.id,
    hop: original.hop + 1,
    expect_reply: false,
    timestamp: new Date().toISOString(),
  };
}
