/**
 * TASK-09: 信任分级判定器（架构 4.7）
 *
 * 入站默认只读（inbound_mode），trust_map 按来源覆盖。
 * 匹配规则：完整身份（ns/client_id）优先于 client 段；flat 发件人不被 ns 形态键误匹配。
 */
import type { InboundMode } from "../config.js";

export function resolveTrust(
  sender: string,
  inboundMode: InboundMode,
  trustMap: Record<string, InboundMode>,
): InboundMode {
  // 完整身份优先（更具体的配置获胜）
  if (sender in trustMap) return trustMap[sender]!;
  const slash = sender.indexOf("/");
  if (slash >= 0) {
    const clientPart = sender.slice(slash + 1);
    if (clientPart in trustMap) return trustMap[clientPart]!;
  }
  return inboundMode;
}
