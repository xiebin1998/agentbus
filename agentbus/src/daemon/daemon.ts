/**
 * TASK-06/09: Daemon 主体装配（架构 4.2 / 4.3 / 4.6 / 4.7 / 5.3）
 *
 * 数据流：listener → JSON 解析 → router（八步）→ ack 回发 → touchSession + 注册表原子写
 *        → 信封包装（恒只读） → inject 适配器回合 → 捕获 output
 *        → expect_reply=true 时 makeReply 代回 / 失败发 control 通知（4.6 兜底）
 *
 * 注入点：inject 为依赖注入钩子 —— 集成测试用假实现；缺省走真实适配器（qoder/kilo 族）。
 */
import { join, dirname } from "node:path";
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { AgentBusConfig } from "../config.js";
import { newMsgId, makeReply, type BusMessage } from "../protocol.js";
import { OpenCodeKiloAdapter } from "../adapters/opencode-kilo.js";
import { QoderAdapter } from "../adapters/qoder.js";
import { ClaudeAdapter } from "../adapters/claude.js";
import { HermesAdapter, type HermesRemoteConfig } from "../adapters/hermes.js";
import { CodexAdapter } from "../adapters/codex.js";
import { acquireAdapterLock, tryAcquireAdapterLock, releaseAdapterLock } from "./adapter-lock.js";
import { createListener, type Listener, type ListenerOptions, presenceTopic } from "./listener.js";
import { RotatingLogger } from "./logger.js";
import { acquirePidLock, releasePidLock } from "./pid.js";
import { Router, type RouterConfig } from "./router.js";
import { ServeManager } from "./serve-manager.js";
import { SessionLock } from "./session-lock.js";
import { syncAgentsSnapshot, lookupAgentName, fetchAgentsFromHub } from "./snapshot.js";
import { buildEnvelope, type EnvelopeContext } from "./envelope.js";
import { ChannelManager, type Channel } from "./channel.js";
import { IpcServer } from "./ipc-server.js";
import { applyReadonly, removeReadonly } from "../isolate.js";

/** 注入上下文：信封恒按只读包装；注入器返回回合输出（代回的原料） */
export interface InjectContext {
  tool: string;
  sessionId: string;
  envelope: string;
  msg: BusMessage;
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
  /** 指标上报周期（TASK-19；默认 30s，测试可注入短间隔） */
  /** TASK-32：致命退出钩子（默认 process.exit；测试注入捕获） */
  onExit?: (code: number) => void;
  /** TASK-32：listener 工厂钩子（默认真 MQTT；测试注入假实现） */
  listenerFactory?: (opts: ListenerOptions) => Listener;
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

/** ack/回复回发 topic：ns 形态身份 → ns topic；四期 flat 已删除，无 ns 段返回 null（调用方告警跳过） */
export function senderTopic(from: string): string | null {
  const slash = from.indexOf("/");
  if (slash < 0 || slash === from.length - 1) return null;
  return `/agentbus/ai/channel/${from.slice(0, slash)}/${from.slice(slash + 1)}/message`;
}

/** OpenCode/Kilo 同族：会话 id 由 CLI 侧生成（事件流提取），非 daemon 预生成 */
const KILO_FAMILY = new Set(["kilo", "opencode"]);

/** 解析 tools.hermes.remote 配置段（架构 4.4）；非法/缺失返回 undefined（本机直连形态） */
function parseHermesRemote(raw: unknown): HermesRemoteConfig | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.host !== "string" || !r.host.trim()) return undefined;
  const cfg: HermesRemoteConfig = { host: r.host };
  if (typeof r.user === "string") cfg.user = r.user;
  // 配置面用 ssh_key（架构 4.4 示例），适配器内部驼峰 sshKey
  if (typeof r.ssh_key === "string") cfg.sshKey = r.ssh_key;
  if (typeof r.port === "number") cfg.port = r.port;
  return cfg;
}

export class Daemon {
  private router: Router | null = null;
  private listener: Listener | null = null;
  /** TASK-29：同一发件人在同一工具的回合串行（并发不串话）；异会话并行 */
  private sessionLock = new SessionLock();
  /** TASK-30：隔离引用计数（同 workspace 并发回合共享隔离，归零才解除） */
  private isolateStates = new Map<string, { count: number; chain: Promise<void> }>();
  private serveManager = new ServeManager({ warn: (m) => this.logger.warn(m) });
  private logger: RotatingLogger;
  private pidFile: string;
  private ipcFile: string;
  private ipcServer: IpcServer | null = null;
  private started = false;
  /** 当前实例启动时间戳（ISO）：用于过滤 broker 缓存的过期消息（cleanSession:false 场景） */
  private startedAt = "";
  /** 通道管理器：维护与所有对应方的通信通道 */
  private channels = new ChannelManager();

