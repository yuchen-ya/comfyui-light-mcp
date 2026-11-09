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
    //   内容不同 → IDEMPOTENCY_CONFLICT）。旧行为 NULL = 无法比对（尽力兼容）。
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
  migrate(db);
  return db;
}

/** 顺序执行未应用的迁移，user_version 记录进度（幂等） */
export function migrate(db: Database.Database): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    db.exec(m.sql);
    db.pragma(`user_version = ${m.version}`);
  }
}
