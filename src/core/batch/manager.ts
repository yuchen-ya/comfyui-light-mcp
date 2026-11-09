import { randomUUID } from "node:crypto";
import type { RegisteredWorkflow } from "../workflow/registry.js";
import { validateParams, type ParamIssue } from "../workflow/mapper.js";
import { ComfyLightError } from "../../shared/errors.js";
import { contentFingerprint, fingerprintShort } from "../../shared/fingerprint.js";
import type { BatchStore } from "./store.js";
import { type BatchRow, type JobRow } from "./store.js";

/**
 * Batch Manager（Task 004 §三）：批量创建与查询，不含调度（Scheduler 负责）。
 * - runs 数组 → 单事务创建 batch + 全部 job 行
 * - 部分参数错误：逐 run 独立校验，非法者落 invalid job（带三段式 issues），合法任务不受影响
 * - 幂等（P4.1 加固）：同 idempotency_key 重放时比对请求内容指纹——
 *   相同内容 → 返回既有 batch（不建新行、不产生新提交）；
 *   不同内容 → IDEMPOTENCY_CONFLICT（绝不把同键异容请求混入同一 batch）。
 */

export const MAX_RUNS_PER_BATCH = 200;
export const MAX_ATTEMPTS_LIMIT = 5;

export interface RunSpec {
  label?: string;
  params: Record<string, unknown>;
}

export interface CreateBatchRequest {
  runs: RunSpec[];
  idempotencyKey?: string;
  continueOnError?: boolean;
  maxAttempts?: number;
}

export interface CreateBatchResult {
  batchId: string;
  total: number;
  invalid: number;
  /** true = 幂等键命中既有 batch（本次调用未创建任何记录） */
  reused: boolean;
}

export interface BatchStatsView {
  total: number;
  succeeded: number;
  /** 失败口径：failed + timeout + cancelled（unknown/paused 单列，绝不混入） */
  failed: number;
  running: number;
  queued: number;
  pending: number;
  invalid: number;
  /** submission_unknown 单独呈现 */
  unknown: number;
  /** 工作流版本漂移暂停（P4.1），单独呈现 */
  paused: number;
}

/**
 * 幂等请求指纹（P4.1 §二.4）：覆盖 workflow name / 版本与内容指纹 /
 * runs 内容及顺序 / continue_on_error / max_attempts。
 * canonical JSON（stableStringify）→ JSON 对象键顺序不影响指纹；数组顺序保留（runs 顺序即语义）。
 * 注意与 createBatch 相同的归一化（max_attempts 钳制、label 截断），保证等价请求指纹一致。
 */
export function computeRequestFingerprint(wf: RegisteredWorkflow, req: CreateBatchRequest): string {
  const maxAttempts = Math.min(Math.max(Math.trunc(req.maxAttempts ?? 1), 1), MAX_ATTEMPTS_LIMIT);
  return contentFingerprint({
    workflow: wf.manifest.name,
    workflow_version: wf.manifest.version,
    manifest_fingerprint: wf.fingerprints.manifestFingerprint,
    graph_fingerprint: wf.fingerprints.graphFingerprint,
    continue_on_error: req.continueOnError ?? true,
    max_attempts: maxAttempts,
    runs: (Array.isArray(req.runs) ? req.runs : []).map((r) => ({
      label: typeof r.label === "string" && r.label.length > 0 ? r.label.slice(0, 200) : null,
      params: r.params ?? {}
    }))
  });
}

/**
 * 幂等命中校验：既有 batch 的请求指纹与本次不一致 → 抛 IDEMPOTENCY_CONFLICT。
 * 旧行 request_fingerprint 为 NULL → 无法证明内容一致，返回显式 legacy 冲突（可按 ID 查询）。
 */
