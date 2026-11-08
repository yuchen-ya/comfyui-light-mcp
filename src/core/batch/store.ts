import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

/**
 * Batch/Job 存取层（Task 004 起 Batch Manager / Scheduler / get_batch 复用）。
 * 状态词表（get_batch/工具必须原样区分，不得合并）：
 *   pending | invalid | submitting | submission_unknown | queued | executing
 *   | succeeded | failed | timeout | cancelled
 * submission_unknown 语义（Task 003 A1，已批准）：
 *   提交已发出但结果未知；history/queue 查证不到时【保持该状态】，
 *   不伪装成 failed、不自动重提；计入在途窗口（可能仍在远端执行）。
 */

export type JobStatus =
  | "pending"
  | "invalid"
  | "submitting"
  | "submission_unknown"
  | "queued"
  | "executing"
  | "succeeded"
  | "failed"
  | "timeout"
  | "cancelled";

export type BatchStatus = "running" | "completed" | "partial" | "failed" | "cancelled";

export const IN_FLIGHT_STATUSES: readonly JobStatus[] = [
  "submitting",
  "submission_unknown",
  "queued",
  "executing"
];

export interface JobRow {
  id: string;
  batch_id: string;
  idx: number;
  label: string | null;
  params_json: string;
  resolved_json: string | null;
  status: JobStatus;
  attempt_no: number;
  prompt_id: string | null;
  error_json: string | null;
  outputs_json: string | null;
  submitted_at: string | null;
  started_at: string | null;
  finished_at: string | null;
}

export interface BatchRow {
  id: string;
  workflow: string;
  workflow_version: number;
  idempotency_key: string | null;
  status: BatchStatus;
  total: number;
  options_json: string;
  created_at: string;
  finished_at: string | null;
}

export interface JobOutputAsset {
  kind: "image" | "video" | "audio" | "file";
  filename: string;
  subfolder: string;
  type: string;
  local_path: string;
  bytes: number;
}

export interface JobError {
  code: string;
  message: string;
  node_errors?: unknown;
  /** 超时取消的远端动作结果（queued→queue delete / executing→interrupt） */
  remote_cancel?: { queue_delete: string; interrupt: string };
}

/** 批量执行选项（batches.options_json） */
export interface BatchOptions {
  continue_on_error: boolean;
  max_attempts: number;
}

export function parseBatchOptions(json: string): BatchOptions {
  try {
    const o = JSON.parse(json) as Partial<BatchOptions>;
    return {
      continue_on_error: o.continue_on_error !== false,
      max_attempts: typeof o.max_attempts === "number" && o.max_attempts >= 1 ? o.max_attempts : 1
    };
  } catch {
    return { continue_on_error: true, max_attempts: 1 };
  }
}

const JOB_COLS = [
  "id", "batch_id", "idx", "label", "params_json", "resolved_json", "status",
  "attempt_no", "prompt_id", "error_json", "outputs_json",
  "submitted_at", "started_at", "finished_at"
] as const;

export class BatchStore {
  constructor(private readonly db: Database.Database) {}

  /** 在单个 SQLite 事务中执行（初始记录创建必须原子，Task 004 §三） */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  createBatch(b: BatchRow): void {
    this.db
      .prepare(
        `INSERT INTO batches (id, workflow, workflow_version, idempotency_key, status, total, options_json, created_at, finished_at)
         VALUES (@id, @workflow, @workflow_version, @idempotency_key, @status, @total, @options_json, @created_at, @finished_at)`
      )
      .run(b as unknown as Record<string, unknown>);
  }

  /** 批量初始创建：batch + 全部 job 行一次事务落库（部分失败整体回滚） */
  createBatchWithJobs(b: BatchRow, jobs: Array<Omit<JobRow, "batch_id">>): void {
    this.transaction(() => {
      this.createBatch(b);
      for (const j of jobs) this.createJob({ ...j, batch_id: b.id });
    });
  }

