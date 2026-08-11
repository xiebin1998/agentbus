/**
 * TASK-32 Task 8: listener 断连指纹（身份冲突互踢检测）
 *
 * 契约：60s 内非主动 stop 断连 ≥3 次 → reconnectPeriod=0（停止重连）
 * + onStatus("identity_conflict", 指引文案)；偶发断连不误判。
 */
import { createServer, type Server } from "node:net";
import aedes from "aedes";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createListener, disconnectConflict } from "../src/daemon/listener.js";

describe("disconnectConflict 指纹判定（纯函数）", () => {
  it("60s 窗口内 ≥3 次断连 → true", () => {
    const now = 100_000;
    expect(disconnectConflict([now - 50_000, now - 20_000, now], now)).toBe(true);
  });
  it("窗口内仅 2 次 → false", () => {
    const now = 100_000;
    expect(disconnectConflict([now - 50_000, now], now)).toBe(false);
  });
  it("第 3 次落在窗口外（滑出）→ false", () => {
    const now = 100_000;
    expect(disconnectConflict([now - 61_000, now - 30_000, now - 10_000], now, 60_000, 3)).toBe(false);
  });
  it("空记录 → false", () => {
    expect(disconnectConflict([], Date.now())).toBe(false);
  });
});

type AedesClient = { close: (cb?: () => void) => void };

describe("listener 互踢指纹（真机 aedes）", () => {
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

  it("同 clientId 互踢：先达阈一方报 identity_conflict 并停重连，另一方不误判", async () => {
    const mkStatus = () => {
      const statuses: Array<{ s: string; detail?: string }> = [];
      return {
        statuses,
        onStatus: (s: string, detail?: string) => statuses.push({ s, detail }),
      };
    };
    const a = mkStatus();
    const b = mkStatus();
    const topic = "/agentbus/ai/channel/default/conflict/message";
    const la = createListener({
      broker: { host: "127.0.0.1", port },
      clientId: "agentbus-conflict-dup",
      topic,
      onMessage: () => {},
      onStatus: a.onStatus as never,
      reconnectPeriodMs: 100,
    });
    const lb = createListener({
      broker: { host: "127.0.0.1", port },
      clientId: "agentbus-conflict-dup",
      topic,
      onMessage: () => {},
      onStatus: b.onStatus as never,
      reconnectPeriodMs: 100,
    });
    await la.start();
    await lb.start();

    const deadline = Date.now() + 10_000;
    // 互踢动力学：先达 3 次断连的一方判冲突停连，另一方保住连接（断连不足 3 次不误判）
    const conflicted = () =>
      a.statuses.some((x) => x.s === "identity_conflict") ||
      b.statuses.some((x) => x.s === "identity_conflict");
    while (!conflicted() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(conflicted()).toBe(true);
    // 指引文案含修复手段
    const hit = a.statuses.find((x) => x.s === "identity_conflict") ?? b.statuses.find((x) => x.s === "identity_conflict");
    expect(hit?.detail ?? "").toMatch(/client_id/);

    // 冲突后停重连：再等 600ms 不再出现 reconnecting
    const reconnectsAt = () =>
      a.statuses.filter((x) => x.s === "reconnecting").length +
      b.statuses.filter((x) => x.s === "reconnecting").length;
    const before = reconnectsAt();
    await new Promise((r) => setTimeout(r, 600));
    expect(reconnectsAt()).toBe(before);

    await la.stop();
    await lb.stop();
  }, 15_000);

  it("偶发断连（2 次，broker 侧主动关闭）不误判", async () => {
    const statuses: Array<{ s: string; detail?: string }> = [];
    const listener = createListener({
      broker: { host: "127.0.0.1", port },
      clientId: "agentbus-occasional",
      topic: "/agentbus/ai/channel/default/occasional/message",
      onMessage: () => {},
      onStatus: ((s: string, detail?: string) => statuses.push({ s, detail })) as never,
      reconnectPeriodMs: 100,
    });
    await listener.start();

    for (let i = 0; i < 2; i++) {
      // broker 侧关闭该客户端连接 → 客户端重连（计 1 次断连）
      const clients = (broker as unknown as { clients: Record<string, AedesClient> }).clients;
      clients["agentbus-occasional"]?.close();
      const deadline = Date.now() + 5_000;
      while (!listener.isConnected() && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(listener.isConnected()).toBe(true);
    }
    expect(statuses.some((x) => x.s === "identity_conflict")).toBe(false);
    await listener.stop();
  }, 15_000);
});
