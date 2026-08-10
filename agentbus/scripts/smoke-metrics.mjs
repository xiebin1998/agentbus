#!/usr/bin/env node
/**
 * TASK-19 真机端到端冒烟：daemon 指标 → MQTT → hub /health 可查
 * 用法：node scripts/smoke-metrics.mjs [brokerPort] [hubUrl]
 * 步骤：起短间隔（2s）指标的冒烟 daemon → 外部 mqtt 客户端发
 *   ① 正常消息（injected_ok）② 同 id 重发（deduped）③ 缺 from 的非法消息（dropped/invalid）
 * → 轮询 hub /health 断言 daemon_metrics 含本 daemon 身份与计数。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import mqtt from "mqtt";
import { Daemon } from "../dist/daemon/daemon.js";

const port = Number(process.argv[2] ?? 18830);
const hubUrl = process.argv[3] ?? "http://localhost:8000/health";
const clientId = "smoke-metrics";
const msgTopic = `/agenthub/ai/channel/default/${clientId}/message`;

const daemon = new Daemon({
  config: {
    client_id: clientId,
    ns: "default",
    broker: { host: "127.0.0.1", port },
    default_tool: "kilo",
    allowed_senders: [],
    hop_limit: 3,
    rate_limit: 100,
    inbound_mode: "readonly",
    trust_map: {},
    tools: { kilo: {} },
    ack: true,
  },
  workDir: mkdtempSync(join(tmpdir(), "agentbus-smoke-metrics-")),
  inject: async (ctx) => {
    console.log(`[smoke-metrics] 注入: from=${ctx.msg.from} text=${ctx.msg.text}`);
    return { output: `收到「${ctx.msg.text}」` };
  },
  metricIntervalMs: 2_000,
});

const result = daemon.start();
if (!result.started) {
  console.error(`[smoke-metrics] 启动失败: ${result.reason}`);
  process.exit(1);
}
console.log(`[smoke-metrics] daemon 已启动（指标间隔 2s），等 MQTT 就绪后发测试消息`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sender = mqtt.connect({ host: "127.0.0.1", port, clientId: "metrics-smoke-sender", protocolVersion: 4 });
await new Promise((res, rej) => {
  sender.once("connect", res);
  sender.once("error", rej);
  setTimeout(() => rej(new Error("sender MQTT 连接超时")), 10_000);
});
console.log("[smoke-metrics] sender 已连上 broker");

// ① 正常消息 → injected_ok
sender.publish(msgTopic, JSON.stringify({ id: "mm-1", from: "default/test-sender", text: "指标冒烟", hop: 0 }), { qos: 2 });
await sleep(3_000);
// ② 同 id 重发 → deduped
sender.publish(msgTopic, JSON.stringify({ id: "mm-1", from: "default/test-sender", text: "指标冒烟", hop: 0 }), { qos: 2 });
// ③ 合法 JSON 但缺 from → router drop(invalid) → dropped
sender.publish(msgTopic, JSON.stringify({ id: "mm-3", text: "无发件人" }), { qos: 2 });
await sleep(3_000); // 至少再等一个上报周期

// 轮询 hub /health
let health = null;
for (let i = 0; i < 5; i++) {
  const res = await fetch(hubUrl);
  health = await res.json();
  if (Object.keys(health.daemon_metrics ?? {}).length > 0) break;
  await sleep(2_000);
}

const identity = `default/${clientId}`;
const entry = health?.daemon_metrics?.[identity];
console.log("[smoke-metrics] /health.daemon_metrics =", JSON.stringify(health?.daemon_metrics, null, 2));

const failures = [];
if (!entry) failures.push(`daemon_metrics 中缺少身份 ${identity}`);
else {
  if (entry.metrics.injected_ok < 1) failures.push(`injected_ok=${entry.metrics.injected_ok}，期望 ≥1`);
  if (entry.metrics.deduped < 1) failures.push(`deduped=${entry.metrics.deduped}，期望 ≥1`);
  if (entry.metrics.dropped < 1) failures.push(`dropped=${entry.metrics.dropped}，期望 ≥1`);
  if (typeof entry.metrics.uptime_s !== "number") failures.push("缺少 uptime_s");
  if (entry.report_count < 2) failures.push(`report_count=${entry.report_count}，期望 ≥2（周期上报）`);
}

sender.end(true);
daemon.stop();

if (failures.length > 0) {
  console.error(`[smoke-metrics] 冒烟失败：\n  - ${failures.join("\n  - ")}`);
  process.exit(1);
}
console.log(`[smoke-metrics] 冒烟通过：${identity} → injected_ok=${entry.metrics.injected_ok} deduped=${entry.metrics.deduped} dropped=${entry.metrics.dropped} report_count=${entry.report_count}`);
process.exit(0);
