import { describe, it, expect } from "vitest";
import { McpBridge } from "../src/daemon/mcp-bridge.js";
import { IpcServer } from "../src/daemon/ipc-server.js";

describe("McpBridge", () => {
  it("handles initialize request", async () => {
    const bridge = new McpBridge({ daemonAddress: "127.0.0.1:9999" });
    const resp = await bridge.handleRequest(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      }),
    );
    const parsed = JSON.parse(resp);
    expect(parsed.result.protocolVersion).toBe("2024-11-05");
    expect(parsed.result.serverInfo.name).toBe("agentbus");
  });

  it("handles tools/list request", async () => {
    const bridge = new McpBridge({ daemonAddress: "127.0.0.1:9999" });
    const resp = await bridge.handleRequest(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      }),
    );
    const parsed = JSON.parse(resp);
    expect(parsed.result.tools.length).toBeGreaterThan(0);
    expect(parsed.result.tools[0].name).toBe("send_message");
  });

  it("forwards tools/call to daemon via IPC", async () => {
    // Start a mock IPC server
    const server = new IpcServer({ port: 0 });
    server.registerTool("send_message", async (args) => ({
      status: "sent",
      to: args.to,
    }));
    await server.start();

    const bridge = new McpBridge({ daemonAddress: server.address! });
    await bridge.connect();

    const resp = await bridge.handleRequest(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "send_message", arguments: { to: "bob", text: "hi" } },
      }),
    );
    const parsed = JSON.parse(resp);
    expect(parsed.result.status).toBe("sent");

    await bridge.disconnect();
    await server.stop();
  });
});
