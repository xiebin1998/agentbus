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
    const env = buildEnvelope(msg());
    expect(env.split("\n")[0]).toBe(
      "[AgentBus] id=msg-abc from=iot/be-svc hop=1 expect_reply=true",
    );
  });

  it("包含 skill 加载指令（确定性触发静态契约）", () => {
    expect(buildEnvelope(msg())).toContain("`agentbus` skill");
  });

  it("原消息 text 原样置于信封末尾", () => {
    const env = buildEnvelope(msg({ text: "原始内容 XYZ" }));
    expect(env.trimEnd().endsWith("原始内容 XYZ")).toBe(true);
  });
});

describe("expect_reply 语义", () => {
  it("expect_reply=true：指示调用 send_message 回复", () => {
    const env = buildEnvelope(msg());
    expect(env).toContain("调用 send_message 回复");
    expect(env).toContain("reply_to=msg-abc");
    expect(env).toContain("to=iot/be-svc");
  });

  it("expect_reply=false：告知无需回复，不出现代回指令", () => {
    const env = buildEnvelope(msg({ expect_reply: false }));
    expect(env.split("\n")[0]).toContain("expect_reply=false");
    expect(env).toContain("无需回复");
    expect(env).not.toContain("无需调用 send_message");
  });
});

describe("session 字段（Plan 3 问题 2：会话路由上下文）", () => {
  it("携带注入会话：信封出现 session=<本地会话ID>（发消息时用作 session_id）", () => {
    const env = buildEnvelope(msg(), "ses_local");
    expect(env).toContain("session=ses_local");
  });

  it("原消息带发送方会话：显示 reply_session（手动回复时用作 session_id 回传）", () => {
    const env = buildEnvelope(msg({ session: "ses_remote" }), "ses_local");
    expect(env).toContain("reply_session=ses_remote");
  });

  it("兼容：不传注入会话且原消息无 session 时无会话行；原消息无 session 时不出现 reply_session", () => {
    const env = buildEnvelope(msg());
    expect(env).not.toContain("session=");
    expect(env).not.toContain("reply_session=");
    const env2 = buildEnvelope(msg(), "ses_local");
    expect(env2).not.toContain("reply_session=");
  });
});