export function assertIdempotencyMatch(existing: BatchRow, requestFingerprint: string): void {
  if (existing.request_fingerprint === null) {
    throw new ComfyLightError("LEGACY_IDEMPOTENCY_CONFLICT", "Legacy request fingerprint unavailable; equality cannot be verified. Query the existing batch by ID and reconcile remote work before creating another request.", { existing_batch_id: existing.id });
  }
  if (existing.request_fingerprint === requestFingerprint) return;
  throw new ComfyLightError(
    "IDEMPOTENCY_CONFLICT",
    `idempotency_key 已被内容不同的请求使用（既有 batch ${existing.id.slice(0, 8)} 指纹 ${fingerprintShort(existing.request_fingerprint)}，本次请求指纹 ${fingerprintShort(requestFingerprint)}）。请换用新的 idempotency_key。`,
    {
      existing_batch_id: existing.id,
      existing_fingerprint: existing.request_fingerprint,
      request_fingerprint: requestFingerprint
    }
  );
}

export interface BatchJobView {
  index: number;
  label: string | null;
  status: JobRow["status"];
  attempt_no: number;
  prompt_id: string | null;
  error: { code: string; message: string } | null;
  outputs_count: number;
}

export interface BatchView {
  batch_id: string;
  workflow: string;
  status: BatchRow["status"];
  stats: BatchStatsView;
  jobs: BatchJobView[];
  next_offset: number | null;
}

export class BatchManager {
  constructor(private readonly store: BatchStore) {}

  /**
   * 创建 batch（或幂等命中返回既有；同键不同内容抛 IDEMPOTENCY_CONFLICT）。
   * 结构性错误（runs 非法/超限）抛 ComfyLightError；单 run 参数错误 → invalid job。
   */
  createBatch(wf: RegisteredWorkflow, req: CreateBatchRequest): CreateBatchResult {
    if (req.idempotencyKey) {
      const existing = this.store.getBatchByIdempotencyKey(req.idempotencyKey);
      if (existing) {
        assertIdempotencyMatch(existing, computeRequestFingerprint(wf, req));
        return { batchId: existing.id, total: existing.total, invalid: this.countInvalid(existing.id), reused: true };
      }
    }
    if (!Array.isArray(req.runs) || req.runs.length === 0) {
      throw new ComfyLightError("INVALID_RUNS", "runs 须为非空数组（单运行可继续用 params 简写）");
    }
    if (req.runs.length > MAX_RUNS_PER_BATCH) {
      throw new ComfyLightError("INVALID_RUNS", `runs 数量超过上限 ${MAX_RUNS_PER_BATCH}（实际 ${req.runs.length}）`);
    }
    const maxAttempts = Math.min(Math.max(Math.trunc(req.maxAttempts ?? 1), 1), MAX_ATTEMPTS_LIMIT);

    const batchId = randomUUID();
    const now = new Date().toISOString();
    const batch: BatchRow = {
      id: batchId,
      workflow: wf.manifest.name,
      workflow_version: wf.manifest.version,
      idempotency_key: req.idempotencyKey ?? null,
      status: "running",
      total: req.runs.length,
      options_json: JSON.stringify({
        continue_on_error: req.continueOnError ?? true,
        max_attempts: maxAttempts
      }),
      created_at: now,
      finished_at: null,
      // P4.1：工作流指纹快照（提交/恢复时比对）+ 请求内容指纹（幂等重放比对）
      manifest_fingerprint: wf.fingerprints.manifestFingerprint,
      graph_fingerprint: wf.fingerprints.graphFingerprint,
      request_fingerprint: computeRequestFingerprint(wf, req)
    };

    let invalid = 0;
    const jobs: Array<Omit<JobRow, "batch_id">> = req.runs.map((run, idx) => {
      const label = typeof run.label === "string" && run.label.length > 0 ? run.label.slice(0, 200) : null;
      let status: JobRow["status"] = "pending";
      let errorJson: string | null = null;
      try {
        validateParams(wf.manifest, run.params);
      } catch (e) {
        const issues = e instanceof Error && "issues" in e ? (e as { issues: ParamIssue[] }).issues : [];
        status = "invalid";
        invalid++;
        errorJson = JSON.stringify({
          code: "INVALID_PARAMS",
          message: `run[${idx}]${label ? `(${label})` : ""} 参数校验失败`,
          issues: issues.map((i) => ({ param: i.param, message: i.message.slice(0, 300) }))
        });
      }
      return {
        id: randomUUID(),
        idx,
        label,
        params_json: JSON.stringify(run.params ?? {}),
        resolved_json: null,
        status,
        attempt_no: 0,
        prompt_id: null,
        error_json: errorJson,
        outputs_json: null,
        submitted_at: null,
        started_at: null,
        finished_at: status === "invalid" ? now : null
      };
    });

    try {
      this.store.createBatchWithJobs(batch, jobs);
    } catch (e) {
      // UNIQUE(idempotency_key) 并发竞争：另一请求已用同键创建 → 比对指纹后幂等返回或冲突
      if (req.idempotencyKey && String(e).includes("UNIQUE")) {
        const existing = this.store.getBatchByIdempotencyKey(req.idempotencyKey);
        if (existing) {
          assertIdempotencyMatch(existing, computeRequestFingerprint(wf, req));
          return { batchId: existing.id, total: existing.total, invalid: this.countInvalid(existing.id), reused: true };
        }
      }
      throw e;
    }
    return { batchId, total: jobs.length, invalid, reused: false };
  }

