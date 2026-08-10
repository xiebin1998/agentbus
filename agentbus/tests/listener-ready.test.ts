/**
 * TASK-15 顺修: listener 就绪门控（与 hub ready 事件同类竞态，架构 5.3）
 *
 * 缺陷：connect 事件即置 connected/resolve start()，而 subscribe 尚有一个 RTT 未完成，
 * 此时发布的消息会丢（首连无持久会话可补投）。
 * 修法：connected 与 start() 一律门控到 SUBACK 回调之后。
 * 确定性复现：包裹 broker.subscribe 延迟 SUBACK 300ms。
 */
import { createServer, type Server } from "node:net";
import aedes from "aedes";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createListener } from "../src/daemon/listener.js";

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

describe("listener 就绪门控", () => {
  it("SUBACK 前 isConnected=false；start() 解析后即 true 且消息可达", async () => {
    // 延迟 SUBACK 300ms，把竞态窗口撑开成确定性断言
    const origSubscribe = broker.subscribe.bind(broker) as (
      subs: unknown, client: unknown, cb: (err?: Error) => void,
    ) => void;
    let subAcked = false;
    (broker as unknown as Record<string, unknown>).subscribe = (
      subs: unknown, client: unknown, cb: (err?: Error) => void,
    ) => {
      setTimeout(() => {
        origSubscribe(subs, client, (err?: Error) => {
          subAcked = true;
          cb(err);
        });
      }, 300);
    };

    const topic = "/agentbus/ai/channel/default/gate-test/message";
    const received: string[] = [];
    const listener = createListener({
      broker: { host: "127.0.0.1", port },
      clientId: "agentbus-gate-test",
      topic,
      onMessage: (p) => received.push(p),
    });

    const started = listener.start();
    // connect 已建立但 SUBACK 未到：不得报就绪
    await new Promise((r) => setTimeout(r, 100));
    expect(subAcked).toBe(false);
    expect(listener.isConnected()).toBe(false);

    await started; // start() 必须等到 SUBACK 才解析
    expect(subAcked).toBe(true);
    expect(listener.isConnected()).toBe(true);

    // 就绪后发布必达
    await new Promise<void>((resolve) =>
      broker.publish({ cmd: "publish", topic, payload: "hi", qos: 1, retain: false, dup: false }, () => resolve()),
    );
    await new Promise((r) => setTimeout(r, 200));
    expect(received).toEqual(["hi"]);

    await listener.stop();
  });
});
