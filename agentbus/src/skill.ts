/**
 * TASK-10: agentbus Skill 安装器（架构 5.6-A）
 *
 * 设计要点：
 * - skill 正文不硬编码身份（运行时读 .agentbus/config.json）→ 模板可原样分发
 * - 幂等安装/卸载；目录含用户文件时只动 SKILL.md
 * - TASK-32 拍板⑩：模板真源外置到包内 skills/ 目录（src 与 dist 均在包根下一层）
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** 项目级 skill 目录映射（架构 5.6 支持矩阵；hermes 无 skill 走 AGENTS.md 兜底） */
export const SKILL_DIRS: Record<string, string> = {
  claude: ".claude/skills/agentbus",
  codex: ".codex/skills/agentbus",
  opencode: ".opencode/skills/agentbus",
  kilo: ".kilocode/skills/agentbus",
  qoder: ".qoder/skills/agentbus",
};

/** 包内 SKILL.md 模板真源（src/skill.ts 与 dist/skill.js 到包根层级一致） */
export function skillTemplatePath(): string {
  return fileURLToPath(new URL("../skills/agentbus/SKILL.md", import.meta.url));
}

/** 包内 AGENTS.md 托管块模板真源 */
export function agentsBlockPath(): string {
  return fileURLToPath(new URL("../skills/agents-block.md", import.meta.url));
}

/** 读模板文件；缺失报含路径的清晰错误（发包时 skills/ 须随包分发）。
 * 行尾统一归一 LF：Windows 工作区可能 CRLF 落盘，frontmatter 解析器对 CRLF 敏感 */
export function loadSkillTemplate(path = skillTemplatePath()): string {
  if (!existsSync(path)) {
    throw new Error(`Skill 模板缺失：${path}（包内 skills/ 目录应随 npm 包分发）`);
  }
  return readFileSync(path, "utf-8").replace(/\r\n/g, "\n");
}

export function loadAgentsBlock(path = agentsBlockPath()): string {
  if (!existsSync(path)) {
    throw new Error(`agents-block.md 模板缺失：${path}（包内 skills/ 目录应随 npm 包分发）`);
  }
  return readFileSync(path, "utf-8").replace(/\r\n/g, "\n").trim();
}

export function skillPath(projectDir: string, tool: string): string {
  const rel = SKILL_DIRS[tool];
  if (!rel) {
    throw new Error(`工具 ${tool} 不支持 skill 安装（可选：${Object.keys(SKILL_DIRS).join(", ")}）`);
  }
  return join(projectDir, rel, "SKILL.md");
}

/** 幂等安装：内容一致则不写盘 */
export function installSkill(projectDir: string, tool: string): { changed: boolean; path: string } {
  const path = skillPath(projectDir, tool);
  const template = loadSkillTemplate();
  if (existsSync(path) && readFileSync(path, "utf-8") === template) {
    return { changed: false, path };
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, template, "utf-8");
  return { changed: true, path };
}

/** 幂等卸载：只删 SKILL.md；目录非空（用户文件）时保留目录；
 * 随后顺清空父目录链（TASK-14 零残留），遇非空目录即止，绝不出 projectDir */
export function uninstallSkill(projectDir: string, tool: string): { changed: boolean } {
  const path = skillPath(projectDir, tool);
  if (!existsSync(path)) return { changed: false };
  unlinkSync(path);
  let dir = dirname(path);
  while (existsSync(dir)) {
    if (readdirSync(dir).length > 0) break;
    rmSync(dir, { recursive: true, force: true });
    const parent = dirname(dir);
    // 到项目根即止，不得向上越界
    if (parent === dir || parent === projectDir) break;
    dir = parent;
  }
  return { changed: true };
}
