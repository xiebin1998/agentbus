/**
 * TASK-06/09: Daemon 主体装配（架构 4.2 / 4.3 / 4.6 / 4.7 / 5.3）
 *
 * 数据流：listener → JSON 解析 → router（八步）→ ack 回发 → touchSession + 注册表原子写
 *        → 信任判定 + 信封包装 → inject 适配器回合 → 捕获 output
 *        → expect_reply=true 时 makeReply 代回 / 失败发 control 通知（4.6 兜底）
 *
 * 注入点：inject 为依赖注入钩子 —— 集成测试用假实现；缺省走真实适配器（qoder/kilo 族）。
 */
import { join, dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { AgentBusConfig, InboundMode } from "../config.js";
import { newMsgId, makeReply, type BusMessage } from "../protocol.js";
import { OpenCodeKiloAdapter } from "../adapters/opencode-kilo.js";
import { QoderAdapter } from "../adapters/qoder.js";
import { ClaudeAdapter } from "../adapters/claude.js";
import { createListener, type Listener } from "./listener.js";
import { RotatingLogger } from "./logger.js";
import { acquirePidLock, releasePidLock } from "./pid.js";
import { QueueManager } from "./queue.js";
import { knownSenders, loadRegistry, saveRegistry, touchSession, type RegistryData } from "./registry.js";
import { Router, type RouterConfig } from "./router.js";
import { buildEnvelope } from "./envelope.js";
import { resolveTrust } from "./trust.js";

/** 注入上下文：信封已按信任级别包装；注入器返回回合输出（代回的原料） */
export interface InjectContext {
  tool: string;
  sessionId: string;
  envelope: string;
  msg: BusMessage;
  mode: InboundMode;
  senderName: string;
  /** 该发件人在此工具的首条消息（适配器可据此建会话） */
  isNew: boolean;
}

export type InjectHandler = (ctx: InjectContext) => Promise<{ output: string; sessionId?: string }>;

export interface DaemonOptions {
  config: AgentBusConfig;
  /** 工作目录：daemon.pid / sessions.json / logs/daemon.log 所在处（默认 ~/.agentbus） */
  workDir: string;
  /** 注入钩子；缺省按工具名走真实适配器 */
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

/** ack/回复回发 topic：ns 形态身份 → ns topic；纯 client_id → flat topic */
export function senderTopic(from: string): string {
  const slash = from.indexOf("/");
  if (slash < 0) return `/phnix/ai/channel/${from}/message`;
  return `/phnix/ai/channel/${from.slice(0, slash)}/${from.slice(slash + 1)}/message`;
}

/** OpenCode/Kilo 同族：会话 id 由 CLI 侧生成（事件流提取），非 daemon 预生成 */
const KILO_FAMILY = new Set(["kilo", "opencode"]);

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
    // 架构 6.2：日志落 .agentbus/logs/daemon.log，目录不存在时自建（手动 daemon start 不依赖 init）
    const logPath = join(opts.workDir, "logs", "daemon.log");
    mkdirSync(dirname(logPath), { recursive: true });
    this.logger = new RotatingLogger(logPath, {
      maxBytes: 1024 * 1024,
      keep: 5,
    });
  }

  private get selfIdentity(): string {
    return `${this.opts.config.ns}/${this.opts.config.client_id}`;
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
      selfIdentity: this.selfIdentity,
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
    this.logger.info(`daemon started: ${this.selfIdentity} 订阅 ${topic}`);
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

    // 会话查询/创建 + 注册表原子落盘（步骤 6/7）；会话 id 统一 UUID（qoder 硬约束）
    const { entry, isNew } = touchSession(
      this.registry!,
      message!.from,
      decision.tool,
      () => randomUUID(),
      Date.now(),
    );
    saveRegistry(this.regPath, this.registry!);
    if (isNew) {
      this.logger.info(`新发件人 ${message!.from}，创建 ${decision.tool} 会话 ${entry.sessionId}`);
    }

    if (decision.queued) {
      // 限速溢出：进 FIFO 队列；满则逐出最旧（落日志）
      const { evicted } = this.queues.push(decision.tool, { tool: decision.tool, sessionId: entry.sessionId, msg: message! });
      if (evicted) this.logger.warn(`队列已满，逐出最旧消息 id=${evicted.msg.id}`);
      this.logger.info(`${decision.reason}（当前队列深度 ${this.queues.depth(decision.tool)}）`);
      return;
    }

    void this.injectAndDrain(decision.tool, entry.sessionId, message!, isNew);
  }

  private async injectAndDrain(tool: string, sessionId: string, msg: BusMessage, isNew: boolean): Promise<void> {
    const cfg = this.opts.config;
    // 信任分级 + 信封（4.6/4.7）：参数层与提示层一致
    const mode = resolveTrust(msg.from, cfg.inbound_mode, cfg.trust_map);
    const envelope = buildEnvelope(msg, mode);
    const senderName = msg.from.includes("/") ? msg.from.slice(msg.from.indexOf("/") + 1) : msg.from;

    let output = "";
    let failed = false;
    let failReason = "";
    try {
      const handler = this.opts.inject ?? this.defaultInject();
      const turn = await handler({ tool, sessionId, envelope, msg, mode, senderName, isNew });
      output = turn.output;
      // kilo 族会话 id 由 CLI 侧生成：回写注册表保持续接正确
      if (turn.sessionId && turn.sessionId !== sessionId) {
        const perTool = this.registry!.senders[msg.from];
        if (perTool?.[tool]) {
          perTool[tool]!.sessionId = turn.sessionId;
          saveRegistry(this.regPath, this.registry!);
          sessionId = turn.sessionId;
        }
      }
    } catch (e) {
      failed = true;
      failReason = (e as Error).message;
      this.logger.error(`注入 ${tool} 失败: ${failReason}`);
    }

    // 回复通道（4.6）：expect_reply=true 时代回输出；失败发 control 通知防对方干等
    if (msg.expect_reply) {
      if (failed) {
        void this.publishFailure(msg, failReason).catch((e: Error) =>
          this.logger.warn(`失败通知发送失败: ${e.message}`),
        );
      } else if (output.trim()) {
        void this.publishReply(msg, output).catch((e: Error) =>
          this.logger.warn(`代回发送失败: ${e.message}`),
        );
      } else {
        this.logger.warn(`注入 ${tool} 成功但输出为空，不代回（msg ${msg.id}）`);
      }
    }

    // 消费后按 FIFO 续排下一条
    this.router!.dequeue(msg.from);
    const next = this.queues.pop(tool);
    if (next) void this.injectAndDrain(next.tool, next.sessionId, next.msg, false);
  }

  /** 缺省注入器：按工具名选适配器执行真实回合 */
  private defaultInject(): InjectHandler {
    return async (ctx) => {
      const toolCfg = this.opts.config.tools[ctx.tool] ?? {};
      const workspace = typeof toolCfg.workspace === "string" ? toolCfg.workspace : process.cwd();
      if (KILO_FAMILY.has(ctx.tool)) {
        const adapter = new OpenCodeKiloAdapter({
          binary: typeof toolCfg.binary === "string" ? toolCfg.binary : ctx.tool,
          workspace,
        });
        const turn = ctx.isNew
          ? await adapter.createSession(ctx.envelope, ctx.senderName)
          : await adapter.inject(ctx.envelope, ctx.sessionId);
        if (turn.error) throw new Error(turn.error);
        return { output: turn.output, sessionId: turn.sessionId ?? undefined };
      }
      // claude：create（--session-id）与 inject（-r）不同命令形态，readonly 走 plan 实测档（TASK-15）
      if (ctx.tool === "claude") {
        const adapter = new ClaudeAdapter({
          binary: typeof toolCfg.binary === "string" ? toolCfg.binary : "claude",
          workspace,
          sessionName: ctx.senderName,
        });
        const turn = ctx.isNew
          ? await adapter.createSession(ctx.envelope, ctx.sessionId, ctx.mode)
          : await adapter.injectWith(ctx.envelope, ctx.sessionId, ctx.mode);
        if (turn.error) throw new Error(turn.error);
        return { output: turn.output };
      }
      // qoder 族（含未来 codex 的同类 --session-id UUID 语义）
      const adapter = new QoderAdapter({
        binary: typeof toolCfg.binary === "string" ? toolCfg.binary : ctx.tool === "qoder" ? "qodercli" : ctx.tool,
        workspace,
        sessionName: ctx.senderName,
      });
      const turn = await adapter.injectWith(ctx.envelope, ctx.sessionId, ctx.mode);
      if (turn.error) throw new Error(turn.error);
      return { output: turn.output };
    };
  }

  private async publishAck(ack: BusMessage): Promise<void> {
    const to = Array.isArray(ack.to) ? ack.to[0] : ack.to;
    await this.publish(senderTopic(to), ack);
    this.logger.info(`ack 已回发 → ${to}（原消息 ${ack.reply_to}）`);
  }

  /** 代回（4.6 步骤 3）：reply_to=原消息 / hop+1 / expect_reply=false 终止互询 */
  private async publishReply(original: BusMessage, output: string): Promise<void> {
    const reply = makeReply(this.selfIdentity, original, output);
    await this.publish(senderTopic(original.from), reply);
    this.logger.info(`代回已发送 → ${original.from}（原消息 ${original.id}，${output.length} 字符）`);
  }

  /** 注入失败通知（4.6 兜底）：control 类型不触发对方回合 */
  private async publishFailure(original: BusMessage, reason: string): Promise<void> {
    const notice: BusMessage = {
      id: newMsgId(),
      from: this.selfIdentity,
      redirect_client_id: this.selfIdentity,
      to: original.from,
      text: `注入失败：${reason}`,
      type: "control",
      reply_to: original.id,
      hop: original.hop + 1,
      expect_reply: false,
      timestamp: new Date().toISOString(),
    };
    await this.publish(senderTopic(original.from), notice);
    this.logger.warn(`失败通知已发送 → ${original.from}: ${reason}`);
  }

  private async publish(topic: string, msg: BusMessage): Promise<void> {
    if (!this.listener || !this.listener.isConnected()) {
      throw new Error("MQTT 未连接");
    }
    await this.listener.publish(topic, JSON.stringify(msg));
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
