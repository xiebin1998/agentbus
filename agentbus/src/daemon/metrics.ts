/**
 * TASK-19: Daemon 指标上报（架构二期：通信指标统计）
 *
 * 通道：metric 类 MQTT 消息（架构二期“通道待定”选型）——daemon 周期性 publish 到
 * `/agentbus/ai/metric/<ns>/<client_id>`，hub（server.py）订阅 `/agentbus/ai/metric/#` 汇总，
 * /health 可查各 daemon 指标。不复用消息 topic，避免触发其他 daemon 的路由逻辑。
 */

export type MetricEvent = "injected_ok" | "injected_fail" | "dropped" | "deduped" | "queued";

export interface MetricsSnapshot {
  injected_ok: number;
  injected_fail: number;
  /** 丢弃（白名单拦截/环路熔断/非法消息，不含去重） */
  dropped: number;
  /** 去重命中 */
  deduped: number;
  /** 限速排队次数 */
  queued: number;
  /** 当前会话发件人数（sessions.json） */
  senders: number;
  uptime_s: number;
}

/** 指标上报 topic（与消息 topic 平行命名，hub 通配订阅 /agentbus/ai/metric/#） */
export function metricTopic(ns: string, clientId: string): string {
  return `/agentbus/ai/metric/${ns}/${clientId}`;
}

/** daemon 运行计数器：纯累加，snapshot 时附带即时量（senders/uptime） */
export class MetricsCollector {
  private counts: Record<MetricEvent, number> = {
    injected_ok: 0,
    injected_fail: 0,
    dropped: 0,
    deduped: 0,
    queued: 0,
  };
  private startedAt: number;

  constructor(private now: () => number = Date.now) {
    this.startedAt = now();
  }

  count(event: MetricEvent): void {
    this.counts[event] += 1;
  }

  snapshot(extra: { senders: number }): MetricsSnapshot {
    return {
      ...this.counts,
      senders: extra.senders,
      uptime_s: Math.max(0, Math.floor((this.now() - this.startedAt) / 1000)),
    };
  }
}

/** 上报 payload：type=metric 标识 + from 身份 + metrics 快照（hub 侧按 from 归并）。
 * TASK-32：附带 tools（config.tools 键列表）供 hub 归并注册工具；不带名称/描述/能力（档案走注册/自述通道）。 */
export function buildMetricPayload(
  identity: string,
  collector: MetricsCollector,
  extra: { senders: number; tools?: string[] },
): string {
  return JSON.stringify({
    type: "metric",
    from: identity,
    timestamp: new Date().toISOString(),
    metrics: collector.snapshot(extra),
    ...(extra.tools ? { tools: extra.tools } : {}),
  });
}
