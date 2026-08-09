/**
 * TASK-05: Daemon 路由管线（架构 4.2 步骤 0–8）
 * 白名单 → 去重 → hop 熔断 → control 短路 → 工具判定 → 限速 → 会话判定 → ack
 */
import { describe, expect, it } from "vitest";
import { Router, type RouterConfig } from "../src/daemon/router.js";

function makeConfig(overrides: Partial<RouterConfig> = {}): RouterConfig {
  return {
    selfIdentity: "fe-zhangsan",
    allowedSenders: [],
    hopLimit: 3,
    rateLimit: 5,
    rateWindowMs: 60_000,
    defaultTool: "kilo",
    tools: { kilo: {}, qoder: {} },
    ack: true,
    dedupCapacity: 1000,
    queueMax: 20,
    ...overrides,
  };
}

/** 构造一条合法入站消息 */
function msg(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `msg-${Math.random().toString(16).slice(2, 14)}`,
    from: "be-svc",
    to: "fe-zhangsan",
    text: "请查一下用户列表接口",
    type: "text",
    ...overrides,
  };
}

describe("正常路径", () => {
  it("正常 text 消息 → inject 默认工具 + 生成 ack（type=control/expect_reply=false）", () => {
    const router = new Router(makeConfig());
    const m = msg({ id: "msg-abc" });
    const { decision, ack } = router.route(m);
    expect(decision.action).toBe("inject");
    if (decision.action === "inject") {
      expect(decision.tool).toBe("kilo");
      expect(decision.queued).toBe(false);
    }
    expect(ack).not.toBeNull();
    expect(ack!.type).toBe("control");
    expect(ack!.expect_reply).toBe(false);
    expect(ack!.reply_to).toBe("msg-abc");
    expect(ack!.to).toBe("be-svc");
  });

  it("ack 关闭时不回 ack", () => {
    const router = new Router(makeConfig({ ack: false }));
    expect(router.route(msg()).ack).toBeNull();
  });
});

describe("步骤 0：白名单", () => {
  it("白名单外来源被丢弃并告警", () => {
    const router = new Router(makeConfig({ allowedSenders: ["be-svc"] }));
    const { decision } = router.route(msg({ from: "evil" }));
    expect(decision.action).toBe("drop");
    if (decision.action === "drop") {
      expect(decision.alert).toBe(true);
      expect(decision.reason).toContain("白名单");
    }
  });

  it("ns 形态发件人按 client 段匹配白名单", () => {
    const router = new Router(makeConfig({ allowedSenders: ["be-svc"] }));
    expect(router.route(msg({ from: "iot/be-svc" })).decision.action).toBe("inject");
  });

  it("白名单为空表示不限制", () => {
    const router = new Router(makeConfig({ allowedSenders: [] }));
    expect(router.route(msg({ from: "anyone" })).decision.action).toBe("inject");
  });
});

describe("步骤 1：去重 LRU", () => {
  it("同一 msg id 重复投递静默丢弃（不告警）", () => {
    const router = new Router(makeConfig());
    router.route(msg({ id: "msg-dup" }));
    const { decision } = router.route(msg({ id: "msg-dup" }));
    expect(decision.action).toBe("drop");
    if (decision.action === "drop") {
      expect(decision.alert).toBe(false);
      expect(decision.reason).toContain("重复");
    }
  });

  it("LRU 容量满后最旧 id 被逐出（可再次接收）", () => {
    const router = new Router(makeConfig({ dedupCapacity: 2 }));
    router.route(msg({ id: "m1" }));
    router.route(msg({ id: "m2" }));
    router.route(msg({ id: "m3" })); // 逐出 m1
    expect(router.route(msg({ id: "m1" })).decision.action).toBe("inject"); // m1 已逐出，重新接收（此时逐出 m2）
    expect(router.route(msg({ id: "m3" })).decision.action).toBe("drop");   // m3 仍在 LRU 中
  });
});

