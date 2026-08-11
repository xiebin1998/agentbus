// 轻量 cn（无外部依赖）：拼接 className，忽略 falsy
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export function formatTime(iso?: string): string {
  if (!iso) return "-";
  return iso.replace("T", " ").slice(0, 19);
}
