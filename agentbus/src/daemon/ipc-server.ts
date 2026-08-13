import { createServer, Server, Socket } from "node:net";

export interface IpcServerOptions {
  port: number; // 0 = random available port
}

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

export class IpcServer {
  private server: Server | null = null;
  private tools = new Map<string, ToolHandler>();
  public address: string | null = null;

  constructor(private opts: IpcServerOptions) {}

  registerTool(name: string, handler: ToolHandler): void {
    this.tools.set(name, handler);
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = createServer((socket) => this.handleConnection(socket));
      this.server.listen(this.opts.port, "127.0.0.1", () => {
        const addr = this.server!.address();
        if (addr && typeof addr === "object") {
          this.address = `127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
    });
  }

  private handleConnection(socket: Socket): void {
    let buffer = "";
    socket.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (line.trim()) void this.handleRequest(socket, line);
      }
    });
    socket.on("error", (err) => {
      // Client disconnected or error - just log
      console.error(`IPC client error: ${err.message}`);
    });
  }

  private async handleRequest(socket: Socket, line: string): Promise<void> {
    try {
      const req = JSON.parse(line);
      const handler = this.tools.get(req.method);
      if (!handler) {
        socket.write(
          JSON.stringify({ id: req.id, error: `Unknown tool: ${req.method}` }) +
            "\n",
        );
        return;
      }
      const result = await handler(req.params || {});
      socket.write(JSON.stringify({ id: req.id, result }) + "\n");
    } catch (e) {
      socket.write(JSON.stringify({ error: (e as Error).message }) + "\n");
    }
  }
}
