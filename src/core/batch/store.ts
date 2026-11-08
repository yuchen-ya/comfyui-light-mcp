import type Database from "better-sqlite3";

/**
 * Batch/Job 存取层（P2 最小实现，P3 Batch Manager 复用同一 schema）。
 * 状态词表（get_batch/未来工具必须原样区分，不得合并）：
 *   pending | invalid | submitting | submission_unknown | queued | executing
 *   | succeeded | failed | timeout | cancelled
 * submission_unknown 语义（Task 003 A1，已批准）：
 *   提交已发出但结果未知；history/queue 查证不到时【保持该状态】，
 *   不伪装成 failed、不自动重提。
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
}

const JOB_COLS = [
  "id", "batch_id", "idx", "label", "params_json", "resolved_json", "status",
  "attempt_no", "prompt_id", "error_json", "outputs_json",
  "submitted_at", "started_at", "finished_at"
] as const;

export class BatchStore {
  constructor(private readonly db: Database.Database) {}

  createBatch(b: BatchRow): void {
    this.db
      .prepare(
        `INSERT INTO batches (id, workflow, workflow_version, idempotency_key, status, total, options_json, created_at, finished_at)
         VALUES (@id, @workflow, @workflow_version, @idempotency_key, @status, @total, @options_json, @created_at, @finished_at)`
      )
      .run(b as unknown as Record<string, unknown>);
  }

  getBatch(id: string): BatchRow | undefined {
    return this.db.prepare("SELECT * FROM batches WHERE id = ?").get(id) as BatchRow | undefined;
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

  /** 恢复扫描：全部在途 job（部分索引命中） */
  inFlightJobs(): JobRow[] {
    const qs = IN_FLIGHT_STATUSES.map(() => "?").join(",");
    return this.db
      .prepare(`SELECT * FROM jobs WHERE status IN (${qs}) ORDER BY batch_id, idx`)
      .all(...IN_FLIGHT_STATUSES) as JobRow[];
  }

  /**
   * 由 jobs 推导 batch 状态（全部终态才收敛）。
   * submission_unknown 计入"未决"（可能仍在执行）→ batch 保持 running，不得伪装成 failed。
   */
  recomputeBatchStatus(batchId: string): { status: BatchStatus; finished: boolean } {
    const rows = this.db
      .prepare("SELECT status FROM jobs WHERE batch_id = ?")
      .all(batchId) as Array<{ status: JobStatus }>;
    const total = rows.length;
    if (total === 0) return { status: "running", finished: false };
    const succeeded = rows.filter((r) => r.status === "succeeded").length;
    const failures = rows.filter((r) =>
      r.status === "failed" || r.status === "timeout" || r.status === "invalid" || r.status === "cancelled"
    ).length;
    const unresolved = total - succeeded - failures; // pending/submitting/submission_unknown/queued/executing
    if (unresolved > 0) return { status: "running", finished: false };
    let status: BatchStatus;
    if (succeeded === total) status = "completed";
    else if (succeeded > 0) status = "partial";
    else status = "failed";
    return { status, finished: true };
  }
}
