/**
 * TASK-09: 注入信封（架构 4.6）—— [AgentBus] 元数据行 + skill 引用 + 只读禁令/expect_reply 指令
 */
import { describe, expect, it } from "vitest";
import { buildEnvelope } from "../src/daemon/envelope.js";
import { normalize } from "../src/protocol.js";

function msg(overrides: Record<string, unknown> = {}) {
  const m = normalize({
    id: "msg-abc",
    from: "iot/be-svc",
    to: "fe-test",
    text: "帮我查一下接口",
    hop: 1,
    expect_reply: true,
    ...overrides,
  });
  if (!m) throw new Error("normalize failed");
  return m;
}

describe("信封结构", () => {
  it("首行为机器可识别元数据：[AgentBus] id/from/hop/expect_reply", () => {
    const env = buildEnvelope(msg(), { sessionId: "ses" });
    expect(env.split("\n")[0]).toBe(
      "[AgentBus] id=msg-abc from=iot/be-svc hop=1 expect_reply=true",
    );
  });

  it("包含代回指令（无需调用工具）", () => {
    expect(buildEnvelope(msg(), { sessionId: "ses" })).toContain("无需调用任何工具");
  });

  it("原消息 text 原样置于信封末尾", () => {
    const env = buildEnvelope(msg({ text: "原始内容 XYZ" }), { sessionId: "ses" });
    expect(env.trimEnd().endsWith("原始内容 XYZ")).toBe(true);
  });
});

describe("expect_reply 语义", () => {
  it("expect_reply=true：指示直接输出回复内容", () => {
    const env = buildEnvelope(msg(), { sessionId: "ses" });
    expect(env).toContain("请直接输出你的回复内容");
    expect(env).toContain("无需调用任何工具");
  });

  it("expect_reply=false：告知无需回复，不出现代回指令", () => {
    const env = buildEnvelope(msg({ expect_reply: false }), { sessionId: "ses" });
    expect(env.split("\n")[0]).toContain("expect_reply=false");
    expect(env).toContain("无需回复");
  });
});

describe("session 字段（通道上下文）", () => {
  it("携带注入会话：信封出现 session=<本地会话ID>", () => {
    const env = buildEnvelope(msg(), { sessionId: "ses_local" });
    expect(env).toContain("session=ses_local");
  });

  it("通道含 remoteSessionId：显示 peer_session", () => {
    const env = buildEnvelope(msg({ session: "ses_remote" }), { sessionId: "ses_local", remoteSessionId: "ses_remote" });
    expect(env).toContain("peer_session=ses_remote");
  });

  it("无 channelId 时不出现 channel 行", () => {
    const env = buildEnvelope(msg(), { sessionId: "ses_local" });
    expect(env).not.toContain("channel=");
  });

  it("有 channelId 时出现 channel 行", () => {
    const env = buildEnvelope(msg(), { sessionId: "ses_local", channelId: "ch-abc" });
    expect(env).toContain("channel=ch-abc");
  });
});
