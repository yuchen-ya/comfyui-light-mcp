/**
 * 有界输出工具（Context-light 基础件）。
 * 规则：截断必须可见（"..." 前缀标记）、空值渲染 <empty>、保留尾部（结论在末尾）。
 */

export const TRUNCATE_MARK = "...";

/** 字符串截断：超限时保留尾部并加显式截断标记 */
export function clipTail(s: string, max: number): string {
  if (s.length <= max) return s;
  return TRUNCATE_MARK + s.slice(Math.max(0, s.length - max));
}

/** 渲染任意值为有界文本；null/空串/空对象/空数组显式 <empty> */
export function renderBounded(value: unknown, max = 200): string {
  if (value === null || value === undefined) return "<empty>";
  if (typeof value === "string") return value.length === 0 ? "<empty>" : clipTail(value, max);
  if (Array.isArray(value) && value.length === 0) return "<empty>";
  if (typeof value === "object" && Object.keys(value as object).length === 0) return "<empty>";
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  return clipTail(text, max);
}
