import { fingerprintShort } from "../../shared/fingerprint.js";

/**
 * 工作流内容指纹与漂移判定（P4.1 工作流版本保护）。
 * - manifestFingerprint：manifest 解析后对象（zod 校验通过的字段）的 canonical sha256
 *   —— 排版/键序变化不影响，语义内容变化必然反映。
 * - graphFingerprint：注册时加载归一化后的 API 图（class_type+inputs，即实际提交给
 *   ComfyUI 的内容）的 canonical sha256 —— 图的实际执行内容变化必然反映。
 * - 旧库行（v3 迁移前创建的 batch）指纹列为 NULL → 视为不可比对，跳过校验（向后兼容）。
 */

export interface WorkflowFingerprints {
  readonly manifestFingerprint: string;
  readonly graphFingerprint: string;
}

/** batch 行里存的指纹快照（v3 前旧行为 NULL） */
export interface StoredWorkflowSnapshot {
  workflowVersion: number;
  manifestFingerprint: string | null;
  graphFingerprint: string | null;
}

/**
 * 判定 batch 创建时快照与当前注册工作流是否漂移。
 * 返回 null = 一致（或旧行无法比对）；返回字符串 = 人类可读的差异明细。
 */
export function fingerprintMismatch(
  stored: StoredWorkflowSnapshot,
  current: { version: number } & WorkflowFingerprints
): string | null {
  // 旧行（v2 库迁移上来的 batch）：无指纹可比对 → 不阻断（尽力兼容，docs/006 §二）
  if (stored.manifestFingerprint === null && stored.graphFingerprint === null) return null;
  const parts: string[] = [];
  if (stored.manifestFingerprint !== null && stored.manifestFingerprint !== current.manifestFingerprint) {
    parts.push(`manifest 指纹已变化（创建时 ${fingerprintShort(stored.manifestFingerprint)}，当前 ${fingerprintShort(current.manifestFingerprint)}）`);
  }
  if (stored.graphFingerprint !== null && stored.graphFingerprint !== current.graphFingerprint) {
    parts.push(`工作流图指纹已变化（创建时 ${fingerprintShort(stored.graphFingerprint)}，当前 ${fingerprintShort(current.graphFingerprint)}）`);
  }
  if (stored.workflowVersion !== current.version) {
    parts.push(`manifest 版本已变化（创建时 v${stored.workflowVersion}，当前 v${current.version}）`);
  }
  return parts.length > 0 ? parts.join("；") : null;
}
