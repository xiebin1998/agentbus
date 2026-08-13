/**
 * 通道管理器：daemon 维护与所有对应方的通信通道
 *
 * 每个通道记录：
 * - channelId: 通道唯一 ID
 * - remote: 对应方总线身份 (ns/client_id)
 * - localSessionId: 本 daemon 为该对应方创建的本地会话 ID（kilo 真实 session）
 * - remoteSessionId: 对应方 daemon 的会话 ID（从回复中学到，供未来发送侧使用）
 * - lastMessageId: 最近消息 ID（用于调试/审计）
 * - createdAt: 通道创建时间
 * - updatedAt: 最后更新时间
 *
 * 通道方案核心：daemon 为每个入站发送方维护一个通道，
 * 同一发送方的消息续接同一个本地会话，不再每次新建。
 */
import { randomUUID } from "node:crypto";

export type ChannelState = "SYN_SENT" | "ESTABLISHED";

export interface HandshakeEntry {
  remote: string;
  resolve: () => void;
  timer: NodeJS.Timeout;
}

export interface Channel {
  channelId: string;
  remote: string;
  /** 通道握手状态：SYN_SENT（握手中）| ESTABLISHED（握手完成） */
  state: ChannelState;
  /** 本 daemon 为该通道创建的本地会话 ID（kilo 返回的真实 session） */
  localSessionId: string;
  /** 对应方 daemon 的会话 ID（从回复消息的 session 字段提取，供未来使用） */
  remoteSessionId: string | null;
  lastMessageId: string | null;
  createdAt: string;
  updatedAt: string;
}

export class ChannelManager {
  /** remote → Channel */
  private channels = new Map<string, Channel>();
  /** remote → pending handshake entry */
  private pendingHandshakes = new Map<string, HandshakeEntry>();

  /** 入站消息：查找或创建通道，返回 [channel, isNew] */
  getOrCreate(remote: string, messageId: string): [Channel, boolean] {
    const existing = this.channels.get(remote);
    if (existing) {
      existing.lastMessageId = messageId;
      existing.updatedAt = new Date().toISOString();
      return [existing, false];
    }
    const ch: Channel = {
      channelId: randomUUID(),
      remote,
      state: "SYN_SENT",
      localSessionId: randomUUID(),
      remoteSessionId: null,
      lastMessageId: messageId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.channels.set(remote, ch);
    return [ch, true];
  }

  /** 查找已有通道（不存在返回 null） */
  get(remote: string): Channel | null {
    return this.channels.get(remote) ?? null;
  }

  /** 更新对应方的远程会话 ID（从回复消息的 session 字段提取） */
  updateRemoteSession(remote: string, remoteSessionId: string): void {
    const ch = this.channels.get(remote);
    if (ch) {
      ch.remoteSessionId = remoteSessionId;
      ch.updatedAt = new Date().toISOString();
    }
  }

  /** 获取所有通道（供状态查询/调试） */
  listChannels(): Channel[] {
    return Array.from(this.channels.values());
  }

  /** 更新通道握手状态 */
  setState(remote: string, state: ChannelState): void {
    const ch = this.channels.get(remote);
    if (ch) {
      ch.state = state;
      ch.updatedAt = new Date().toISOString();
    }
  }

  /** 注册待完成的握手（发送 hello 后调用） */
  trackPendingHandshake(remote: string, resolve: () => void, timer: NodeJS.Timeout): void {
    this.pendingHandshakes.set(remote, { remote, resolve, timer });
  }

  /** 消费待完成的握手（收到 hello_ack 后调用），不存在返回 null */
  consumePendingHandshake(remote: string): HandshakeEntry | null {
    const entry = this.pendingHandshakes.get(remote);
    if (!entry) return null;
    this.pendingHandshakes.delete(remote);
    return entry;
  }

  /** 删除通道 */
  remove(remote: string): boolean {
    return this.channels.delete(remote);
  }
}