  constructor(private opts: DaemonOptions) {
    this.pidFile = join(opts.workDir, "daemon.pid");
    this.ipcFile = join(opts.workDir, "daemon.ipc");
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

    // 2. 路由器（会话判定：消息有 session 字段 → 续接；无 → 新建）
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
    this.router = new Router(routerCfg);

    // 4. MQTT 层：首次连接失败不致命，mqtt.js 内部持续重连
    const topic = `/agentbus/ai/channel/${cfg.ns}/${cfg.client_id}/message`;
    const factory = this.opts.listenerFactory ?? createListener;
    this.listener = factory({
      broker: cfg.broker,
      clientId: `agentbus-${cfg.ns}-${cfg.client_id}`,
      topic,
      presence: { topic: presenceTopic(cfg.ns, cfg.client_id), identity: this.selfIdentity },
      onMessage: (payload) => {
        this.handleMessage(payload).catch((e: Error) =>
          this.logger.error(`handleMessage 异常: ${e.message}`)
        );
      },
      onStatus: (status, detail) => {
        if (status === "identity_conflict") {
          // TASK-32 断连指纹：同 client_id 互踢，重连只会加剧互伤 → 错误日志 + 退出码 2
          this.logger.error(`MQTT identity_conflict: ${detail ?? ""}`);
          (this.opts.onExit ?? ((code) => process.exit(code)))(2);
          return;
        }
        this.logger.info(`MQTT ${status}${detail ? `: ${detail}` : ""}`);
      },
      // 连接就绪补报：启动即报几乎必早于 MQTT 连上（被 isConnected 门控跳过），
      // 首连/重连就绪后立即补报一次，避免首次入册等满一个周期（30s）
          });
    void this.listener.start().catch((e: Error) =>
      this.logger.error(`MQTT 首次连接失败，进入重连: ${e.message}`),
    );

    // 5. IPC Server：供桥进程连接（异步启动，不阻塞 daemon 启动）
    this.ipcServer = new IpcServer({ port: 0 });
    this.registerIpcTools();
    void this.ipcServer.start().then(() => {
      if (this.ipcServer?.address) {
        writeFileSync(this.ipcFile, this.ipcServer.address, "utf-8");
        this.logger.info(`IPC Server 就绪: ${this.ipcServer.address}`);
      }
    });

    // 6. 启动就绪
    this.started = true;
    this.startedAt = new Date().toISOString();
    void this.syncSnapshot();

    this.logger.info(`daemon started: ${this.selfIdentity} 订阅 ${topic}，IPC: ${this.ipcServer.address}`);
    return { started: true, reason: `daemon 已启动（pid ${process.pid}）` };
  }

