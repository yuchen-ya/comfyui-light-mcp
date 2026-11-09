import { createHash } from "node:crypto";

/**
 * 内容指纹工具（Task 005）：
 * - canonicalJson：递归按键名排序后序列化——JSON 对象键顺序不影响结果
 * - canonicalSha256：canonical JSON 的 sha256 hex（幂等请求指纹用）
 * - sha256Hex：原始文本指纹（工作流/manifest 文件内容指纹用，逐字节精确）
 */

export function canonicalJson(value: unknown): string {
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => serialize(v)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${serialize(v)}`).join(",")}}`;
}

export function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
