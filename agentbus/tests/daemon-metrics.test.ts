/**
 * TASK-19: Daemon 指标上报（架构二期：通信指标统计）
 * 通道选型：metric 类 MQTT 消息 —— daemon 周期性 publish 到
 * `/agentbus/ai/metric/<ns>/<client_id>`，hub（server.py）订阅 `/agentbus/ai/metric/#` 汇总可查。
 * 本文件覆盖纯逻辑层：计数器、topic 构造、payload 装配。
 */
import { describe, expect, it } from "vitest";
import { MetricsCollector, buildMetricPayload, metricTopic } from "../src/daemon/metrics.js";

describe("metricTopic", () => {
  it("ns 形态：/agentbus/ai/metric/<ns>/<client_id>", () => {
    expect(metricTopic("iot", "fe-zhangsan")).toBe("/agentbus/ai/metric/iot/fe-zhangsan");
  });
});

describe("MetricsCollector", () => {
  it("初始全零；count 累加各事件", () => {
    const c = new MetricsCollector();
    const s0 = c.snapshot({ senders: 0 });
    expect(s0.injected_ok).toBe(0);
    expect(s0.injected_fail).toBe(0);
    expect(s0.dropped).toBe(0);
    expect(s0.deduped).toBe(0);
    expect(s0.queued).toBe(0);

    c.count("injected_ok");
    c.count("injected_ok");
    c.count("injected_fail");
    c.count("dropped");
    c.count("deduped");
    c.count("queued");
    const s = c.snapshot({ senders: 3 });
    expect(s.injected_ok).toBe(2);
    expect(s.injected_fail).toBe(1);
    expect(s.dropped).toBe(1);
    expect(s.deduped).toBe(1);
    expect(s.queued).toBe(1);
    expect(s.senders).toBe(3);
  });

  it("uptime_s 按注入时钟计算", () => {
    let t = 1_000_000;
    const c = new MetricsCollector(() => t);
    t += 65_000;
    expect(c.snapshot({ senders: 0 }).uptime_s).toBe(65);
  });
});

describe("buildMetricPayload", () => {
  it("payload 结构：type=metric + from 身份 + timestamp + metrics 快照", () => {
    let t = 1_700_000_000_000;
    const c = new MetricsCollector(() => t);
    c.count("injected_ok");
    const payload = JSON.parse(buildMetricPayload("iot/fe-a", c, { senders: 2 })) as Record<string, unknown>;
    expect(payload.type).toBe("metric");
    expect(payload.from).toBe("iot/fe-a");
    expect(typeof payload.timestamp).toBe("string");
    const metrics = payload.metrics as Record<string, number>;
    expect(metrics.injected_ok).toBe(1);
    expect(metrics.senders).toBe(2);
  });
});
