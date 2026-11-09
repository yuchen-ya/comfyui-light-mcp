import { randomUUID } from "node:crypto";
import type { RegisteredWorkflow } from "../workflow/registry.js";
import { validateParams, type ParamIssue } from "../workflow/mapper.js";
import { ComfyLightError } from "../../shared/errors.js";
import { canonicalSha256 } from "../../shared/fingerprint.js";
import type { BatchStore } from "./store.js";
import { type BatchRow, type JobRow } from "./store.js";

/**
 * Batch Manager（Task 004 §三 + Task 005 §二.4 幂等指纹）：批量创建与查询，不含调度。
 * - runs 数组 → 单事务创建 batch + 全部 job 行
 * - 部分参数错误：逐 run 独立校验，非法者落 invalid job（带三段式 issues），合法任务不受影响
 * - 幂等：同 idempotency_key + 相同请求指纹 → 返回既有 batch；不同请求内容 → IDEMPOTENCY_CONFLICT
 */

/**
 * 幂等请求指纹（canonical JSON，对象键序无关）：
 * workflow 名 + 内容指纹 + runs（label+params，保序）+ 归一化的 continue_on_error/max_attempts。
 */
export function requestFingerprint(
  wf: RegisteredWorkflow,
  req: { runs: RunSpec[]; continueOnError?: boolean; maxAttempts?: number }
): string {
  const maxAttempts = Math.min(Math.max(Math.trunc(req.maxAttempts ?? 1), 1), MAX_ATTEMPTS_LIMIT);
  return canonicalSha256({
    workflow: wf.manifest.name,
    manifest_fp: wf.fingerprint.manifest,
    graph_fp: wf.fingerprint.graph,
    runs: req.runs.map((r) => ({ label: r.label ?? null, params: r.params })),
    continue_on_error: req.continueOnError ?? true,
    max_attempts: maxAttempts
  });
}

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
  /** 失败口径：failed + timeout + cancelled（unknown 单列，绝不混入） */
  failed: number;
  running: number;
  queued: number;
  pending: number;
  invalid: number;
  /** submission_unknown 单独呈现 */
  unknown: number;
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
   * 幂等预检（不落库）：键命中且请求指纹一致 → 返回 reused 结果；
   * 键命中但指纹不同 → IDEMPOTENCY_CONFLICT；未命中 → null。
   * 供 engine 在连通性检查之前调用（离线重放幂等请求仍可返回既有 batch）。
   */
  resolveExisting(wf: RegisteredWorkflow, req: CreateBatchRequest): CreateBatchResult | null {
    if (!req.idempotencyKey) return null;
    const existing = this.store.getBatchByIdempotencyKey(req.idempotencyKey);
    if (!existing) return null;
    return this.reuseOrConflict(existing, requestFingerprint(wf, req));
  }

  /** 既有 batch 的指纹比对：一致 → reused；不同 → IDEMPOTENCY_CONFLICT（自愈提示） */
  private reuseOrConflict(existing: BatchRow, fp: string): CreateBatchResult {
    if (existing.request_fp && existing.request_fp !== fp) {
      throw new ComfyLightError(
        "IDEMPOTENCY_CONFLICT",
        `idempotency_key "${existing.idempotency_key}" 已绑定另一请求（batch ${existing.id}，指纹 ${existing.request_fp.slice(0, 12)}≠本次 ${fp.slice(0, 12)}）。` +
          "同一键只允许重放完全相同的请求；内容已变请换新键，或确认 runs/选项与首次一致后重试。"
      );
    }
    return { batchId: existing.id, total: existing.total, invalid: this.countInvalid(existing.id), reused: true };
  }

  /**
   * 创建 batch（或幂等命中返回既有）。
   * 结构性错误（runs 非法/超限）抛 ComfyLightError；单 run 参数错误 → invalid job。
   */
  createBatch(wf: RegisteredWorkflow, req: CreateBatchRequest): CreateBatchResult {
    const requestFp = requestFingerprint(wf, req);
    if (req.idempotencyKey) {
      const existing = this.store.getBatchByIdempotencyKey(req.idempotencyKey);
      if (existing) return this.reuseOrConflict(existing, requestFp);
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
      // 工作流版本保护（Task 005 §二.2）：创建时的内容指纹快照
      manifest_fp: wf.fingerprint.manifest,
      graph_fp: wf.fingerprint.graph,
      request_fp: requestFp
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
      // UNIQUE(idempotency_key) 并发竞争：另一请求已用同键创建 → 按指纹比对（一致 reused / 不同 conflict）
      if (req.idempotencyKey && String(e).includes("UNIQUE")) {
        const existing = this.store.getBatchByIdempotencyKey(req.idempotencyKey);
        if (existing) return this.reuseOrConflict(existing, requestFp);
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
      unknown: n("submission_unknown")
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
