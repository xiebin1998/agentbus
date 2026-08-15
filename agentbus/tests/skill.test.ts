/**
 * TASK-10: agentbus Skill 安装器（架构 5.6-A）
 * 幂等写入各工具项目级 skill 目录；uninstall 整体移除
 */
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SKILL_DIRS, SKILL_GLOBAL_DIRS, installSkill, installSkillGlobal, skillPath, skillGlobalPath, uninstallSkill, uninstallSkillGlobal } from "../src/skill.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentbus-skill-"));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("installSkill", () => {
  it("向工具 skill 目录写入 SKILL.md（frontmatter 含 name/description 触发条件）", () => {
    const result = installSkill(dir, "qoder");
    expect(result.changed).toBe(true);
    const content = readFileSync(skillPath(dir, "qoder"), "utf-8");
    expect(content).toContain("name: agentbus");
    expect(content).toContain("[AgentBus]");
    expect(content).toContain("expect_reply");
    expect(content).toContain("红线");
  });

  it("幂等：重复安装不重复写（changed=false）", () => {
    installSkill(dir, "kilo");
    const second = installSkill(dir, "kilo");
    expect(second.changed).toBe(false);
  });

  it("五工具项目级目录映射正确", () => {
    expect(SKILL_DIRS.claude).toBe(".claude/skills/agentbus");
    expect(SKILL_DIRS.codex).toBe(".agents/skills/agentbus");
    expect(SKILL_DIRS.opencode).toBe(".opencode/skills/agentbus");
    expect(SKILL_DIRS.kilo).toBe(".kilo/skills/agentbus");
    expect(SKILL_DIRS.qoder).toBe(".qoder/skills/agentbus");
  });

  it("五工具全局级目录映射正确（联网核对 2026-08-15）", () => {
    expect(SKILL_GLOBAL_DIRS.claude).toBe(".claude/skills/agentbus");
    expect(SKILL_GLOBAL_DIRS.codex).toBe(".agents/skills/agentbus");
    expect(SKILL_GLOBAL_DIRS.opencode).toBe(".config/opencode/skills/agentbus");
    expect(SKILL_GLOBAL_DIRS.kilo).toBe(".kilo/skills/agentbus");
    expect(SKILL_GLOBAL_DIRS.qoder).toBe(".qoder/skills/agentbus");
  });

  it("skill 正文不硬编码身份（运行时读 config.json）", () => {
    installSkill(dir, "qoder");
    const content = readFileSync(skillPath(dir, "qoder"), "utf-8");
    expect(content).toContain(".agentbus/config.json");
  });

  it("未知工具抛错", () => {
    expect(() => installSkill(dir, "cursor")).toThrow(/不支持/);
  });
});

describe("installSkillGlobal", () => {
  it("向全局 skill 目录写入 SKILL.md", () => {
    const home = mkdtempSync(join(tmpdir(), "agentbus-skill-home-"));
    const result = installSkillGlobal(home, "opencode");
    expect(result.changed).toBe(true);
    expect(skillGlobalPath(home, "opencode")).toBe(join(home, ".config/opencode/skills/agentbus/SKILL.md"));
    rmSync(home, { recursive: true, force: true });
  });

  it("幂等：重复安装不重复写", () => {
    const home = mkdtempSync(join(tmpdir(), "agentbus-skill-home-"));
    installSkillGlobal(home, "claude");
    const second = installSkillGlobal(home, "claude");
    expect(second.changed).toBe(false);
    rmSync(home, { recursive: true, force: true });
  });
});

describe("uninstallSkillGlobal", () => {
  it("移除全局 SKILL.md 与空目录", () => {
    const home = mkdtempSync(join(tmpdir(), "agentbus-skill-home-"));
    installSkillGlobal(home, "qoder");
    const result = uninstallSkillGlobal(home, "qoder");
    expect(result.changed).toBe(true);
    expect(existsSync(join(home, ".qoder/skills/agentbus"))).toBe(false);
    rmSync(home, { recursive: true, force: true });
  });

  it("未安装时卸载为无害幂等", () => {
    const home = mkdtempSync(join(tmpdir(), "agentbus-skill-home-"));
    expect(uninstallSkillGlobal(home, "kilo").changed).toBe(false);
    rmSync(home, { recursive: true, force: true });
  });
});

describe("uninstallSkill", () => {
  it("移除 SKILL.md 与空的 skill 目录", () => {
    installSkill(dir, "qoder");
    const result = uninstallSkill(dir, "qoder");
    expect(result.changed).toBe(true);
    expect(existsSync(join(dir, ".qoder/skills/agentbus"))).toBe(false);
  });

  it("skill 目录含用户其他文件时只删 SKILL.md 保留目录", () => {
    installSkill(dir, "qoder");
    writeFileSync(join(dir, ".qoder/skills/agentbus/custom.md"), "mine");
    uninstallSkill(dir, "qoder");
    expect(existsSync(join(dir, ".qoder/skills/agentbus/custom.md"))).toBe(true);
  });

  it("未安装时卸载为无害幂等（changed=false）", () => {
    expect(uninstallSkill(dir, "kilo").changed).toBe(false);
  });

  it("卸载顺清空父目录链（TASK-14 零残留）：.qoder 整体消失", () => {
    installSkill(dir, "qoder");
    uninstallSkill(dir, "qoder");
    expect(existsSync(join(dir, ".qoder"))).toBe(false);
  });

  it("父目录有用户其他内容时不误删，只清空链", () => {
    installSkill(dir, "qoder");
    writeFileSync(join(dir, ".qoder", "settings.json"), "{}");
    uninstallSkill(dir, "qoder");
    expect(existsSync(join(dir, ".qoder", "settings.json"))).toBe(true);
    expect(existsSync(join(dir, ".qoder", "skills"))).toBe(false);
  });
});
