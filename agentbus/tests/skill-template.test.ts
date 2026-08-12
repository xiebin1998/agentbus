/**
 * TASK-32 Task 6: Skill 模板外置（拍板⑩）
 *
 * 模板真源 = 包内 skills/ 目录的 markdown 文件；src 不再硬编码正文。
 * 覆盖：文件存在/frontmatter 合法/写盘内容与文件一致/文件缺失报清晰错误。
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentsBlockPath, loadAgentsBlock, loadSkillTemplate, skillTemplatePath } from "../src/skill.js";

// 测试跑 src/、生产跑 dist/src/，二者到包根层级一致 → skills/ 定位同一
const PKG_ROOT = join(fileURLToPath(import.meta.url), "../..");

describe("模板文件存在且 frontmatter 合法", () => {
  it("skills/agentbus/SKILL.md 存在且含自述闭环段", () => {
    const path = skillTemplatePath();
    expect(existsSync(path)).toBe(true);
    expect(path).toBe(join(PKG_ROOT, "skills", "agentbus", "SKILL.md"));
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("expect_reply");
    expect(content).toContain("红线");
    // 自述闭环：查档案 → 补档案 → 目录快照 → 发现同伴
    expect(content).toContain("get_status");
    expect(content).toContain("update_agent");
    expect(content).toContain("agents.json");
  });

  it("frontmatter：name=agentbus、description 非空", () => {
    const content = loadSkillTemplate();
    const m = content.match(/^---\n([\s\S]*?)\n---\n/);
    expect(m).not.toBeNull();
    const fm = m![1];
    expect(fm).toContain("name: agentbus");
    const desc = fm.match(/^description:\s*(.+)$/m)?.[1]?.trim();
    expect(desc).toBeTruthy();
  });

  it("skills/agents-block.md 存在且含自述引导", () => {
    const path = agentsBlockPath();
    expect(existsSync(path)).toBe(true);
    expect(path).toBe(join(PKG_ROOT, "skills", "agents-block.md"));
    const content = loadAgentsBlock();
    expect(content).toContain("AgentBus 总线约定");
    expect(content).toContain("get_status");
  });
});

describe("installSkill 写盘内容与模板文件一致", () => {
  it("落盘内容逐字等于 skills/agentbus/SKILL.md", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "agentbus-ext-"));
    try {
      const { installSkill, skillPath } = await import("../src/skill.js");
      installSkill(dir, "qoder");
      const written = readFileSync(skillPath(dir, "qoder"), "utf-8");
      expect(written).toBe(loadSkillTemplate());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("模板文件缺失报清晰错误", () => {
  it("SKILL.md 缺失 → 抛错含路径与指引", () => {
    expect(() => loadSkillTemplate(join(PKG_ROOT, "skills", "no-such", "SKILL.md")))
      .toThrow(/SKILL\.md/);
  });

  it("agents-block.md 缺失 → 抛错含路径与指引", () => {
    expect(() => loadAgentsBlock(join(PKG_ROOT, "skills", "no-such.md")))
      .toThrow(/agents-block\.md/);
  });
});
