/**
 * TASK-09: 信任分级判定器（架构 4.7）—— inbound_mode 默认 + trust_map 按来源覆盖
 */
import { describe, expect, it } from "vitest";
import { resolveTrust } from "../src/daemon/trust.js";

describe("resolveTrust", () => {
  it("无覆盖时返回 inbound_mode 默认值", () => {
    expect(resolveTrust("be-svc", "readonly", {})).toBe("readonly");
    expect(resolveTrust("be-svc", "full", {})).toBe("full");
  });

  it("trust_map 按完整身份覆盖", () => {
    expect(resolveTrust("iot/be-svc", "readonly", { "iot/be-svc": "full" })).toBe("full");
  });

  it("trust_map 按 client 段匹配 ns 形态发件人", () => {
    expect(resolveTrust("iot/ci-bot", "readonly", { "ci-bot": "full" })).toBe("full");
  });

  it("完整身份优先于 client 段（更具体的配置获胜）", () => {
    expect(
      resolveTrust("iot/be-svc", "readonly", { "iot/be-svc": "readonly", "be-svc": "full" }),
    ).toBe("readonly");
  });

  it("flat 发件人不受 ns 形态键误匹配", () => {
    expect(resolveTrust("be-svc", "readonly", { "iot/be-svc": "full" })).toBe("readonly");
  });
});
