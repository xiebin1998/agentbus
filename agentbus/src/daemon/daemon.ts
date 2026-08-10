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
import { HermesAdapter, type HermesRemoteConfig } from "../adapters/hermes.js";
import { CodexAdapter } from "../adapters/codex.js";
import { createListener, type Listener } from "./listener.js";
import { RotatingLogger } from "./logger.js";
import { MetricsCollector, buildMetricPayload, metricTopic } from "./metrics.js";
import { acquirePidLock, releasePidLock } from "./pid.js";
import { QueueManager } from "./queue.js";
import { knownSenders, loadRegistry, saveRegistry, touchSession, type RegistryData } from "./registry.js";
import { Router, type RouterConfig } from "./router.js";
import { ServeManager } from "./serve-manager.js";
import { SessionLock } from "./session-lock.js";
import { buildEnvelope } from "./envelope.js";
import { resolveTrust } from "./trust.js";
import { applyReadonly, removeReadonly } from "../isolate.js";

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
  /** 指标上报周期（TASK-19；默认 30s，测试可注入短间隔） */
  metricIntervalMs?: number;
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
  if (slash < 0) return `/agenthub/ai/channel/${from}/message`;
  return `/agenthub/ai/channel/${from.slice(0, slash)}/${from.slice(slash + 1)}/message`;
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
  private registry: RegistryData | null = null;
  private queues = new QueueManager<QueueItem>(20);
  /** TASK-29：同一发件人在同一工具的回合串行（并发不串话）；异会话并行 */
  private sessionLock = new SessionLock();
  /** TASK-30：隔离引用计数（同 workspace 并发回合共享隔离，归零才解除） */
  private isolateStates = new Map<string, { count: number; chain: Promise<void> }>();
  private serveManager = new ServeManager({ warn: (m) => this.logger.warn(m) });
  private logger: RotatingLogger;
  private metrics = new MetricsCollector();
  private metricTimer: ReturnType<typeof setInterval> | null = null;
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
    const topic = `/agenthub/ai/channel/${cfg.ns}/${cfg.client_id}/message`;
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

    // 5. 指标上报（TASK-19）：启动即报一次 + 周期上报；未就绪时静默跳过，下周期重试
    const interval = this.opts.metricIntervalMs ?? 30_000;
    this.started = true;
    this.publishMetric();
    this.metricTimer = setInterval(() => this.publishMetric(), interval);

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
        // 指标分类（TASK-19）：去重命中与其余丢弃分开计数
        this.metrics.count(decision.kind === "dedup" ? "deduped" : "dropped");
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
      this.metrics.count("queued");
      // 限速溢出：进 FIFO 队列；满则逐出最旧（落日志）
      const { evicted } = this.queues.push(decision.tool, { tool: decision.tool, sessionId: entry.sessionId, msg: message! });
      if (evicted) this.logger.warn(`队列已满，逐出最旧消息 id=${evicted.msg.id}`);
      this.logger.info(`${decision.reason}（当前队列深度 ${this.queues.depth(decision.tool)}）`);
      return;
    }

    void this.runLocked(decision.tool, entry.sessionId, message!, isNew);
  }

  /** 按 工具|发件人 串行排队（同源同会话回合不重叠）；限速队列续排也走同一入口 */
  private runLocked(tool: string, sessionId: string, msg: BusMessage, isNew: boolean): void {
    const key = `${tool}|${msg.from}`;
    void this.sessionLock
      .run(key, () => this.injectAndDrain(tool, sessionId, msg, isNew))
      .catch((e: Error) => this.logger.error(`回合链异常: ${e.message}`));
  }

  private async injectAndDrain(tool: string, sessionId: string, msg: BusMessage, isNew: boolean): Promise<void> {
    const cfg = this.opts.config;
    // 信任分级 + 信封（4.6/4.7）：参数层与提示层一致
    const mode = resolveTrust(msg.from, cfg.inbound_mode, cfg.trust_map);
    const envelope = buildEnvelope(msg, mode);
    const senderName = msg.from.includes("/") ? msg.from.slice(msg.from.indexOf("/") + 1) : msg.from;

    // TASK-30 隔离层（可选）：readonly 回合在 OS 层物理禁写，参数层被绕过时仍安全
    let isolated = false;
    if (cfg.isolation && mode === "readonly") {
      isolated = await this.isolateAcquire(this.resolveWorkspace(tool));
    }

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
    } finally {
      if (isolated) this.isolateRelease(this.resolveWorkspace(tool));
    }
    // 注入结果计数（TASK-19：注入成功率指标源）
    this.metrics.count(failed ? "injected_fail" : "injected_ok");

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
    if (next) this.runLocked(next.tool, next.sessionId, next.msg, false);
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
      // codex：会话 id 由 CLI 侧生成（JSONL thread.started 提取），-o 文件读最终回复（TASK-16）
      if (ctx.tool === "codex") {
        const adapter = new CodexAdapter({
          binary: typeof toolCfg.binary === "string" ? toolCfg.binary : "codex",
          workspace,
        });
        const turn = ctx.isNew
          ? await adapter.createSession(ctx.envelope, ctx.mode)
          : await adapter.injectWith(ctx.envelope, ctx.sessionId, ctx.mode);
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
          ? await adapter.createSession(ctx.envelope, ctx.senderName, ctx.mode)
          : await adapter.inject(ctx.envelope, ctx.senderName, ctx.mode);
        if (turn.error) throw new Error(turn.error);
        return { output: turn.output };
      }
      // qoder 族（--session-id UUID 幂等语义）
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

  /** 指标上报（TASK-19）：publish 到 /agenthub/ai/metric/<ns>/<client_id>；连接未就绪静默跳过 */
  private publishMetric(): void {
    if (!this.started || !this.listener || !this.listener.isConnected()) return;
    const cfg = this.opts.config;
    const senders = this.registry ? Object.keys(this.registry.senders).length : 0;
    const payload = buildMetricPayload(this.selfIdentity, this.metrics, { senders });
    void this.listener.publish(metricTopic(cfg.ns, cfg.client_id), payload).catch((e: Error) =>
      this.logger.warn(`指标上报失败: ${e.message}`),
    );
  }

  /** 异步停止：resolve 于 MQTT 关闭完成后（期间仍有 offline 日志），resolve 后 workDir 可安全删除 */
  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false; // 先行置位：幂等防重入，关闭期间的日志照常落盘
    if (this.metricTimer) {
      clearInterval(this.metricTimer);
      this.metricTimer = null;
    }
    this.serveManager.stopAll();
    await this.listener?.stop();
    releasePidLock(this.pidFile);
    this.logger.info("daemon stopped");
  }

  status(): DaemonStatus {
    return {
      running: this.started,
      connected: this.listener?.isConnected() ?? false,
      senderCount: this.registry ? Object.keys(this.registry.senders).length : 0,
    };
  }
}