  getBatch(id: string): BatchRow | undefined {
    return this.db.prepare("SELECT * FROM batches WHERE id = ?").get(id) as BatchRow | undefined;
  }

  getBatchByIdempotencyKey(key: string): BatchRow | undefined {
    return this.db
      .prepare("SELECT * FROM batches WHERE idempotency_key = ?")
      .get(key) as BatchRow | undefined;
  }

  updateBatchStatus(id: string, status: BatchStatus, finishedAt: string | null): void {
    this.db.prepare("UPDATE batches SET status = ?, finished_at = ? WHERE id = ?").run(status, finishedAt, id);
  }

  createJob(j: JobRow): void {
    this.db
      .prepare(
        `INSERT INTO jobs (${JOB_COLS.join(", ")})
         VALUES (@${JOB_COLS.join(", @")})`
      )
      .run(j as unknown as Record<string, unknown>);
  }

  getJob(batchId: string, idx: number): JobRow | undefined {
    return this.db
      .prepare("SELECT * FROM jobs WHERE batch_id = ? AND idx = ?")
      .get(batchId, idx) as JobRow | undefined;
  }

  getJobById(id: string): JobRow | undefined {
    return this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | undefined;
  }

  patchJob(id: string, patch: Partial<Pick<JobRow, "status" | "prompt_id" | "error_json" | "outputs_json" | "resolved_json" | "attempt_no" | "started_at" | "finished_at" | "submitted_at">>): void {
    const keys = Object.keys(patch) as Array<keyof typeof patch>;
    if (keys.length === 0) return;
    const sets = keys.map((k) => `${k} = @${k}`).join(", ");
    this.db
      .prepare(`UPDATE jobs SET ${sets} WHERE id = @id`)
      .run({ ...patch, id } as Record<string, unknown>);
  }

  insertAttempt(a: {
    id: string; job_id: string; attempt_no: number; prompt_id: string | null;
    status: string; submitted_at?: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO job_attempts (id, job_id, attempt_no, prompt_id, status, submitted_at)
         VALUES (@id, @job_id, @attempt_no, @prompt_id, @status, @submitted_at)`
      )
      .run({ submitted_at: null, ...a } as Record<string, unknown>);
  }

  getAttempts(jobId: string): Array<{ attempt_no: number; prompt_id: string | null; status: string; submitted_at: string | null }> {
    return this.db
      .prepare("SELECT attempt_no, prompt_id, status, submitted_at FROM job_attempts WHERE job_id = ? ORDER BY attempt_no")
      .all(jobId) as Array<{ attempt_no: number; prompt_id: string | null; status: string; submitted_at: string | null }>;
  }

  /** 服务端回显了不同 prompt_id 时同步 attempt 行（历史记录以实际生效 id 为准） */
  patchAttemptPrompt(jobId: string, attemptNo: number, promptId: string): void {
    this.db
      .prepare("UPDATE job_attempts SET prompt_id = ? WHERE job_id = ? AND attempt_no = ?")
      .run(promptId, jobId, attemptNo);
  }

  /** attempt 终态回写（job 定终态时同步该次尝试的 status/finished_at，审计历史完整） */
  patchAttemptStatus(jobId: string, attemptNo: number, status: string, finishedAt: string): void {
    this.db
      .prepare("UPDATE job_attempts SET status = ?, finished_at = ? WHERE job_id = ? AND attempt_no = ?")
      .run(status, finishedAt, jobId, attemptNo);
  }

  /**
   * 条件占位提交（Scheduler 防重复提交的关键）：
   * 仅当 job 仍为 pending 时，在同一事务内 → status=submitting、写入新 prompt_id、
   * attempt_no+1、resolved_json，并预写 attempt 行（先落库后 POST，A1 顺序不变）。
   * 返回 null 表示占位失败（已被其他提交路径处理/状态已变）。
   */
  claimForSubmit(
    jobId: string,
    promptId: string,
    resolvedJson: string,
    submittedAt: string
  ): { attemptNo: number } | null {
    return this.transaction(() => {
      const job = this.getJobById(jobId);
      if (!job || job.status !== "pending") return null;
      const attemptNo = job.attempt_no + 1;
      this.patchJob(jobId, {
        status: "submitting",
        prompt_id: promptId,
        attempt_no: attemptNo,
        resolved_json: resolvedJson,
        submitted_at: submittedAt,
        error_json: null
      });
      this.insertAttempt({
        id: randomUUID(),
        job_id: jobId,
        attempt_no: attemptNo,
        prompt_id: promptId,
        status: "submitting",
        submitted_at: submittedAt
      });
      return { attemptNo };
    });
  }

  /** 失败重试：failed/timeout → pending（新 prompt_id 在下次占位时生成；attempt 历史保留） */
  resetForRetry(jobId: string): boolean {
    const r = this.db
      .prepare("UPDATE jobs SET status = 'pending', finished_at = NULL WHERE id = ? AND status IN ('failed','timeout')")
      .run(jobId);
    return r.changes > 0;
  }

  /** 恢复扫描：全部在途 job（部分索引命中） */
  inFlightJobs(): JobRow[] {
    const qs = IN_FLIGHT_STATUSES.map(() => "?").join(",");
    return this.db
      .prepare(`SELECT * FROM jobs WHERE status IN (${qs}) ORDER BY batch_id, idx`)
      .all(...IN_FLIGHT_STATUSES) as JobRow[];
  }

  /** 全局双窗口计数（跨 batch）：inFlight = submitting/unknown/queued/executing；queued 仅排队态 */
  windowCounts(): { inFlight: number; queued: number } {
    const row = this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN status IN ('submitting','submission_unknown','queued','executing') THEN 1 ELSE 0 END) AS in_flight,
           SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued
         FROM jobs`
      )
      .get() as { in_flight: number | null; queued: number | null };
    return { inFlight: row.in_flight ?? 0, queued: row.queued ?? 0 };
  }

