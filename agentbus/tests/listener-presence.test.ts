/**
 * presence 在线态：LWT 遗嘱（retained offline）+ 连接就绪发 online（retained）+ stop 发 offline。
 * broker 用 aedes（同 listener-ready.test.ts 的搭法）。
 */
import { createServer, type Server } from "node:net";
import aedes from "aedes";
import mqtt, { type MqttClient } from "mqtt";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildConnectOptions, createListener } from "../src/daemon/listener.js";

let broker: aedes.Aedes;
let server: Server;
let port: number;

beforeAll(async () => {
  broker = aedes();
  server = createServer(broker.handle);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => broker.close(() => resolve()));
  server.close();
});

const PRESENCE = { topic: "/agentbus/ai/status/default/p-test", identity: "default/p-test" };

/** 建立 presence 观察者：连接+订阅均就绪后返回首条消息 Promise（避免与发布者竞态） */
function watchPresence(topic: string): { first: Promise<{ topic: string; payload: string; retain: boolean }>; end: () => void } {
  const sub: MqttClient = mqtt.connect(`mqtt://127.0.0.1:${port}`, { clientId: `watch-${Math.random().toString(36).slice(2)}` });
  const first = new Promise<{ topic: string; payload: string; retain: boolean }>((resolve) => {
    sub.on("connect", () => sub.subscribe(topic));
    sub.once("message", (t, payload, packet) => {
      resolve({ topic: t, payload: payload.toString("utf-8"), retain: packet.retain });
    });
  });
  return { first, end: () => sub.end() };
}

/** 持续观察 presence topic，每条消息触发 onMessage（不自动关闭） */
function watchEndless(topic: string, onMessage: (m: { topic: string; payload: string; retain: boolean }) => void): MqttClient {
  const sub: MqttClient = mqtt.connect(`mqtt://127.0.0.1:${port}`, { clientId: `watch-${Math.random().toString(36).slice(2)}` });
  sub.on("connect", () => sub.subscribe(topic));
  sub.on("message", (t, payload, packet) => {
    onMessage({ topic: t, payload: payload.toString("utf-8"), retain: packet.retain });
  });
  return sub;
}

describe("buildConnectOptions presence", () => {
  it("带 presence：注册 retained offline 遗嘱 + keepalive=30；不带则与现状一致", () => {
    const withP = buildConnectOptions({ host: "h", port: 1 }, PRESENCE);
    expect(withP.keepalive).toBe(30);
    expect(withP.will).toMatchObject({ topic: PRESENCE.topic, qos: 1, retain: true });
    const willPayload = JSON.parse(String(withP.will!.payload));
    expect(willPayload.type).toBe("presence");
    expect(willPayload.state).toBe("offline");
    expect(willPayload.identity).toBe(PRESENCE.identity);
    const without = buildConnectOptions({ host: "h", port: 1 });
    expect(without.will).toBeUndefined();
    expect(without.keepalive).toBeUndefined();
  });
});

describe("listener presence 生命周期", () => {
  it("连接就绪发 retained online（新订阅者收到 retain=true 副本）；stop() 发 graceful offline", async () => {
    const listener = createListener({
      broker: { host: "127.0.0.1", port },
      clientId: "agentbus-p-test",
      topic: "/agentbus/ai/channel/default/p-test/message",
      onMessage: () => {},
      presence: PRESENCE,
    });
    await listener.start();
    // online 已在 broker retained 存储：新观察者订阅即收到 retain=true 副本
    const watch = watchPresence(PRESENCE.topic);
    const retained = await watch.first;
    const op = JSON.parse(retained.payload);
    expect(op.type).toBe("presence");
    expect(op.state).toBe("online");
    expect(op.identity).toBe(PRESENCE.identity);
    expect(retained.retain).toBe(true);

    // 优雅停止：观察者收到 live offline（graceful_stop）
    let offlineWatcher: MqttClient | null = null;
    const offlineSeen = new Promise<{ payload: string }>((resolve) => {
      offlineWatcher = watchEndless(PRESENCE.topic, (m) => {
        const p = JSON.parse(m.payload);
        if (p.state === "offline") resolve({ payload: m.payload });
      });
    });
    await listener.stop();
    const offline = await offlineSeen;
    const fp = JSON.parse(offline.payload);
    expect(fp.state).toBe("offline");
    expect(fp.reason).toBe("graceful_stop");
    watch.end();
    offlineWatcher!.end();
  });

  it("异常掉线（broker 侧踢断连接）→ LWT 遗嘱发 offline", async () => {
    const listener = createListener({
      broker: { host: "127.0.0.1", port },
      clientId: "agentbus-p-lwt",
      topic: "/agentbus/ai/channel/default/p-lwt/message",
      onMessage: () => {},
      presence: { topic: "/agentbus/ai/status/default/p-lwt", identity: "default/p-lwt" },
    });
    await listener.start();
    // 订阅者先就位，再从 broker 侧断开 daemon 的连接（模拟进程被杀/断网）
    const willSeen = new Promise<string>((resolve) => {
      const sub = mqtt.connect(`mqtt://127.0.0.1:${port}`, { clientId: "lwt-watch" });
      sub.on("connect", () => sub.subscribe("/agentbus/ai/status/default/p-lwt"));
      sub.on("message", (_t, payload) => {
        const p = JSON.parse(payload.toString("utf-8"));
        if (p.state === "offline") { sub.end(); resolve(p.reason); }
      });
    });
    await new Promise((r) => setTimeout(r, 200)); // 确保订阅就位
    for (const client of Object.values(broker.clients) as { id: string; close: () => void }[]) {
      if (client.id === "agentbus-p-lwt") client.close(); // broker 侧断开 → 触发 LWT
    }
    const reason = await Promise.race([
      willSeen,
      new Promise<string>((_, rej) => setTimeout(() => rej(new Error("LWT 未在窗口内到达")), 3000)),
    ]);
    expect(reason).toBe("unexpected_disconnect");
    await listener.stop().catch(() => {});
  });
});