describe("步骤 2：hop 熔断", () => {
  it("超过 hop_limit 丢弃并告警", () => {
    const router = new Router(makeConfig({ hopLimit: 3 }));
    const { decision } = router.route(msg({ hop: 4 }));
    expect(decision.action).toBe("drop");
    if (decision.action === "drop") {
      expect(decision.alert).toBe(true);
      expect(decision.reason).toContain("hop");
    }
  });

  it("等于 hop_limit 仍放行", () => {
    const router = new Router(makeConfig({ hopLimit: 3 }));
    expect(router.route(msg({ hop: 3 })).decision.action).toBe("inject");
  });
});

describe("步骤 3：control 短路", () => {
  it("control 消息仅记日志，不注入不回 ack", () => {
    const router = new Router(makeConfig());
    const { decision, ack } = router.route(msg({ type: "control" }));
    expect(decision.action).toBe("control");
    expect(ack).toBeNull();
  });
});

describe("步骤 4：工具判定", () => {
  it("to 带 @tool 限定 → 指定工具", () => {
    const router = new Router(makeConfig());
    const { decision } = router.route(msg({ to: "fe-zhangsan@qoder" }));
    expect(decision.action).toBe("inject");
    if (decision.action === "inject") expect(decision.tool).toBe("qoder");
  });

  it("@tool 指向未配置工具 → 忽略", () => {
    const router = new Router(makeConfig());
    const { decision } = router.route(msg({ to: "fe-zhangsan@claude" }));
    expect(decision.action).toBe("ignore");
  });

  it("数组 to 也能提取 @tool", () => {
    const router = new Router(makeConfig());
    const { decision } = router.route(msg({ to: ["fe-zhangsan@qoder"] }));
    expect(decision.action).toBe("inject");
    if (decision.action === "inject") expect(decision.tool).toBe("qoder");
  });
});

describe("步骤 5：限速与队列", () => {
  it("窗口内超过 rate_limit 的消息排队（queued=true）", () => {
    let t = 0;
    const router = new Router(makeConfig({ rateLimit: 2 }), { now: () => t });
    expect(router.route(msg()).decision).toMatchObject({ queued: false });
    expect(router.route(msg()).decision).toMatchObject({ queued: false });
    expect(router.route(msg()).decision).toMatchObject({ queued: true });
  });

  it("队列超过 queueMax 时标记逐出最旧", () => {
    let t = 0;
    const router = new Router(makeConfig({ rateLimit: 1, queueMax: 2 }), { now: () => t });
    router.route(msg()); // 直通
    expect(router.route(msg()).decision).toMatchObject({ queued: true, evictOldest: false }); // 深度 1
    expect(router.route(msg()).decision).toMatchObject({ queued: true, evictOldest: false }); // 深度 2
    expect(router.route(msg()).decision).toMatchObject({ queued: true, evictOldest: true });  // 深度 3 → 逐出
    router.dequeue("be-svc"); // 消费两条后深度回到 1，再排队不逐出
    router.dequeue("be-svc");
    expect(router.route(msg()).decision).toMatchObject({ queued: true, evictOldest: false });
  });

  it("窗口过期后计数重置", () => {
    let t = 0;
    const router = new Router(
      makeConfig({ rateLimit: 1, rateWindowMs: 60_000 }),
      { now: () => t },
    );
    router.route(msg());
    expect(router.route(msg()).decision).toMatchObject({ queued: true });
    t = 61_000;
    expect(router.route(msg()).decision).toMatchObject({ queued: false });
  });
});

describe("步骤 6：会话判定", () => {
  it("陌生发件人标记 isNewSender（daemon 侧将 create_session）", () => {
    const router = new Router(makeConfig());
    const { decision } = router.route(msg({ from: "new-guy" }));
    expect(decision.action).toBe("inject");
    if (decision.action === "inject") expect(decision.isNewSender).toBe(true);
  });

  it("sessions.json 已有记录的发件人不建新会话", () => {
    const router = new Router(makeConfig(), { knownSenders: new Set(["be-svc"]) });
    const { decision } = router.route(msg());
    if (decision.action === "inject") expect(decision.isNewSender).toBe(false);
  });
});

describe("非法输入", () => {
  it.each([null, "str", { to: "x", text: "no from" }])(
    "非法消息丢弃且不抛异常: %p",
    (raw: unknown) => {
      const router = new Router(makeConfig());
      const { decision } = router.route(raw);
      expect(decision.action).toBe("drop");
    },
  );
});
