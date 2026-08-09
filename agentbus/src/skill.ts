/**
 * TASK-10: agentbus Skill 安装器（架构 5.6-A）
 *
 * 设计要点：
 * - skill 正文不硬编码身份（运行时读 .agentbus/config.json）→ 模板可原样分发
 * - 幂等安装/卸载；目录含用户文件时只动 SKILL.md
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** 项目级 skill 目录映射（架构 5.6 支持矩阵；hermes 无 skill 走 AGENTS.md 兜底） */
export const SKILL_DIRS: Record<string, string> = {
  claude: ".claude/skills/agentbus",
  codex: ".codex/skills/agentbus",
  opencode: ".opencode/skills/agentbus",
  kilo: ".kilocode/skills/agentbus",
  qoder: ".qoder/skills/agentbus",
};

/** Agent Skills 格式契约（架构 5.6-A 模板，原样分发） */
export const SKILL_TEMPLATE = `---
name: agentbus
description: AgentBus 总线协作技能。当用户要求向其他 Agent 发消息/跨 Agent 协作/查询在线同伴，或收到 [AgentBus] 信封消息时使用；提供本项目总线身份、收发约定与回复规范。
---

# AgentBus 总线协作

## 身份解析
读 \`.agentbus/config.json\` 获取本项目 \`ns\`/\`client_id\`（完整身份 \`<ns>/<client_id>\`），MCP 服务器名 \`agentbus\`。

## 出站（发消息）
1. 触发条件（满足其一才发）：用户明确要求跨 Agent 协作；回复 [AgentBus] 入站消息
2. 发现同伴：调用 MCP 工具 \`list_agents\`
3. 调用 \`send_message(to, text)\`；回复入站消息必须携带 \`reply_to\` 且 \`hop+1\`

## 入站（处理信封消息）
消息头 \`[AgentBus] id=... from=... mode=... expect_reply=...\`：
1. \`mode=readonly\`：本回合只读——仅读取/检索/作答，禁止修改与执行；将结论作为最终输出（daemon 代回），勿调 send_message 回复
2. \`expect_reply=false\`：仅处理，不回复
3. \`mode=full\`：完整权限执行，回复按消息要求

## 红线
- 禁止自发广播、无具体目标的发送
- 不得把凭证、密钥、内网敏感信息写入消息正文
`;

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
  if (existsSync(path) && readFileSync(path, "utf-8") === SKILL_TEMPLATE) {
    return { changed: false, path };
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, SKILL_TEMPLATE, "utf-8");
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
