/**
 * TASK-10: AGENTS.md 托管块（架构 5.6-B）
 *
 * 仅为不支持 skill 的工具兜底。插入/更新/删除全部幂等，块外用户内容逐字无损。
 * 块边界用完整标记串匹配（含注释语法），正文提及字样不会误判。
 * TASK-32 拍板⑩：块正文外置到包内 skills/agents-block.md。
 */
import { loadAgentsBlock } from "./skill.js";

export const AGENTBUS_BEGIN = "<!-- AGENTBUS:BEGIN（agentbus init 自动生成，勿手动修改块内内容） -->";
export const AGENTBUS_END = "<!-- AGENTBUS:END -->";

/** 兜底块正文（架构 5.6-B；真源 skills/agents-block.md，模块加载时读入） */
export const AGENTBUS_BLOCK = loadAgentsBlock();

function renderBlock(body: string): string {
  return `${AGENTBUS_BEGIN}\n${body}\n${AGENTBUS_END}`;
}

/** 插入或更新托管块；块外内容不动，幂等 */
export function upsertAgentsMdBlock(content: string, blockBody: string): string {
  const block = renderBlock(blockBody);
  const beginIdx = content.indexOf(AGENTBUS_BEGIN);
  const endIdx = content.indexOf(AGENTBUS_END);

  if (beginIdx >= 0 && endIdx > beginIdx) {
    // 更新：替换 BEGIN 起点到 END 终点（含）
    const before = content.slice(0, beginIdx);
    const after = content.slice(endIdx + AGENTBUS_END.length);
    return `${before}${block}${after}`;
  }

  // 插入：空文件直接生成；否则以空行分隔追加
  if (!content.trim()) return `${block}\n`;
  const base = content.endsWith("\n") ? content : `${content}\n`;
  return `${base}\n${block}\n`;
}

/** 删除托管块；无块时原样返回（不误伤提及字样的正文） */
export function removeAgentsMdBlock(content: string): string {
  const beginIdx = content.indexOf(AGENTBUS_BEGIN);
  const endIdx = content.indexOf(AGENTBUS_END);
  if (beginIdx < 0 || endIdx < beginIdx) return content;

  const before = content.slice(0, beginIdx);
  const after = content.slice(endIdx + AGENTBUS_END.length);
  // 清理拼接处多余空行，但保留原文结构
  const joined = `${before.replace(/\n+$/, "")}${after.replace(/^\n+/, "")}`;
  if (!joined.trim()) return "";
  return joined.endsWith("\n") ? joined : `${joined}\n`;
}