  /** 入站处理：解析 → 路由 → 各分支副作用（决策原因全部落日志） */
  private async handleMessage(payloadJson: string): Promise<void> {
    let raw: unknown;
    try {
      raw = JSON.parse(payloadJson);
    } catch {
      this.logger.warn("丢弃非 JSON 消息");
      return;
    }
    const { decision, ack, message } = this.router!.route(raw);

    // hello_ack 走控制路径但需要额外处理：更新通道状态 + resolve pendingHandshake
    if (message?.type === "hello_ack") {
      const entry = this.channels.consumePendingHandshake(message.from);
      if (entry) {
        this.channels.updateRemoteSession(message.from, message.session!);
        this.channels.setState(message.from, "ESTABLISHED");
        entry.resolve();
        this.logger.info(`握手完成：${message.from} session=${message.session}`);
      } else {
        this.logger.info(`hello_ack 无匹配 pendingHandshake from=${message.from}`);
      }
      return;
    }

    // hello 消息：建通道 + 回 hello_ack（纯控制路径，不触发 kilo）
    if (message?.type === "hello") {
      const [channel, isNew] = this.channels.getOrCreate(message.from, message.id);
      if (isNew || channel.state !== "ESTABLISHED") {
        // 学到对方 session
        if (message.session) {
          this.channels.updateRemoteSession(message.from, message.session);
        }
        this.channels.setState(message.from, "ESTABLISHED");
        this.logger.info(`收到 hello：${message.from} session=${message.session}，通道 ${isNew ? "新建" : "更新"} → ESTABLISHED`);
      }

      // 回 hello_ack
      await this.sendHelloAck(message, channel);
      return;
    }

    // 过期消息过滤：cleanSession:false 场景下 broker 可能投递上次连接的缓存消息
    // 时间戳早于当前 daemon 启动时间的消息视为过期，丢弃（hello/hello_ack 已在上层处理，不受影响）
    if (message?.timestamp && this.startedAt && message.timestamp < this.startedAt) {
      this.logger.info(`丢弃过期消息：id=${message.id} ts=${message.timestamp} startedAt=${this.startedAt}`);
      return;
    }

    // 回复匹配优先：收到回复时（reply_to 有值 + expect_reply=false + session）：提取 session 字段更新通道并 resolve pendingReply
    // 必须在 router switch 之前，否则 control 类型的失败通知会被 drop 而无法 resolve
    if (message!.reply_to && !message!.expect_reply && message!.session) {
      const pending = this.channels.consumePendingReply(message!.reply_to);
      if (pending) {
        this.channels.updateRemoteSession(message!.from, message!.session);
        this.logger.info(`回复处理：更新 ${message!.from} 的 remoteSession=${message!.session}`);
        pending.resolve(message!.text);
      } else {
        this.logger.info(`回复处理：未找到 pending reply for ${message!.reply_to}`);
      }
      return;
    }

    switch (decision.action) {
      case "drop":
        // 指标分类（TASK-19）：去重命中与其余丢弃分开计数
        
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

    // 入站消息：查找或创建通道
    const [channel, isNewChannel] = this.channels.getOrCreate(message!.from, message!.id);
    const sessionId = channel.localSessionId;
    // AI 工具会话是否已创建（通道可能在握手时已创建，但 AI 工具会话还未创建）
    const needsSession = !channel.sessionCreated;

    if (isNewChannel) {
      this.logger.info(`新发件人 ${message!.from}，创建通道 ${channel.channelId.slice(0, 8)}，本地 session=${sessionId}`);
    } else {
      this.logger.info(`发件人 ${message!.from} 通道已存在，续接 session=${sessionId}${needsSession ? "（AI 会话待创建）" : ""}`);
    }

    if (decision.queued) {
      this.logger.info(decision.reason);
      return;
    }

    void this.runLocked(decision.tool, sessionId, message!, needsSession, channel);
  }

  /** 按 工具|发件人 串行排队（同源同会话回合不重叠）；限速队列续排也走同一入口 */
  private runLocked(tool: string, sessionId: string, msg: BusMessage, isNew: boolean, channel: Channel): void {
    const key = `${tool}|${msg.from}`;
    void this.sessionLock
      .run(key, () => this.injectAndDrain(tool, sessionId, msg, isNew, channel))
      .catch((e: Error) => this.logger.error(`回合链异常: ${e.message}`));
  }

  private async injectAndDrain(tool: string, initialSessionId: string, msg: BusMessage, isNew: boolean, channel: Channel): Promise<void> {
    const cfg = this.opts.config;
    // 信封（4.6/4.7）：沟通定位入站恒只读，参数层与提示层一致
    // Plan 3 问题 1：会话标题优先用快照里的 Agent 名称（如“心语大师”），未命中回退 client_id
    const senderClientId = msg.from.includes("/") ? msg.from.slice(msg.from.indexOf("/") + 1) : msg.from;
    const senderName = lookupAgentName(this.opts.workDir, senderClientId) ?? senderClientId;
  
    // TASK-30 隔离层（可选）：入站回合在 OS 层物理禁写，参数层被绕过时仍安全（无豁免）
    let isolated = false;
    if (cfg.isolation) {
      isolated = await this.isolateAcquire(this.resolveWorkspace(tool));
    }
  
    let output = "";
    let failed = false;
    let failReason = "";
    // 使用可变 sessionId，重试时可更新
    let sessionId = initialSessionId;
    try {
      const handler = this.opts.inject ?? this.defaultInject();
      // 续接会话时允许重试（kilo 那边会话可能已丢失）
      const attempts = isNew ? 1 : 2;
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        // 信封携带通道上下文（使用当前 sessionId）
        const envCtx: EnvelopeContext = {
          sessionId,
          channelId: channel.channelId,
          remoteSessionId: channel.remoteSessionId ?? undefined,
        };
        const envelope = buildEnvelope(msg, envCtx);
        try {
          const turn = await handler({ tool, sessionId, envelope, msg, senderName, isNew });
          output = turn.output;
          // kilo 族会话 id 由 CLI 侧生成：更新通道本地 session
          if (turn.sessionId && turn.sessionId !== sessionId) {
            channel.localSessionId = turn.sessionId;
            sessionId = turn.sessionId; // 同步更新本地变量
            this.logger.info(`${tool} 创建新会话 ${turn.sessionId}，通道 ${channel.channelId.slice(0, 8)} 已更新`);
          }
          // 标记 AI 工具会话已创建
          channel.sessionCreated = true;
          break;
        } catch (e) {
          const errMsg = (e as Error).message;
          // 检测会话类错误：Session not found / Session ID already in use → 回退新建会话
          const isSessionLost = errMsg.includes("Session not found") ||
            (errMsg.includes("session") && errMsg.includes("not")) ||
            errMsg.includes("already in use");
          if (attempt >= attempts || !isSessionLost) throw e;
          // 原会话已丢失/被锁定：回退新建会话重试一次
          const freshId = randomUUID();
          channel.localSessionId = freshId;
          sessionId = freshId; // 同步更新本地变量
          channel.sessionCreated = false; // 重置标记，下次尝试会重新创建
          this.logger.warn(`注入原会话失败（${errMsg}），回退新建会话 ${freshId}`);
          isNew = true;
        }
      }
    } catch (e) {
      failed = true;
      failReason = (e as Error).message;
      this.logger.error(`注入 ${tool} 失败: ${failReason}`);
    } finally {
      if (isolated) this.isolateRelease(this.resolveWorkspace(tool));
    }

    // 回复通道（4.6）：expect_reply=true 时代回输出；失败发 control 通知防对方干等
    // 代回时携带本 daemon 的本地 session ID，让发送方学到并存储到通道
    if (msg.expect_reply) {
      if (failed) {
        void this.publishFailure(msg, failReason, channel.localSessionId).catch((e: Error) =>
          this.logger.warn(`失败通知发送失败: ${e.message}`),
        );
      } else if (output.trim()) {
        void this.publishReply(msg, output, channel).catch((e: Error) =>
          this.logger.warn(`代回发送失败: ${e.message}`),
        );
      } else {
        this.logger.warn(`注入 ${tool} 成功但输出为空，不代回（msg ${msg.id}）`);
      }
    }

    // 消费后按 FIFO 续排下一条
    this.router!.dequeue(msg.from);
  }

