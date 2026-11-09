import Database from "better-sqlite3";

/**
 * SQLite 打开与迁移。WAL + 外键约束。
 * schema 定义见 docs/002-architecture-design.md §6.1（v1）。
 */

const MIGRATIONS: ReadonlyArray<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
CREATE TABLE batches (
  id               TEXT PRIMARY KEY,
  workflow         TEXT NOT NULL,
  workflow_version INTEGER NOT NULL,
  idempotency_key  TEXT UNIQUE,
  status           TEXT NOT NULL,
  total            INTEGER NOT NULL,
  options_json     TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  finished_at      TEXT
);

CREATE TABLE jobs (
  id            TEXT PRIMARY KEY,
  batch_id      TEXT NOT NULL REFERENCES batches(id),
  idx           INTEGER NOT NULL,
  label         TEXT,
  params_json   TEXT NOT NULL,
  resolved_json TEXT,
  status        TEXT NOT NULL,
  attempt_no    INTEGER NOT NULL DEFAULT 0,
  prompt_id     TEXT,
  error_json    TEXT,
  outputs_json  TEXT,
  submitted_at  TEXT,
  started_at    TEXT,
  finished_at   TEXT,
  UNIQUE (batch_id, idx)
);

CREATE TABLE job_attempts (
  id           TEXT PRIMARY KEY,
  job_id       TEXT NOT NULL REFERENCES jobs(id),
  attempt_no   INTEGER NOT NULL,
  prompt_id    TEXT,
  status       TEXT NOT NULL,
  error_json   TEXT,
  submitted_at TEXT,
  started_at   TEXT,
  finished_at  TEXT,
  UNIQUE (job_id, attempt_no)
);

CREATE TABLE kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX idx_jobs_batch  ON jobs(batch_id, idx);
CREATE INDEX idx_jobs_prompt ON jobs(prompt_id);
CREATE INDEX idx_attempts_prompt ON job_attempts(prompt_id);
CREATE INDEX idx_jobs_recover ON jobs(status)
  WHERE status IN ('submitting','submission_unknown','queued','executing');
`
  },
  {
    // v2（Task 004）：Scheduler 热路径部分索引——待提交扫描与重试扫描。
    // 幂等键约束复用 v1 的 batches.idempotency_key UNIQUE，无新列。
    version: 2,
    sql: `
CREATE INDEX idx_jobs_pending ON jobs(batch_id, idx) WHERE status = 'pending';
CREATE INDEX idx_jobs_retryable ON jobs(batch_id, idx) WHERE status IN ('failed','timeout');
`
  },
  {
    // v3（Task 005 / P4.1）：工作流版本保护 + 幂等指纹。
    // - manifest_fingerprint / graph_fingerprint：batch 创建时的工作流内容快照
    //   （提交/恢复时比对，漂移 → 暂停该 batch 剩余 pending job，不静默用新版本续跑）。
    // - request_fingerprint：批量请求内容指纹（同 idempotency_key 重放时比对，
    //   内容不同 → IDEMPOTENCY_CONFLICT）。旧行为 NULL = 无法比对（v4 采用保守暂停/显式冲突策略）。
    // job 级不复制 workflow JSON —— 指纹在 batch 行，一处存储。
    version: 3,
    sql: `
ALTER TABLE batches ADD COLUMN manifest_fingerprint TEXT;
ALTER TABLE batches ADD COLUMN graph_fingerprint TEXT;
ALTER TABLE batches ADD COLUMN request_fingerprint TEXT;
`
  }
];

export function openDb(file: string | ":memory:"): Database.Database {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  try {
    migrate(db);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

/** 顺序执行未应用的迁移，user_version 记录进度（幂等） */
export function migrate(db: Database.Database): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  if (current > 4) throw new Error(`Unsupported database schema v${current}; preserve the database and use a compatible application version.`);
  db.transaction(() => {
    for (const m of MIGRATIONS) {
      if (m.version <= current) continue;
      db.exec(m.sql);
      db.pragma(`user_version = ${m.version}`);
    }
    if (current < 4) {
      // Experimental 4.1 used raw-text hashes in short columns. Keep those columns
      // for audit, but never reinterpret their values as canonical fingerprints.
      const cols = new Set((db.prepare("PRAGMA table_info(batches)").all() as Array<{ name: string }>).map((c) => c.name));
      for (const name of ["manifest_fingerprint", "graph_fingerprint", "request_fingerprint"]) {
        if (!cols.has(name)) db.exec(`ALTER TABLE batches ADD COLUMN ${name} TEXT`);
      }
      db.exec(`
ALTER TABLE job_attempts ADD COLUMN deadline_at TEXT;
ALTER TABLE job_attempts ADD COLUMN cancel_requested_at TEXT;
ALTER TABLE job_attempts ADD COLUMN success_observed_at TEXT;
ALTER TABLE job_attempts ADD COLUMN terminal_confirmed INTEGER NOT NULL DEFAULT 0;
UPDATE job_attempts SET cancel_requested_at = COALESCE(finished_at, submitted_at, CURRENT_TIMESTAMP)
WHERE job_id IN (SELECT j.id FROM jobs j JOIN batches b ON b.id = j.batch_id
  WHERE b.status = 'running' AND j.status = 'timeout') AND attempt_no = (SELECT attempt_no FROM jobs WHERE id = job_id);
UPDATE job_attempts SET success_observed_at = COALESCE(finished_at, submitted_at, CURRENT_TIMESTAMP)
WHERE job_id IN (SELECT j.id FROM jobs j JOIN batches b ON b.id = j.batch_id
  WHERE b.status = 'running' AND json_extract(j.error_json, '$.code') = 'NO_HISTORY') AND attempt_no = (SELECT attempt_no FROM jobs WHERE id = job_id);
UPDATE jobs SET status = 'submission_unknown', finished_at = NULL,
  error_json = '{"code":"LEGACY_TERMINAL_UNVERIFIED","message":"Legacy terminal outcome has no remote confirmation; reconciliation required before retry."}'
WHERE status IN ('failed','timeout') AND prompt_id IS NOT NULL AND batch_id IN (SELECT id FROM batches WHERE status = 'running');
UPDATE job_attempts SET status = 'submission_unknown', finished_at = NULL,
  error_json = (SELECT error_json FROM jobs WHERE id = job_attempts.job_id)
WHERE EXISTS (SELECT 1 FROM jobs j WHERE j.id = job_attempts.job_id AND j.attempt_no = job_attempts.attempt_no
  AND j.status = 'submission_unknown' AND json_extract(j.error_json, '$.code') = 'LEGACY_TERMINAL_UNVERIFIED');
UPDATE jobs SET status = 'paused', error_json = '{"code":"LEGACY_SNAPSHOT_MISSING","message":"Historical workflow snapshot unavailable; pending work requires review and will not resume automatically."}'
WHERE status = 'pending' AND batch_id IN (
  SELECT id FROM batches WHERE manifest_fingerprint IS NULL OR graph_fingerprint IS NULL
);
`);
      db.pragma("user_version = 4");
    }
  })();
}
