/**
 * TASK-06: Daemon 主体装配（架构 4.2 / 4.3 / 5.3）
 *
 * 数据流：listener → JSON 解析 → router（八步）→ ack 回发 → touchSession + 注册表原子写
 *        → inject 回调（TASK-07 起由适配器实现）/ 限速进 FIFO 队列
 *
 * 注入点：inject 为依赖注入钩子 —— 单元测试与集成测试可用假实现，
 * TASK-07 接入真实适配器后不需要改动本文件。
 */
import { join } from "node:path";
import type { AgentBusConfig } from "../config.js";
import { makeAck, type BusMessage } from "../protocol.js";
import { createListener, type Listener } from "./listener.js";
import { RotatingLogger } from "./logger.js";
import { acquirePidLock, releasePidLock } from "./pid.js";
import { QueueManager } from "./queue.js";
import { knownSenders, loadRegistry, saveRegistry, touchSession, type RegistryData } from "./registry.js";
import { Router, type RouterConfig } from "./router.js";

/** 适配器注入钩子（TASK-07 起替换为真实 spawn CLI） */
export type InjectHandler = (tool: string, sessionId: string, msg: BusMessage) => Promise<void> | void;

export interface DaemonOptions {
  config: AgentBusConfig;
  /** 工作目录：daemon.pid / sessions.json / daemon.log 所在处（默认 ~/.agentbus） */
  workDir: string;
  /** 注入钩子；缺省仅记日志（适配器尚未接入时的占位） */
  inject?: InjectHandler;
}

export interface DaemonStatus {
  running: boolean;
  connected: boolean;
  senderCount: number;
}

interface QueueItem {
  tool: string;
  sessionId: string;
  msg: BusMessage;
}

/** ack 回发 topic：ns 形态身份 → ns topic；纯 client_id → flat topic */
export function senderTopic(from: string): string {
  const slash = from.indexOf("/");
  if (slash < 0) return `/phnix/ai/channel/${from}/message`;
  return `/phnix/ai/channel/${from.slice(0, slash)}/${from.slice(slash + 1)}/message`;
}

export class Daemon {
  private router: Router | null = null;
  private listener: Listener | null = null;
  private registry: RegistryData | null = null;
  private queues = new QueueManager<QueueItem>(20);
  private logger: RotatingLogger;
  private pidFile: string;
  private regPath: string;
  private started = false;

  constructor(private opts: DaemonOptions) {
    this.pidFile = join(opts.workDir, "daemon.pid");
    this.regPath = join(opts.workDir, "sessions.json");
    this.logger = new RotatingLogger(join(opts.workDir, "daemon.log"), {
      maxBytes: 1024 * 1024,
      keep: 5,
    });
  }

  start(): { started: boolean; reason: string } {
    if (this.started) return { started: false, reason: "daemon 已在运行（本进程）" };

    // 1. pid 锁：防双开 + stale 接管
    const lock = acquirePidLock(this.pidFile);
    if (!lock.acquired) {
      return { started: false, reason: `daemon 已在运行（pid ${lock.runningPid}）` };
    }
    if (lock.staleTakenOver !== null) {
      this.logger.info(`接管 stale pid 锁（旧 pid=${lock.staleTakenOver}）`);
    }

    // 2. 注册表（损坏自动备份恢复）
    this.registry = loadRegistry(this.regPath);

    // 3. 路由器（会话判定用注册表快照）
    const cfg = this.opts.config;
    const routerCfg: RouterConfig = {
      selfIdentity: `${cfg.ns}/${cfg.client_id}`,
      allowedSenders: cfg.allowed_senders,
      hopLimit: cfg.hop_limit,
      rateLimit: cfg.rate_limit,
      rateWindowMs: 60_000,
      defaultTool: cfg.default_tool,
      tools: cfg.tools,
      ack: cfg.ack,
      dedupCapacity: 1000,
      queueMax: 20,
    };
    this.router = new Router(routerCfg, { knownSenders: knownSenders(this.registry) });

    // 4. MQTT 层：首次连接失败不致命，mqtt.js 内部持续重连
    const topic = `/phnix/ai/channel/${cfg.ns}/${cfg.client_id}/message`;
    this.listener = createListener({
      broker: cfg.broker,
      clientId: `agentbus-${cfg.ns}-${cfg.client_id}`,
      topic,
      onMessage: (payload) => this.handleMessage(payload),
      onStatus: (status, detail) =>
        this.logger.info(`MQTT ${status}${detail ? `: ${detail}` : ""}`),
    });
    void this.listener.start().catch((e: Error) =>
      this.logger.error(`MQTT 首次连接失败，进入重连: ${e.message}`),
    );

    this.started = true;
    this.logger.info(`daemon started: ${cfg.ns}/${cfg.client_id} 订阅 ${topic}`);
    return { started: true, reason: `daemon 已启动（pid ${process.pid}）` };
  }