  /** 会话工作目录：tools.<工具>.workspace 配置优先，缺省当前目录 */
  private resolveWorkspace(tool: string): string {
    const toolCfg = this.opts.config.tools[tool] ?? {};
    return typeof toolCfg.workspace === "string" ? toolCfg.workspace : process.cwd();
  }

  /** TASK-30：施加隔离（count 0→1 时真正 apply）；同 workspace 的 acquire/release 串行防竞态 */
  private isolateAcquire(ws: string): Promise<boolean> {
    const st = this.isolateStates.get(ws) ?? { count: 0, chain: Promise.resolve() };
    this.isolateStates.set(ws, st);
    const task = st.chain.then(async () => {
      if (st.count === 0) {
        const r = await applyReadonly(ws);
        if (!r.ok) {
          this.logger.warn(`隔离施加失败，降级仅参数层防护: ${r.lines.join("；")}`);
          return false;
        }
      }
      st.count += 1;
      return true;
    });
    st.chain = task.then(() => undefined, () => undefined);
    return task.catch(() => false);
  }

  /** TASK-30：解除隔离（count 归零时真正 remove） */
  private isolateRelease(ws: string): void {
    const st = this.isolateStates.get(ws);
    if (!st) return;
    const task = st.chain.then(async () => {
      st.count = Math.max(0, st.count - 1);
      if (st.count === 0) {
        const r = await removeReadonly(ws);
        if (!r.ok) this.logger.warn(`隔离解除失败（可手动 agentbus isolate remove）: ${r.lines.join("；")}`);
      }
    });
    st.chain = task.then(() => undefined, () => undefined);
  }

