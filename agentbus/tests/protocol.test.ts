/**
 * TASK-03: 协议类型层（架构 3.2）
 * BusMessage 缺省值兼容 / makeAck / makeReply / msg id 生成
 */
import { describe, expect, it } from "vitest";
import {
  newMsgId,
  normalize,
  makeAck,
  makeReply,
  type BusMessage,
} from "../src/protocol.js";

describe("newMsgId", () => {
  it("生成 msg- 前缀 + 12 位 hex", () => {
    expect(newMsgId()).toMatch(/^msg-[0-9a-f]{12}$/);
  });

  it("两次生成不重复", () => {
    expect(newMsgId()).not.toBe(newMsgId());
  });
});

describe("normalize 缺省值兼容", () => {
  it("完整消息原样保留", () => {
    const raw = {
      id: "msg-abc",
      from: "a",
      to: "b",
      text: "hi",
      type: "text",
      reply_to: "msg-x",
      hop: 2,
      expect_reply: false,
      timestamp: "2026-08-09T00:00:00Z",
    };
    const m = normalize(raw);
    expect(m).toEqual(expect.objectContaining(raw));
  });

  it("缺省字段按协议补齐", () => {
    const m = normalize({ from: "a", to: "b", text: "hi" });
    expect(m).not.toBeNull();
    expect(m!.id).toMatch(/^msg-/);
    expect(m!.type).toBe("text");
    expect(m!.hop).toBe(0);
    expect(m!.expect_reply).toBe(true);
    expect(m!.reply_to).toBeNull();
    expect(m!.redirect_client_id).toBe("a");
    expect(m!.timestamp).toBeTruthy();
  });

  it("非法 type 回退 text", () => {
    expect(normalize({ from: "a", type: "weird" })!.type).toBe("text");
  });

  it("非法 hop（字符串/负数）回退 0", () => {
    expect(normalize({ from: "a", hop: "abc" })!.hop).toBe(0);
    expect(normalize({ from: "a", hop: -3 })!.hop).toBe(0);
  });

  it("非布尔 expect_reply 回退 true", () => {
    expect(normalize({ from: "a", expect_reply: "no" })!.expect_reply).toBe(true);
  });

  it("control 类型保留", () => {
    expect(normalize({ from: "a", type: "control" })!.type).toBe("control");
  });
});

describe("normalize 非法输入", () => {
  it.each([null, undefined, "str", 42, []])("非对象输入返回 null: %p", (raw: unknown) => {
    expect(normalize(raw)).toBeNull();
  });

  it("缺 from 返回 null", () => {
    expect(normalize({ to: "b", text: "hi" })).toBeNull();
  });
});

describe("makeAck", () => {
  const original: BusMessage = {
    id: "msg-orig",
    from: "be-svc",
    redirect_client_id: "be-svc",
    to: "fe-zhangsan",
    text: "请查一下",
    type: "text",
    reply_to: null,
    hop: 1,
    expect_reply: true,
    session: null,
    timestamp: "t0",
  };

  it("type=control 不触发回合（环路抑制核心）", () => {
    const ack = makeAck("fe-zhangsan", original);
    expect(ack.type).toBe("control");
    expect(ack.expect_reply).toBe(false);
  });

  it("回复对象与 hop 递增正确", () => {
    const ack = makeAck("fe-zhangsan", original);
    expect(ack.to).toBe("be-svc");
    expect(ack.reply_to).toBe("msg-orig");
    expect(ack.hop).toBe(2);
    expect(ack.from).toBe("fe-zhangsan");
    expect(ack.id).toMatch(/^msg-/);
  });
});

describe("makeReply（daemon 代回）", () => {
  const original: BusMessage = {
    id: "msg-orig",
    from: "be-svc",
    redirect_client_id: "be-svc",
    to: "fe-zhangsan",
    text: "请查一下",
    type: "text",
    reply_to: null,
    hop: 1,
    expect_reply: true,
    session: null,
    timestamp: "t0",
  };

  it("代回三字段正确：reply_to / hop+1 / expect_reply=false", () => {
    const reply = makeReply("fe-zhangsan", original, "接口在 src/api/user.ts");
    expect(reply.type).toBe("text");
    expect(reply.text).toBe("接口在 src/api/user.ts");
    expect(reply.to).toBe("be-svc");
    expect(reply.reply_to).toBe("msg-orig");
    expect(reply.hop).toBe(2);
    expect(reply.expect_reply).toBe(false);
  });
});

describe("normalize type extension for hello/hello_ack", () => {
  it("parses hello type", () => {
    const raw = { from: "ns/alice", type: "hello", text: "" };
    const msg = normalize(raw);
    expect(msg?.type).toBe("hello");
  });

  it("parses hello_ack type", () => {
    const raw = { from: "ns/bob", type: "hello_ack", text: "" };
    const msg = normalize(raw);
    expect(msg?.type).toBe("hello_ack");
  });

  it("falls back to text for unknown type", () => {
    const raw = { from: "ns/alice", type: "unknown" };
    const msg = normalize(raw);
    expect(msg?.type).toBe("text");
  });

  it("still parses control type", () => {
    const raw = { from: "ns/alice", type: "control" };
    const msg = normalize(raw);
    expect(msg?.type).toBe("control");
  });

  it("defaults to text when type is missing", () => {
    const raw = { from: "ns/alice" };
    const msg = normalize(raw);
    expect(msg?.type).toBe("text");
  });
});

describe("session 字段（Plan 3 问题 2：会话回注路由依据）", () => {
  it("合法字符串保留（发送方本地会话 ID）", () => {
    expect(normalize({ from: "a", session: "ses_abc123" })!.session).toBe("ses_abc123");
  });

  it("缺失/非法/空串回退 null（旧客户端不带此字段，兼容不变）", () => {
    expect(normalize({ from: "a" })!.session).toBeNull();
    expect(normalize({ from: "a", session: 42 })!.session).toBeNull();
    expect(normalize({ from: "a", session: "" })!.session).toBeNull();
  });

  it("代回回显原消息 session（发起方据此把回复注回原会话而非新建）", () => {
    const withSession = { ...original, session: "ses_origin" };
    expect(makeReply("fe-zhangsan", withSession, "ok").session).toBe("ses_origin");
    expect(makeReply("fe-zhangsan", original, "ok").session).toBeNull();
  });

  it("ack 不携带 session（控制消息不参与会话路由）", () => {
    const withSession = { ...original, session: "ses_origin" };
    expect(makeAck("fe-zhangsan", withSession).session).toBeNull();
  });

  const original: BusMessage = {
    id: "msg-orig",
    from: "be-svc",
    redirect_client_id: "be-svc",
    to: "fe-zhangsan",
    text: "请查一下",
    type: "text",
    reply_to: null,
    hop: 1,
    expect_reply: true,
    session: null,
    timestamp: "t0",
  };
});