  /** get_batch：汇总统计 + 分页 job 列表（有界字段，不含完整参数/日志/工作流 JSON） */
  getBatchView(batchId: string, opts: { limit?: number; offset?: number; status?: string } = {}): BatchView {
    const batch = this.store.getBatch(batchId);
    if (!batch) {
      throw new ComfyLightError("NOT_FOUND", `batch "${batchId.slice(0, 40)}" 不存在`);
    }
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
    const offset = Math.max(opts.offset ?? 0, 0);
    const stats = this.statsOf(batchId);
    const rows = this.store.listJobs(batchId, { status: opts.status, limit: limit + 1, offset });
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    return {
      batch_id: batchId,
      workflow: batch.workflow,
      status: batch.status,
      stats,
      jobs: page.map((j) => this.jobView(j)),
      next_offset: hasMore ? offset + limit : null
    };
  }

  statsOf(batchId: string): BatchStatsView {
    const counts = this.store.jobStatusCounts(batchId);
    const n = (k: string) => counts[k] ?? 0;
    return {
      total: Object.values(counts).reduce((a, b) => a + b, 0),
      succeeded: n("succeeded"),
      failed: n("failed") + n("timeout") + n("cancelled"),
      running: n("submitting") + n("executing"),
      queued: n("queued"),
      pending: n("pending"),
      invalid: n("invalid"),
      unknown: n("submission_unknown"),
      paused: n("paused")
    };
  }

  private countInvalid(batchId: string): number {
    return this.store.countJobs(batchId, "invalid");
  }

  private jobView(j: JobRow): BatchJobView {
    let error: { code: string; message: string } | null = null;
    if (j.error_json) {
      try {
        const parsed = JSON.parse(j.error_json) as { code?: string; message?: string };
        error = {
          code: String(parsed.code ?? "UNKNOWN"),
          message: String(parsed.message ?? "").slice(0, 200)
        };
      } catch {
        error = { code: "PARSE_ERROR", message: String(j.error_json).slice(0, 200) };
      }
    }
    let outputsCount = 0;
    if (j.outputs_json) {
      try {
        outputsCount = (JSON.parse(j.outputs_json) as unknown[]).length;
      } catch {
        outputsCount = 0;
      }
    }
    return {
      index: j.idx,
      label: j.label,
      status: j.status,
      attempt_no: j.attempt_no,
      prompt_id: j.prompt_id,
      error,
      outputs_count: outputsCount
    };
  }
}