  /** 缺省注入器：按工具名选适配器执行真实回合 */
  private defaultInject(): InjectHandler {
    return async (ctx) => {
      const toolCfg = this.opts.config.tools[ctx.tool] ?? {};
      const workspace = this.resolveWorkspace(ctx.tool);
      if (KILO_FAMILY.has(ctx.tool)) {
        const binary = typeof toolCfg.binary === "string" ? toolCfg.binary : ctx.tool;
        const adapter = new OpenCodeKiloAdapter({ binary, workspace });
        // 跨进程文件锁：非阻塞尝试，锁被占用时直接返回"正忙"（不排队等超时）
        const acquired = await tryAcquireAdapterLock();
        if (!acquired) {
          throw new Error("对方 Agent 正忙，正在处理其他请求，请稍后再试");
        }
        try {
        // TASK-27 进阶通道：serve=true 且工具支持 → attach 免冷启动；任何环节失败回退冷启动（可用性优先）
        if (toolCfg.serve === true && adapter.supportsServe()) {
          try {
            const url = await this.serveManager.ensure({
              binary,
              workspace,
              port: typeof toolCfg.serve_port === "number" ? toolCfg.serve_port : 0,
            });
            let turn;
            try {
              turn = ctx.isNew
                ? await adapter.attachCreateSession(url, ctx.envelope, ctx.senderName)
                : await adapter.attachInject(url, ctx.envelope, ctx.sessionId);
            } catch (e) {
              turn = { sessionId: null, output: "", exitCode: -1, timedOut: false, error: (e as Error).message };
            }
            if (!turn.error) {
              return { output: turn.output, sessionId: turn.sessionId ?? undefined };
            }
            this.logger.warn(`attach 回合失败，回退冷启动：${turn.error}`);
          } catch (e) {
            this.logger.warn(`serve 启动失败，回退冷启动：${(e as Error).message}`);
          }
        }
        const turn = ctx.isNew
          ? await adapter.createSession(ctx.envelope, ctx.senderName)
          : await adapter.inject(ctx.envelope, ctx.sessionId);
        if (turn.error) throw new Error(turn.error);
        return { output: turn.output, sessionId: turn.sessionId ?? undefined };
        } finally {
          await releaseAdapterLock();
        }
      }
      // claude：create（--session-id）与 inject（-r）不同命令形态，readonly 走 plan 实测档（TASK-15）
      if (ctx.tool === "claude") {
        const adapter = new ClaudeAdapter({
          binary: typeof toolCfg.binary === "string" ? toolCfg.binary : "claude",
          workspace,
          sessionName: ctx.senderName,
        });
        const turn = ctx.isNew
          ? await adapter.createSession(ctx.envelope, ctx.sessionId)
          : await adapter.injectWith(ctx.envelope, ctx.sessionId);
        if (turn.error) throw new Error(turn.error);
        return { output: turn.output };
      }
      // codex：会话 id 由 CLI 侧生成（JSONL thread.started 提取），-o 文件读最终回复（TASK-16）
      if (ctx.tool === "codex") {
        const adapter = new CodexAdapter({
          binary: typeof toolCfg.binary === "string" ? toolCfg.binary : "codex",
          workspace,
        });
        const turn = ctx.isNew
          ? await adapter.createSession(ctx.envelope)
          : await adapter.injectWith(ctx.envelope, ctx.sessionId);
        if (turn.error) throw new Error(turn.error);
        return { output: turn.output, sessionId: turn.sessionId ?? undefined };
      }
      // hermes：按名建/续同一命令形态（会话名 = 发件人）；remote 段经 SSH 注入远端（TASK-18，架构 5.5）
      if (ctx.tool === "hermes") {
        const adapter = new HermesAdapter({
          binary: typeof toolCfg.binary === "string" ? toolCfg.binary : "hermes",
          workspace,
          remote: parseHermesRemote(toolCfg.remote),
        });
        const turn = ctx.isNew
          ? await adapter.createSession(ctx.envelope, ctx.senderName)
          : await adapter.inject(ctx.envelope, ctx.senderName);
        if (turn.error) throw new Error(turn.error);
        return { output: turn.output };
      }
      // qoder 族（--session-id UUID 幂等语义；但首次用 createSession 更可靠）
      const adapter = new QoderAdapter({
        binary: typeof toolCfg.binary === "string" ? toolCfg.binary : ctx.tool === "qoder" ? "qodercli" : ctx.tool,
        workspace,
        sessionName: ctx.senderName,
      });
      const turn = ctx.isNew
        ? await adapter.createSession(ctx.envelope, ctx.sessionId)
        : await adapter.injectWith(ctx.envelope, ctx.sessionId);
      if (turn.error) throw new Error(turn.error);
      return { output: turn.output };
    };
  }

