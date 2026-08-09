#!/usr/bin/env node
/**
 * TASK-13: 开发用独立 MQTT broker（aedes 进程内，无需 Docker/mosquitto）
 * 用法：node scripts/dev-broker.mjs [port]（默认 18830）
 */
import { createServer } from "node:net";
import aedes from "aedes";

const port = Number(process.argv[2] ?? 18830);
const broker = aedes();
const server = createServer(broker.handle);

server.listen(port, () => {
  console.log(`[dev-broker] aedes listening on ${port}`);
});

broker.on("client", (client) => console.log(`[dev-broker] client connected: ${client.id}`));
broker.on("clientDisconnect", (client) => console.log(`[dev-broker] client disconnected: ${client.id}`));

process.on("SIGINT", () => {
  broker.close(() => server.close(() => process.exit(0)));
});
