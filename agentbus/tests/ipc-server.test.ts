import { describe, it, expect } from "vitest";
import { IpcServer } from "../src/daemon/ipc-server.js";
import { Socket } from "node:net";

describe("IpcServer", () => {
  it("starts and reports address", async () => {
    const server = new IpcServer({ port: 0 });
    await server.start();
    expect(server.address).toBeTruthy();
    expect(server.address).toMatch(/127\.0\.0\.1:\d+/);
    await server.stop();
  });

  it("handles registered tool calls", async () => {
    const server = new IpcServer({ port: 0 });
    server.registerTool("echo", async (args) => ({ echoed: args.text }));
    await server.start();

    const result = await callIpc(server.address!, "echo", { text: "hello" });
    expect(result).toEqual({ echoed: "hello" });

    await server.stop();
  });

  it("returns error for unknown tool", async () => {
    const server = new IpcServer({ port: 0 });
    await server.start();

    const result = await callIpcRaw(server.address!, "unknown", {});
    expect(result.error).toContain("Unknown tool");

    await server.stop();
  });

  it("stops cleanly", async () => {
    const server = new IpcServer({ port: 0 });
    await server.start();
    await server.stop();
    // Starting again should work
    await server.start();
    await server.stop();
  });
});

// Helper: connect to IPC server, send request, get result
function callIpc(
  address: string,
  method: string,
  params: Record<string, unknown>,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const [host, port] = address.split(":");
    const socket = new Socket();
    let buffer = "";
    socket.connect(Number(port), host, () => {
      socket.write(JSON.stringify({ id: 1, method, params }) + "\n");
    });
    socket.on("data", (data) => {
      buffer += data.toString();
      if (buffer.includes("\n")) {
        const resp = JSON.parse(buffer.trim());
        socket.destroy();
        resolve(resp.result);
      }
    });
    socket.on("error", reject);
  });
}

function callIpcRaw(
  address: string,
  method: string,
  params: Record<string, unknown>,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const [host, port] = address.split(":");
    const socket = new Socket();
    let buffer = "";
    socket.connect(Number(port), host, () => {
      socket.write(JSON.stringify({ id: 1, method, params }) + "\n");
    });
    socket.on("data", (data) => {
      buffer += data.toString();
      if (buffer.includes("\n")) {
        const resp = JSON.parse(buffer.trim());
        socket.destroy();
        resolve(resp);
      }
    });
    socket.on("error", reject);
  });
}