  private async publishAck(ack: BusMessage): Promise<void> {
    const to = Array.isArray(ack.to) ? ack.to[0] : ack.to;
    const topic = senderTopic(to ?? "");
    if (!topic) {
      this.logger.warn(`ack 丢弃：目标 ${to} 非 ns 形态身份（flat 兼容已删除）`);
      return;
    }
    await this.publish(topic, ack);
    this.logger.info(`ack 已回发 → ${to}（原消息 ${ack.reply_to}）`);
  }

  /** 代回（4.6 步骤 3）：reply_to=原消息 / hop+1 / expect_reply=false 终止互询
   *  session 字段携带本 daemon 的本地 session ID，发送方收到后存储到通道 */
  private async publishReply(original: BusMessage, output: string, channel: Channel): Promise<void> {
    const topic = senderTopic(original.from);
    if (!topic) {
      this.logger.warn(`代回丢弃：发件人 ${original.from} 非 ns 形态身份（flat 兼容已删除）`);
      return;
    }
    // 携带本 daemon 的本地 session ID，让发送方学到
    const reply = makeReply(this.selfIdentity, original, output, channel.localSessionId);
    this.logger.info(`代回构造：selfIdentity=${this.selfIdentity} config.ns=${this.opts.config.ns} reply.from=${reply.from}`);
    await this.publish(topic, reply);
    this.logger.info(`代回已发送 → ${original.from}（原消息 ${original.id}，session=${channel.localSessionId}，${output.length} 字符）`);
  }

