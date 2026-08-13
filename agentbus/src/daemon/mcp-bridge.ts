import { Socket } from "node:net";

export interface McpBridgeOptions {
  daemonAddress: string; // e.g. "127.0.0.1:12345"
}

export class McpBridge {
  private socket: Socket | null = null;
  private pendingRequests = new Map<
    number,
    { resolve: (data: string) => void; reject: (err: Error) => void }
  >();
  private buffer = "";

  constructor(private opts: McpBridgeOptions) {}

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const [host, portStr] = this.opts.daemonAddress.split(":");
      const port = Number(portStr);
      this.socket = new Socket();

      this.socket.on("data", (data) => {
        this.buffer += data.toString();
        const lines = this.buffer.split("\n");
        this.buffer = lines.pop() || "";
        for (const line of lines) {
          if (line.trim()) this.handleResponse(line);
        }
      });

      this.socket.on("error", (err) => {
        reject(err);
      });

      this.socket.connect(port, host, () => resolve());
    });
  }

  async handleRequest(input: string): Promise<string> {
    let req: Record<string, unknown>;
    try {
      req = JSON.parse(input);
    } catch {
      return JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32700, message: "Parse error" },
      });
    }

    // Handle MCP protocol methods locally
    if (req.method === "initialize") {
      return JSON.stringify({
        jsonrpc: "2.0",
        id: req.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "agentbus", version: "1.0.0" },
        },
      });
    }

    if (req.method === "notifications/initialized") {
      return ""; // No response for notifications
    }

    if (req.method === "tools/list") {
      return JSON.stringify({
        jsonrpc: "2.0",
        id: req.id,
        result: {
          tools: [
            {
              name: "send_message",
              description: "Send message to another agent",
              inputSchema: {
                type: "object",
                properties: {
                  to: { type: "string" },
                  text: { type: "string" },
                  wait_reply: { type: "boolean" },
                },
                required: ["to", "text"],
              },
            },
            {
              name: "list_agents",
              description: "List online agents",
              inputSchema: { type: "object", properties: {} },
            },
            {
              name: "get_status",
              description: "Get daemon status",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        },
      });
    }

    // Forward tool calls to daemon via IPC
    if (req.method === "tools/call") {
      if (!this.socket) await this.connect();
      return this.forwardToDaemon(req);
    }

    return JSON.stringify({ jsonrpc: "2.0", id: req.id, result: {} });
  }

  private forwardToDaemon(req: Record<string, unknown>): Promise<string> {
    return new Promise((resolve) => {
      const params = (req.params ?? {}) as Record<string, unknown>;
      const toolName = params.name as string;
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const reqId = req.id as number;

      const ipcReq = JSON.stringify({
        id: reqId,
        method: toolName,
        params: args,
      });

      this.socket!.write(ipcReq + "\n");

      // Timeout after 5 min (AI inference can be slow)
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(reqId);
        resolve(
          JSON.stringify({
            jsonrpc: "2.0",
            id: reqId,
            error: { code: -32603, message: "IPC timeout" },
          }),
        );
      }, 300_000);

      this.pendingRequests.set(reqId, {
        resolve: (data) => {
          clearTimeout(timeout);
          resolve(data);
        },
        reject: (err) => {
          clearTimeout(timeout);
          resolve(
            JSON.stringify({
              jsonrpc: "2.0",
              id: reqId,
              error: { code: -32603, message: err.message },
            }),
          );
        },
      });
    });
  }

  private handleResponse(line: string): void {
    try {
      const resp = JSON.parse(line) as Record<string, unknown>;
      const id = resp.id as number;
      const pending = this.pendingRequests.get(id);
      if (pending) {
        this.pendingRequests.delete(id);
        const jsonRpcResp = resp.error
          ? JSON.stringify({
              jsonrpc: "2.0",
              id,
              error: { code: -32603, message: resp.error },
            })
          : JSON.stringify({
              jsonrpc: "2.0",
              id,
              result: resp.result,
            });
        pending.resolve(jsonRpcResp);
      }
    } catch {
      // Ignore malformed responses
    }
  }

  async disconnect(): Promise<void> {
    this.socket?.destroy();
    this.socket = null;
  }
}
