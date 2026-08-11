// 轻量 cn（无外部依赖）：拼接 className，忽略 falsy
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export function formatTime(iso?: string): string {
  if (!iso) return "-";
  // 后端/daemon 一律存 UTC（ISO 带 Z）；展示层转浏览器本地时区（sv-SE → "YYYY-MM-DD HH:mm:ss"）
  const d = new Date(iso);
  if (!Number.isNaN(d.getTime())) return d.toLocaleString("sv-SE", { hour12: false });
  // 非法时间字符串：回退原截取逻辑，不抛错
  return iso.replace("T", " ").slice(0, 19);
}
