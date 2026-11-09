import { createHash } from "node:crypto";

/**
 * 内容指纹（P4.1）：canonical JSON（键序无关）→ sha256。
 * - stableStringify：递归排序对象键，数组保持顺序，跳过 undefined 值
 *   → JSON 对象键顺序不影响指纹（幂等 fingerprint 要求）。
 * - contentFingerprint：stableStringify 的 sha256 十六进制（64 位）。
 */

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortValue);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const item = (v as Record<string, unknown>)[k];
      if (item === undefined) continue; // undefined 不参与（与 JSON.stringify 一致）
      out[k] = sortValue(item);
    }
    return out;
  }
  return v;
}

export function contentFingerprint(value: unknown): string {
  return sha256Hex(stableStringify(value));
}

/** 指纹短前缀（错误消息/日志用，12 位足够定位） */
export function fingerprintShort(fp: string | null | undefined): string {
  if (!fp) return "<none>";
  return fp.slice(0, 12);
}
