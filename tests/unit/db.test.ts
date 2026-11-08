import { describe, expect, it } from "vitest";
import { openDb } from "../../src/core/storage/db.js";

describe("storage db", () => {
  it("打开即迁移到 v2（user_version=2），幂等", () => {
    const db = openDb(":memory:");
    expect(db.pragma("user_version", { simple: true })).toBe(2);
    db.close();
    const db2 = openDb(":memory:");
    expect(db2.pragma("user_version", { simple: true })).toBe(2);
    db2.close();
  });

  it("四张表与恢复/调度用部分索引存在", () => {
    const db = openDb(":memory:");
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    for (const t of ["batches", "jobs", "job_attempts", "kv"]) {
      expect(tables.map((r) => r.name)).toContain(t);
    }
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index'")
      .all() as Array<{ name: string }>;
    expect(indexes.map((r) => r.name)).toContain("idx_jobs_recover");
    expect(indexes.map((r) => r.name)).toContain("idx_jobs_pending"); // v2 调度热路径
    expect(indexes.map((r) => r.name)).toContain("idx_jobs_retryable"); // v2 重试扫描
    db.close();
  });

  it("batch/job/attempt 完整写入与唯一约束", () => {
    const db = openDb(":memory:");
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO batches (id, workflow, workflow_version, status, total, options_json, created_at) VALUES (?,?,?,?,?,?,?)"
    ).run("b1", "demo", 1, "running", 2, "{}", now);

    const insJob = db.prepare(
      "INSERT INTO jobs (id, batch_id, idx, params_json, resolved_json, status, attempt_no, prompt_id) VALUES (?,?,?,?,?,?,?,?)"
    );
    const p1 = JSON.stringify({ prompt: "a" });
    const p2 = JSON.stringify({ prompt: "a", seed: 42 });
    insJob.run("j1", "b1", 0, p1, p2, "succeeded", 1, "pid-1");
    insJob.run("j2", "b1", 1, "{}", null, "invalid", 0, null);

    // (batch_id, idx) 唯一
    expect(() => insJob.run("j3", "b1", 1, "{}", null, "pending", 0, null)).toThrow();

    const insAtt = db.prepare(
      "INSERT INTO job_attempts (id, job_id, attempt_no, prompt_id, status) VALUES (?,?,?,?,?)"
    );
    insAtt.run("a1", "j1", 1, "pid-1", "succeeded");
    // (job_id, attempt_no) 唯一
    expect(() => insAtt.run("a2", "j1", 1, "pid-1", "failed")).toThrow();
    // 外键
    expect(() => insAtt.run("a3", "no-such-job", 1, "x", "failed")).toThrow();

    const row = db.prepare("SELECT status, prompt_id FROM jobs WHERE batch_id='b1' AND idx=0").get() as {
      status: string;
      prompt_id: string | null;
    };
    expect(row).toEqual({ status: "succeeded", prompt_id: "pid-1" });
    db.close();
  });

  it("恢复部分索引覆盖 submission_unknown 在途态", () => {
    const db = openDb(":memory:");
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO batches (id, workflow, workflow_version, status, total, options_json, created_at) VALUES (?,?,?,?,?,?,?)"
    ).run("b1", "demo", 1, "running", 1, "{}", now);
    db.prepare("INSERT INTO jobs (id, batch_id, idx, params_json, status) VALUES (?,?,?,?,?)").run(
      "j1",
      "b1",
      0,
      "{}",
      "submission_unknown"
    );
    const cnt = db
      .prepare("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('submitting','submission_unknown','queued','executing')")
      .get() as { n: number };
    expect(cnt.n).toBe(1);
    db.close();
  });
});
