import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb } from "../../src/core/storage/db.js";
import { legacyDb } from "../helpers/legacy-db.js";

describe("storage db", () => {
  it("v1 disk database preserves existing data through v2-v5 and reopening", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "migration-v1-"));
    const file = path.join(dir, "legacy.db");
    const old = legacyDb(file, "v2");
    old.exec("DROP INDEX idx_jobs_pending; DROP INDEX idx_jobs_retryable");
    old.pragma("user_version = 1");
    old.prepare("INSERT INTO kv (key,value) VALUES (?,?)").run("existing", "preserved");
    old.close();
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const db = openDb(file);
        try {
          expect(db.pragma("user_version", { simple: true })).toBe(5);
          expect(db.prepare("SELECT value FROM kv WHERE key='existing'").get()).toEqual({ value: "preserved" });
          expect(db.prepare("SELECT name FROM sqlite_master WHERE name='idx_jobs_pending'").get()).toBeDefined();
          expect(db.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
          expect(db.pragma("foreign_key_check")).toEqual([]);
        } finally {
          db.close();
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a newer schema without altering its version or stored data", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "migration-newer-"));
    const file = path.join(dir, "newer.db");
    const db = openDb(file);
    db.prepare("INSERT INTO kv (key,value) VALUES (?,?)").run("existing", "preserved");
    db.pragma("user_version = 6");
    db.close();
    try {
      expect(() => openDb(file)).toThrow(/Unsupported database schema v6/);
      const newer = new Database(file, { readonly: true });
      try {
        expect(newer.pragma("user_version", { simple: true })).toBe(6);
        expect(newer.prepare("SELECT value FROM kv WHERE key='existing'").get()).toEqual({ value: "preserved" });
      } finally {
        newer.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each([4, 5])("schema v%s gains a persistent guard that rejects legacy writes and permits main after reopening", async (version) => {
    const dir = await mkdtemp(path.join(tmpdir(), "writer-guard-"));
    const file = path.join(dir, "guard.db");
    const old = legacyDb(file, "v4");
    old.pragma(`user_version = ${version}`);
    old.close();
    const db = openDb(file);
    db.prepare("INSERT INTO kv (key,value) VALUES (?,?)").run("probe", "before");
    db.close();
    const legacy = new Database(file);
    try {
      expect(legacy.prepare("SELECT value FROM kv WHERE key='probe'").get()).toEqual({ value: "before" });
      for (const table of ["batches", "jobs", "job_attempts", "kv"]) {
        const column = table === "kv" ? "key" : "id";
        for (const sql of [`INSERT INTO ${table} (${column}) VALUES ('legacy')`,
          `UPDATE ${table} SET ${column} = ${column}`, `DELETE FROM ${table}`]) {
          expect(() => legacy.exec(sql)).toThrow(/comfyui_light_writer_version/);
        }
      }
    } finally {
      legacy.close();
    }
    const reopened = openDb(file);
    try {
      reopened.prepare("UPDATE kv SET value=? WHERE key=?").run("after", "probe");
      expect(reopened.prepare("SELECT value FROM kv WHERE key='probe'").get()).toEqual({ value: "after" });
      reopened.prepare("DELETE FROM kv WHERE key=?").run("probe");
      expect(reopened.pragma("user_version", { simple: true })).toBe(5);
    } finally {
      reopened.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("打开即迁移到 v5（user_version=5），幂等", () => {
    const db = openDb(":memory:");
    expect(db.pragma("user_version", { simple: true })).toBe(5);
    db.close();
    const db2 = openDb(":memory:");
    expect(db2.pragma("user_version", { simple: true })).toBe(5);
    db2.close();
  });

  it("v3：batches 新增三指纹列（工作流版本保护 + 幂等请求指纹），旧行为 NULL", () => {
    const db = openDb(":memory:");
    const cols = (db.prepare("PRAGMA table_info(batches)").all() as Array<{ name: string }>).map((c) => c.name);
    for (const c of ["manifest_fingerprint", "graph_fingerprint", "request_fingerprint"]) {
      expect(cols).toContain(c);
    }
    // v2 旧库迁移上来的行（未写指纹）三列为 NULL —— 缺少历史快照，未执行任务必须暂停
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO batches (id, workflow, workflow_version, status, total, options_json, created_at) VALUES (?,?,?,?,?,?,?)"
    ).run("b-legacy", "demo", 1, "running", 1, "{}", now);
    const row = db.prepare("SELECT manifest_fingerprint, graph_fingerprint, request_fingerprint FROM batches WHERE id='b-legacy'").get() as {
      manifest_fingerprint: string | null;
      graph_fingerprint: string | null;
      request_fingerprint: string | null;
    };
    expect(row).toEqual({ manifest_fingerprint: null, graph_fingerprint: null, request_fingerprint: null });
    db.close();
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
