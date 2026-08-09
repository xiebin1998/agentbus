/**
 * TASK-10: AGENTS.md 托管块（架构 5.6-B）—— 插入/更新/删除幂等，对已有内容无损
 */
import { describe, expect, it } from "vitest";
import {
  AGENTBUS_BLOCK,
  removeAgentsMdBlock,
  upsertAgentsMdBlock,
} from "../src/agents-md.js";

const EXISTING = `# 我的项目\n\n## 开发规范\n用 pnpm，不用 npm。\n`;

describe("upsertAgentsMdBlock", () => {
  it("空内容 → 仅生成托管块", () => {
    const result = upsertAgentsMdBlock("", AGENTBUS_BLOCK);
    expect(result).toContain("<!-- AGENTBUS:BEGIN");
    expect(result).toContain("<!-- AGENTBUS:END -->");
    expect(result).toContain("AgentBus 总线约定");
  });

  it("已有内容 → 追加块且原文逐字无损", () => {
    const result = upsertAgentsMdBlock(EXISTING, AGENTBUS_BLOCK);
    expect(result.startsWith(EXISTING)).toBe(true);
    expect(result).toContain("AGENTBUS:BEGIN");
  });

  it("幂等：已有块时重复 upsert 内容不变", () => {
    const once = upsertAgentsMdBlock(EXISTING, AGENTBUS_BLOCK);
    const twice = upsertAgentsMdBlock(once, AGENTBUS_BLOCK);
    expect(twice).toBe(once);
  });

  it("块内容升级：仅替换块内，前后用户内容无损", () => {
    const v1 = upsertAgentsMdBlock(EXISTING, AGENTBUS_BLOCK);
    const withTail = `${v1}\n## 用户后加的小节\n新内容。\n`;
    const v2 = upsertAgentsMdBlock(withTail, AGENTBUS_BLOCK.replace("总线约定", "总线约定（v2）"));
    expect(v2).toContain("总线约定（v2）");
    expect(v2).toContain("## 用户后加的小节");
    expect(v2).toContain("用 pnpm，不用 npm。");
    expect(v2.match(/AGENTBUS:BEGIN/g)!.length).toBe(1); // 不产生重复块
  });
});

describe("removeAgentsMdBlock", () => {
  it("删除托管块，其余内容逐字保留", () => {
    const withBlock = upsertAgentsMdBlock(EXISTING, AGENTBUS_BLOCK);
    const restored = removeAgentsMdBlock(withBlock);
    expect(restored).not.toContain("AGENTBUS:BEGIN");
    expect(restored).toContain("用 pnpm，不用 npm。");
    expect(restored.trim()).toBe(EXISTING.trim());
  });

  it("文件只有托管块 → 结果为空串", () => {
    const only = upsertAgentsMdBlock("", AGENTBUS_BLOCK);
    expect(removeAgentsMdBlock(only).trim()).toBe("");
  });

  it("无块时删除为幂等无害", () => {
    expect(removeAgentsMdBlock(EXISTING)).toBe(EXISTING);
  });

  it("正文中提及 AGENTBUS 字样但未成块 → 不误删", () => {
    const tricky = `${EXISTING}\n我们在讨论 AGENTBUS:BEGIN 这个字符串。\n`;
    expect(removeAgentsMdBlock(tricky)).toBe(tricky);
  });
});