  /** 下一个待提交 job（全局 FIFO：按 batch 创建序 rowid、batch 内按 index；同毫秒创建也稳定） */
  nextPendingJob(): { job: JobRow; workflow: string } | null {
    const row = this.db
      .prepare(
        `SELECT j.*, b.workflow AS batch_workflow FROM jobs j JOIN batches b ON j.batch_id = b.id
         WHERE j.status = 'pending' ORDER BY b.rowid, j.idx LIMIT 1`
      )
      .get() as (JobRow & { batch_workflow: string }) | undefined;
    if (!row) return null;
    const { batch_workflow, ...job } = row;
    return { job, workflow: batch_workflow };
  }

  /** 重试候选：failed/timeout 且 attempt_no < batch.max_attempts（submission_unknown 永不自动重试） */
  retryEligibleJobs(): JobRow[] {
    const rows = this.db
      .prepare(
        `SELECT j.*, b.options_json AS batch_options FROM jobs j JOIN batches b ON j.batch_id = b.id
         WHERE j.status IN ('failed','timeout') ORDER BY b.rowid, j.idx`
      )
      .all() as Array<JobRow & { batch_options: string }>;
    return rows.filter((r) => {
      const opts = parseBatchOptions(r.batch_options);
      return r.attempt_no < opts.max_attempts;
    });
  }