  /** 入站处理：解析 → 路由 → 各分支副作用（决策原因全部落日志） */
  private handleMessage(payloadJson: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(payloadJson);
    } catch {
      this.logger.warn("丢弃非 JSON 消息");
      return;
    }
    const { decision, ack, message } = this.router!.route(raw);

    switch (decision.action) {
      case "drop":
        if (decision.alert) this.logger.warn(`丢弃: ${decision.reason}`);
        else this.logger.info(`丢弃: ${decision.reason}`);
        return;
      case "control":
        this.logger.info(`[control] from=${message!.from}: ${message!.text.slice(0, 120)}`);
        return;
      case "ignore":
        this.logger.info(`忽略: ${decision.reason}`);
        return;
      case "inject":
        break;
    }

    // ack 先于注入发出（让对方尽快收到回执）
    if (ack) {
      void this.publishAck(ack).catch((e: Error) => this.logger.warn(`ack 发送失败: ${e.message}`));
    }

    // 会话查询/创建 + 注册表原子落盘（步骤 6/7）
    const { entry } = touchSession(
      this.registry!,
      message!.from,
      decision.tool,
      () => `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      Date.now(),
    );
    saveRegistry(this.regPath, this.registry!);
    if (decision.isNewSender) {
      this.logger.info(`新发件人 ${message!.from}，创建 ${decision.tool} 会话 ${entry.sessionId}`);
    }

    if (decision.queued) {
      // 限速溢出：进 FIFO 队列；满则逐出最旧（落日志）
      const { evicted } = this.queues.push(decision.tool, { tool: decision.tool, sessionId: entry.sessionId, msg: message! });
      if (evicted) this.logger.warn(`队列已满，逐出最旧消息 id=${evicted.msg.id}`);
      this.logger.info(`${decision.reason}（当前队列深度 ${this.queues.depth(decision.tool)}）`);
      return;
    }

    void this.injectAndDrain(decision.tool, entry.sessionId, message!);
  }

  private async injectAndDrain(tool: string, sessionId: string, msg: BusMessage): Promise<void> {
    try {
      await (this.opts.inject ?? (async () => this.logger.info(`[占位注入] ${tool} <- ${msg.from}`)))(
        tool,
        sessionId,
        msg,
      );
    } catch (e) {
      this.logger.error(`注入 ${tool} 失败: ${(e as Error).message}`);
    }
    // 消费后按 FIFO 续排下一条
    this.router!.dequeue(msg.from);
    const next = this.queues.pop(tool);
    if (next) void this.injectAndDrain(next.tool, next.sessionId, next.msg);
  }

  private async publishAck(ack: BusMessage): Promise<void> {
    if (!this.listener || !this.listener.isConnected()) {
      throw new Error("MQTT 未连接");
    }
    const to = Array.isArray(ack.to) ? ack.to[0] : ack.to;
    await this.listener.publish(senderTopic(to), JSON.stringify(ack));
    this.logger.info(`ack 已回发 → ${to}（原消息 ${ack.reply_to}）`);
  }

  stop(): void {
    if (!this.started) return;
    void this.listener?.stop();
    releasePidLock(this.pidFile);
    this.logger.info("daemon stopped");
    this.started = false;
  }

  status(): DaemonStatus {
    return {
      running: this.started,
      connected: this.listener?.isConnected() ?? false,
      senderCount: this.registry ? Object.keys(this.registry.senders).length : 0,
    };
  }
}

// makeAck 在本文件未直接使用（ack 由 router 生成），保留导出供外部复用 senderTopic
void makeAck;
