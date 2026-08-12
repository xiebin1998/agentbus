/** daemon 装配：listener 工厂必须收到 presence（topic=/agentbus/ai/status/<ns>/<cid>） */
import { expect, it } from "vitest";
import { Daemon } from "../src/daemon/daemon.js";
import { presenceTopic } from "../src/daemon/metrics.js";
import type { ListenerOptions } from "../src/daemon/listener.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

it("presenceTopic 与 metricTopic 平行命名", () => {
  expect(presenceTopic("iot", "ag-1")).toBe("/agentbus/ai/status/iot/ag-1");
});

it("daemon start 向 listener 传 presence（身份与 topic 一致）", () => {
  let captured: ListenerOptions | null = null;
  const d = new Daemon({
    config: { client_id: "ag-1", ns: "iot", broker: { host: "127.0.0.1", port: 1 }, tools: {}, ack: false } as never,
    workDir: mkdtempSync(join(tmpdir(), "agentbus-presence-")),
    listenerFactory: (opts) => {
      captured = opts;
      return {
        start: async () => {}, stop: async () => {},
        publish: async () => {}, isConnected: () => false,
      };
    },
    onExit: () => {},
  });
  d.start();
  expect(captured!.presence).toEqual({ topic: "/agentbus/ai/status/iot/ag-1", identity: "iot/ag-1" });
});