  /** continue_on_error=false 的 batch：已有终态失败的，返回其 id（剩余 pending 将被放弃） */
  batchesNeedingAbort(): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT b.id FROM batches b
         JOIN jobs j ON j.batch_id = b.id
         WHERE b.status = 'running' AND j.status IN ('failed','timeout','invalid')`
      )
      .all() as Array<{ id: string }>;
    return rows
      .filter((r) => {
        const b = this.getBatch(r.id)!;
        return !parseBatchOptions(b.options_json).continue_on_error;
      })
      .map((r) => r.id);
  }

  /** 放弃 batch 内全部 pending job（continue_on_error=false 时级联） */
  abortPendingJobs(batchId: string, reason: string): number {
    return this.db
      .prepare(
        `UPDATE jobs SET status = 'cancelled', error_json = ?, finished_at = ?
         WHERE batch_id = ? AND status = 'pending'`
      )
      .run(
        JSON.stringify({ code: "BATCH_ABORTED", message: reason }),
        new Date().toISOString(),
        batchId
      ).changes;
  }

  /** job 状态直方图（get_batch stats） */
  jobStatusCounts(batchId: string): Record<string, number> {
    const rows = this.db
      .prepare("SELECT status, COUNT(*) AS n FROM jobs WHERE batch_id = ? GROUP BY status")
      .all(batchId) as Array<{ status: string; n: number }>;
    const counts: Record<string, number> = {};
    for (const r of rows) counts[r.status] = r.n;
    return counts;
  }

  /** job 分页（get_batch；可选状态过滤，按 index 升序） */
  listJobs(batchId: string, opts: { status?: string; limit: number; offset: number }): JobRow[] {
    const status = opts.status === "unknown" ? "submission_unknown" : opts.status; // 统计口径别名
    if (status) {
      return this.db
        .prepare("SELECT * FROM jobs WHERE batch_id = ? AND status = ? ORDER BY idx LIMIT ? OFFSET ?")
        .all(batchId, status, opts.limit, opts.offset) as JobRow[];
    }
    return this.db
      .prepare("SELECT * FROM jobs WHERE batch_id = ? ORDER BY idx LIMIT ? OFFSET ?")
      .all(batchId, opts.limit, opts.offset) as JobRow[];
  }

  countJobs(batchId: string, status?: string): number {
    if (status) {
      const r = this.db
        .prepare("SELECT COUNT(*) AS n FROM jobs WHERE batch_id = ? AND status = ?")
        .get(batchId, status) as { n: number };
      return r.n;
    }
    const r = this.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE batch_id = ?").get(batchId) as { n: number };
    return r.n;
  }

  /**
   * 由 jobs 推导 batch 状态（全部终态才收敛）。
   * - submission_unknown 计入"未决"（可能仍在执行）→ batch 保持 running，不得伪装成 failed。
   * - failed/timeout 但重试次数未用尽（attempt_no < max_attempts）也计入未决
   *   （Scheduler 下一 tick 会重置为 pending 再提交）。
   */
  recomputeBatchStatus(batchId: string): { status: BatchStatus; finished: boolean } {
    const batch = this.getBatch(batchId);
    const opts = batch ? parseBatchOptions(batch.options_json) : { continue_on_error: true, max_attempts: 1 };
    const rows = this.db
      .prepare("SELECT status, attempt_no FROM jobs WHERE batch_id = ?")
      .all(batchId) as Array<{ status: JobStatus; attempt_no: number }>;
    const total = rows.length;
    if (total === 0) return { status: "running", finished: false };
    const succeeded = rows.filter((r) => r.status === "succeeded").length;
    const retryPending = rows.filter(
      (r) => (r.status === "failed" || r.status === "timeout") && r.attempt_no < opts.max_attempts
    ).length;
    const failures = rows.filter(
      (r) =>
        (r.status === "failed" || r.status === "timeout" || r.status === "invalid" || r.status === "cancelled") &&
        !((r.status === "failed" || r.status === "timeout") && r.attempt_no < opts.max_attempts)
    ).length;
    const unresolved = total - succeeded - failures - retryPending; // pending/submitting/submission_unknown/queued/executing
    if (unresolved > 0 || retryPending > 0) return { status: "running", finished: false };
    let status: BatchStatus;
    if (succeeded === total) status = "completed";
    else if (succeeded > 0) status = "partial";
    else status = "failed";
    return { status, finished: true };
  }
}
