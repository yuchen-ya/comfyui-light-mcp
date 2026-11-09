import Database from "better-sqlite3";

/** Schema fixture from P3/v2; variants reproduce experimental v3s and released v4. */
export function legacyDb(file: string, variant: "v2" | "4.1" | "4.1new" | "v4"): Database.Database {
  const db = new Database(file);
  db.exec(`
CREATE TABLE batches (id TEXT PRIMARY KEY, workflow TEXT NOT NULL, workflow_version INTEGER NOT NULL,
  idempotency_key TEXT UNIQUE, status TEXT NOT NULL, total INTEGER NOT NULL, options_json TEXT NOT NULL,
  created_at TEXT NOT NULL, finished_at TEXT);
CREATE TABLE jobs (id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES batches(id), idx INTEGER NOT NULL,
  label TEXT, params_json TEXT NOT NULL, resolved_json TEXT, status TEXT NOT NULL, attempt_no INTEGER NOT NULL DEFAULT 0,
  prompt_id TEXT, error_json TEXT, outputs_json TEXT, submitted_at TEXT, started_at TEXT, finished_at TEXT, UNIQUE(batch_id, idx));
CREATE TABLE job_attempts (id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), attempt_no INTEGER NOT NULL,
  prompt_id TEXT, status TEXT NOT NULL, error_json TEXT, submitted_at TEXT, started_at TEXT, finished_at TEXT, UNIQUE(job_id, attempt_no));
CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE INDEX idx_jobs_pending ON jobs(batch_id, idx) WHERE status = 'pending';
CREATE INDEX idx_jobs_retryable ON jobs(batch_id, idx) WHERE status IN ('failed','timeout');
`);
  if (variant !== "v2") {
    for (const prefix of ["manifest", "graph", "request"]) {
      db.exec(`ALTER TABLE batches ADD COLUMN ${prefix}_${variant === "4.1" ? "fp" : "fingerprint"} TEXT`);
    }
  }
  if (variant === "v4") {
    db.exec(`
ALTER TABLE job_attempts ADD COLUMN deadline_at TEXT;
ALTER TABLE job_attempts ADD COLUMN cancel_requested_at TEXT;
ALTER TABLE job_attempts ADD COLUMN success_observed_at TEXT;
ALTER TABLE job_attempts ADD COLUMN terminal_confirmed INTEGER NOT NULL DEFAULT 0;
`);
  }
  db.pragma(`user_version = ${variant === "v2" ? 2 : variant === "v4" ? 4 : 3}`);
  return db;
}
