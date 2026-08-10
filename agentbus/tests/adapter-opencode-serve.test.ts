/**
 * TASK-27: OpenCodeKiloAdapter serve 模式参数构造（架构 5.4 进阶通道）
 *
 * 实测 opencode（2026-08-10）：
 * - `serve --port <n> --hostname <h>` 起无头服务器（stdout 打印服务地址）
 * - `run --attach <url>` 免冷启动注入回合；--dir 为服务端路径
 * - kilo 7.4.17 无 serve 子命令 → supportsServe 仅 opencode 族为真
 */
import { describe, expect, it } from "vitest";
import { OpenCodeKiloAdapter } from "../src/adapters/opencode-kilo.js";

describe("TASK-27 serve 模式参数（opencode 实测契约）", () => {
  const adapter = new OpenCodeKiloAdapter({ binary: "opencode", workspace: "/ws" });

  it("serveArgs：固定端口与 hostname", () => {
    expect(adapter.serveArgs(4096, "127.0.0.1")).toEqual(["serve", "--port", "4096", "--hostname", "127.0.0.1"]);
  });

  it("serveArgs：缺省 port 0（随机）/ hostname 127.0.0.1", () => {
    expect(adapter.serveArgs()).toEqual(["serve", "--port", "0", "--hostname", "127.0.0.1"]);
  });

  it("attachCreateSessionArgs：--attach + --title + --auto（full 档）", () => {
    expect(adapter.attachCreateSessionArgs("http://127.0.0.1:4096", "你好", "be-svc")).toEqual([
      "run", "--attach", "http://127.0.0.1:4096", "--format", "json", "--dir", "/ws",
      "--title", "be-svc", "--auto", "你好",
    ]);
  });

  it("attachInjectArgs：--attach + -s 续接", () => {
    expect(adapter.attachInjectArgs("http://127.0.0.1:4096", "继续", "ses-1")).toEqual([
      "run", "--attach", "http://127.0.0.1:4096", "--format", "json", "--dir", "/ws",
      "-s", "ses-1", "继续",
    ]);
  });

  it("supportsServe：opencode true / kilo false（实测无 serve 子命令）", () => {
    expect(adapter.supportsServe()).toBe(true);
    const kilo = new OpenCodeKiloAdapter({ binary: "kilo", workspace: "/ws" });
    expect(kilo.supportsServe()).toBe(false);
  });

  it("extractText：attach 实测事件流（文本在 part.text，非顶层 text）", () => {
    const ndjson = [
      '{"type":"step_start","timestamp":1,"sessionID":"ses_x","part":{"id":"p1","type":"step-start"}}',
      '{"type":"text","timestamp":2,"sessionID":"ses_x","part":{"id":"p2","type":"text","text":"好","time":{"start":1,"end":2}}}',
      '{"type":"step_finish","timestamp":3,"sessionID":"ses_x","part":{"id":"p3","reason":"stop","type":"step-finish"}}',
    ].join("\n");
    expect(adapter.extractText(ndjson)).toBe("好");
  });

  it("extractSessionId：attach 实测事件流（顶层 sessionID 大写 ID 形态）", () => {
    const line = '{"type":"step_start","sessionID":"ses_016e51277ffe6qQbr3fP2rGA5R","part":{}}';
    expect(adapter.extractSessionId(line)).toBe("ses_016e51277ffe6qQbr3fP2rGA5R");
  });
});