  /** 注入失败通知：携带 session 让发送方能匹配到 pendingReply */
  private async publishFailure(original: BusMessage, reason: string, sessionId: string | null): Promise<void> {
    const topic = senderTopic(original.from);
    if (!topic) {
      this.logger.warn(`失败通知丢弃：发件人 ${original.from} 非 ns 形态身份（flat 兼容已删除）`);
      return;
    }
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
      session: sessionId,
      timestamp: new Date().toISOString(),
    };
    await this.publish(topic, notice);
    this.logger.warn(`失败通知已发送 → ${original.from}: ${reason}`);
  }

  private async publish(topic: string, msg: BusMessage): Promise<void> {
    if (!this.listener || !this.listener.isConnected()) {
      throw new Error("MQTT 未连接");
    }
    await this.listener.publish(topic, JSON.stringify(msg));
  }

  private async syncSnapshot(): Promise<void> {
    if (!this.started) return;
    const cfg = this.opts.config;
    if (!cfg.sse_url) return;
    await syncAgentsSnapshot({
      workDir: this.opts.workDir,
      sseUrl: cfg.sse_url,
      ns: cfg.ns,
      username: cfg.broker.username,
      password: cfg.broker.password,
    });
  }

  /** 异步停止：resolve 于 MQTT 关闭完成后（期间仍有 offline 日志），resolve 后 workDir 可安全删除 */
  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.serveManager.stopAll();
    await this.listener?.stop();
    await this.ipcServer?.stop();
    try { unlinkSync(this.ipcFile); } catch { /* ignore */ }
    releasePidLock(this.pidFile);
    this.logger.info("daemon stopped");
  }

  status(): DaemonStatus {
    return {
      running: this.started,
      connected: this.listener?.isConnected() ?? false,
      senderCount: 0, // 简化方案：不再维护本地发件人计数
    };
  }

  /** 出站消息：自动握手 + session 填充 */
  async sendMessage(to: string, text: string, expectReply: boolean, timeoutMs = 30000): Promise<{ status: string; reply?: string }> {
    const toIdentity = to.includes("/") ? to : `${this.opts.config.ns}/${to}`;
    const msgId = newMsgId();

    // 1. 查找或创建通道
    const [channel, isNew] = this.channels.getOrCreate(toIdentity, msgId);

    // 2. 通道未建立：先发 hello，等待 hello_ack
    if (channel.state !== "ESTABLISHED") {
      const helloSent = await this.sendHello(channel);
      if (!helloSent) {
        return { status: "error", reply: `无法发送握手消息到 ${to}` };
      }
      // 等待 hello_ack（带超时）
      try {
        await this.waitForHandshake(toIdentity, timeoutMs);
      } catch (e) {
        return { status: "error", reply: (e as Error).message };
      }
    }

    // 3. 通道已建立：发 text 消息，session 自动填充
    const topic = senderTopic(toIdentity);
    if (!topic) {
      return { status: "error", reply: `无效的目标身份: ${to}` };
    }

    const msg: BusMessage = {
      id: msgId,
      from: this.selfIdentity,
      redirect_client_id: this.selfIdentity,
      to: toIdentity,
      text,
      type: "text",
      reply_to: null,
      hop: 0,
      expect_reply: expectReply,
      session: channel.remoteSessionId,
      timestamp: new Date().toISOString(),
    };

    await this.publish(topic, msg);

    // 4. 如果 expect_reply，注册 pendingReply 等待回复
    if (expectReply) {
      const reply = await this.waitForReply(msgId, timeoutMs);
      return { status: "replied", reply };
    }

    return { status: "sent" };
  }

  private async sendHello(channel: Channel): Promise<boolean> {
    const topic = senderTopic(channel.remote);
    if (!topic) return false;
    if (!this.listener || !this.listener.isConnected()) return false;

    const hello: BusMessage = {
      id: newMsgId(),
      from: this.selfIdentity,
      redirect_client_id: this.selfIdentity,
      to: channel.remote,
      text: "",
      type: "hello",
      reply_to: null,
      hop: 0,
      expect_reply: false,
      session: channel.localSessionId,
      timestamp: new Date().toISOString(),
    };
    await this.publish(topic, hello);
    this.logger.info(`握手消息已发送 → ${channel.remote} session=${channel.localSessionId}`);
    return true;
  }

  /** 收到 hello 后回复 hello_ack：携带本 daemon 的 localSessionId */
  private async sendHelloAck(original: BusMessage, channel: Channel): Promise<void> {
    const topic = senderTopic(original.from);
    if (!topic) {
      this.logger.warn(`hello_ack 丢弃：${original.from} 非 ns 形态身份`);
      return;
    }
    if (!this.listener || !this.listener.isConnected()) return;

    const helloAck: BusMessage = {
      id: newMsgId(),
      from: this.selfIdentity,
      redirect_client_id: this.selfIdentity,
      to: original.from,
      text: "",
      type: "hello_ack",
      reply_to: null,
      hop: original.hop + 1,
      expect_reply: false,
      session: channel.localSessionId,
      timestamp: new Date().toISOString(),
    };
    await this.publish(topic, helloAck);
    this.logger.info(`hello_ack 已发送 → ${original.from} session=${channel.localSessionId}`);
  }

  private waitForHandshake(remote: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.channels.consumePendingHandshake(remote);
        this.logger.warn(`握手超时：${remote}（${timeoutMs}ms）`);
        reject(new Error(`握手超时：${remote}（${timeoutMs}ms）`));
      }, timeoutMs);
      this.channels.trackPendingHandshake(remote, resolve, timer);
    });
  }

  private waitForReply(msgId: string, timeoutMs: number): Promise<string> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.channels.consumePendingReply(msgId);
        resolve("[提示] 对方未及时回复");
      }, timeoutMs);
      this.channels.trackPendingReply(msgId, "", resolve, timer);
    });
  }

  /** 注册 IPC 工具处理器（供桥进程调用） */
  private registerIpcTools(): void {
    if (!this.ipcServer) return;

    this.ipcServer.registerTool("send_message", async (args) => {
      const to = args.to as string;
      const text = args.text as string;
      const waitReply = args.wait_reply as boolean | undefined;
      // IPC 调用超时 5 分钟（AI 推理可能耗时较长）
      const result = await this.sendMessage(to, text, !!waitReply, 600_000);
      return result;
    });

    this.ipcServer.registerTool("list_agents", async () => {
      // 从云端 hub 实时查询 Agent 列表
      const cfg = this.opts.config;
      const agents = await fetchAgentsFromHub({
        sseUrl: cfg.sse_url,
        ns: cfg.ns,
        username: cfg.broker.username,
        password: cfg.broker.password,
      });
      return { agents, status: "ok" };
    });

    this.ipcServer.registerTool("get_status", async () => {
      return this.status();
    });

    this.ipcServer.registerTool("stop_daemon", async () => {
      // 先返回响应，再异步执行停止（MQTT 优雅断开 → broker 清除会话）
      setTimeout(() => {
        void this.stop().finally(() => process.exit(0));
      }, 50);
      return { status: "stopping" };
    });
  }
}
