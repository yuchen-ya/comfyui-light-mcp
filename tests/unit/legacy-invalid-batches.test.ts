import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { legacyDb } from "../helpers/legacy-db.js";
import { makeFakeClient } from "../helpers/fake-client.js";
import { openDb, migrate } from "../../src/core/storage/db.js";
import { Engine } from "../../src/core/engine.js";
import { loadConfig } from "../../src/config.js";
import { BatchStore } from "../../src/core/batch/store.js";

const createdAt = "2026-01-01T00:00:00.000Z";
const firstFinishedAt = "2026-01-01T00:01:00.000Z";
const lastFinishedAt = "2026-01-01T00:02:00.000Z";
const retainedFinishedAt = "2026-01-01T00:03:00.000Z";

function seedBatch(db: Database.Database, id: string, statuses: string[], opts: {
  status?: string; total?: number; finishedAt?: string | null; jobTimes?: Array<string | null>;
} = {}): void {
  db.prepare(`INSERT INTO batches
    (id, workflow, workflow_version, idempotency_key, status, total, options_json, created_at, finished_at)
    VALUES (?, 'test', 1, ?, ?, ?, '{"continue_on_error":true,"max_attempts":5}', ?, ?)`)
    .run(id, `key-${id}`, opts.status ?? "running", opts.total ?? statuses.length, createdAt, opts.finishedAt ?? null);
  statuses.forEach((status, idx) => {
    db.prepare(`INSERT INTO jobs (id, batch_id, idx, label, params_json, status, error_json, finished_at)
      VALUES (?, ?, ?, ?, '{}', ?, ?, ?)`)
      .run(`${id}-${idx}`, id, idx, `run-${idx}`, status,
        status === "invalid" ? '{"code":"INVALID_PARAMS","message":"required text missing"}' : null,
        opts.jobTimes?.[idx] ?? null);
  });
}

function batchStates(db: Database.Database) {
  return db.prepare("SELECT id, status, finished_at FROM batches ORDER BY id").all() as Array<{
    id: string; status: string; finished_at: string | null;
  }>;
}

function snapshot(db: Database.Database) {
  return {
    batches: db.prepare("SELECT * FROM batches ORDER BY id").all(),
    jobs: db.prepare("SELECT * FROM jobs ORDER BY id").all(),
    attempts: db.prepare("SELECT * FROM job_attempts ORDER BY id").all(),
    kv: db.prepare("SELECT * FROM kv ORDER BY key").all()
  };
}

describe("legacy running batches containing only invalid jobs", () => {
  it.each(["v2", "4.1", "4.1new", "v4", "v5"] as const)(
    "%s disk upgrade/open repairs only complete all-invalid batches and stays idempotent",
    async (variant) => {
      const dir = await mkdtemp(path.join(tmpdir(), "legacy-invalid-migration-"));
      const file = path.join(dir, "legacy.db");
      let db: Database.Database | undefined;
      try {
        db = variant === "v5" ? openDb(file) : legacyDb(file, variant);
        seedBatch(db, "repair-latest", ["invalid", "invalid"], { jobTimes: [lastFinishedAt, firstFinishedAt] });
        seedBatch(db, "repair-partial-time", ["invalid", "invalid"], { jobTimes: [null, firstFinishedAt] });
        seedBatch(db, "repair-fallback", ["invalid", "invalid"]);
        seedBatch(db, "repair-retained", ["invalid"], { finishedAt: retainedFinishedAt, jobTimes: [lastFinishedAt] });
        for (const status of ["pending", "paused", "submission_unknown", "submitting", "queued", "executing",
          "succeeded", "failed", "timeout", "cancelled", "unknown", "unrecognized"]) {
          seedBatch(db, `keep-${status}`, ["invalid", status]);
        }
        for (const status of ["completed", "partial", "failed", "cancelled"]) {
          seedBatch(db, `keep-ended-${status}`, ["invalid"], { status, finishedAt: retainedFinishedAt });
        }
        seedBatch(db, "keep-empty", []);
        seedBatch(db, "keep-missing", ["invalid"], { total: 2 });
        seedBatch(db, "keep-missing-all", [], { total: 2 });
        seedBatch(db, "keep-extra", ["invalid", "invalid"], { total: 1 });
        seedBatch(db, "keep-zero-total", ["invalid"], { total: 0 });
        db.prepare(`INSERT INTO job_attempts (id, job_id, attempt_no, status, error_json, finished_at)
          VALUES ('historical-attempt', 'repair-latest-0', 1, 'invalid', '{"code":"INVALID_PARAMS"}', ?)`)
          .run(firstFinishedAt);
        db.prepare("INSERT INTO kv (key, value) VALUES ('preserved', 'audit-value')").run();
        const fingerprintSuffix = variant === "4.1" ? "fp" : "fingerprint";
        if (variant !== "v2") {
          db.exec(`UPDATE batches SET manifest_${fingerprintSuffix}='manifest-audit',
            graph_${fingerprintSuffix}='graph-audit', request_${fingerprintSuffix}='request-audit'`);
        }
        const before = batchStates(db);
        const batchData = db.prepare(`SELECT id, workflow, workflow_version, idempotency_key, total, options_json, created_at
          FROM batches ORDER BY id`).all();
        const invalidJobs = db.prepare("SELECT * FROM jobs WHERE status='invalid' ORDER BY id").all();
        const attempts = db.prepare("SELECT id, job_id, attempt_no, status, error_json, finished_at FROM job_attempts").all();
        db.close();
        db = openDb(file);
        const repairedTimes = new Map([
          ["repair-latest", lastFinishedAt], ["repair-partial-time", firstFinishedAt],
          ["repair-fallback", createdAt], ["repair-retained", retainedFinishedAt]
        ]);
        expect(batchStates(db)).toEqual(before.map((batch) => repairedTimes.has(batch.id)
          ? { ...batch, status: "failed", finished_at: repairedTimes.get(batch.id) }
          : batch));
        expect(db.pragma("user_version", { simple: true })).toBe(5);
        expect(db.prepare(`SELECT id, workflow, workflow_version, idempotency_key, total, options_json, created_at
          FROM batches ORDER BY id`).all()).toEqual(batchData);
        expect(db.prepare("SELECT * FROM jobs WHERE status='invalid' ORDER BY id").all()).toEqual(invalidJobs);
        expect(db.prepare("SELECT id, job_id, attempt_no, status, error_json, finished_at FROM job_attempts").all()).toEqual(attempts);
        if (variant !== "v2") {
          expect(db.prepare(`SELECT DISTINCT manifest_${fingerprintSuffix} AS manifest,
            graph_${fingerprintSuffix} AS graph, request_${fingerprintSuffix} AS request FROM batches`).all())
            .toEqual([{ manifest: "manifest-audit", graph: "graph-audit", request: "request-audit" }]);
        }
        const repaired = snapshot(db);
        migrate(db);
        migrate(db);
        expect(snapshot(db)).toEqual(repaired);
        db.close();
        db = openDb(file);
        expect(snapshot(db)).toEqual(repaired);
        expect(db.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
        expect(db.pragma("foreign_key_check")).toEqual([]);
      } finally {
        if (db?.open) db.close();
        await rm(dir, { recursive: true, force: true });
      }
    }
  );

  it.each(["v2", "v4"] as const)("a rejected %s repair rolls back with schema migration and writer guards", (variant) => {
    const db = legacyDb(":memory:", variant);
    try {
      seedBatch(db, "repair-rejected", ["invalid"]);
      db.exec(`CREATE TRIGGER reject_repair BEFORE UPDATE ON batches
        WHEN NEW.id='repair-rejected' BEGIN SELECT RAISE(ABORT, 'repair rejected'); END`);
      const before = snapshot(db);
      expect(() => migrate(db)).toThrow("repair rejected");
      expect(db.pragma("user_version", { simple: true })).toBe(variant === "v2" ? 2 : 4);
      expect(snapshot(db)).toEqual(before);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'guard_v5_%'").all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("recovery repair requires the existing v5 writer capability", () => {
    const db = openDb(":memory:");
    try {
      seedBatch(db, "repair-guarded", ["invalid"]);
      const before = snapshot(db);
      db.function("comfyui_light_writer_version", () => 4);
      expect(() => new BatchStore(db).repairLegacyInvalidBatches()).toThrow("v5-compatible application");
      expect(snapshot(db)).toEqual(before);
    } finally {
      db.close();
    }
  });

  it.each([
    { entry: "recover", continueOnError: true }, { entry: "recover", continueOnError: false },
    { entry: "scheduler", continueOnError: true }, { entry: "scheduler", continueOnError: false }
  ] as const)("Engine $entry repairs state inserted after openDb (continueOnError=$continueOnError)", async ({ entry, continueOnError }) => {
    const dir = await mkdtemp(path.join(tmpdir(), "legacy-invalid-recovery-"));
    const db = openDb(path.join(dir, "recovery.db"));
    const fake = makeFakeClient();
    const engine = new Engine(loadConfig({ COMFYUI_URL: "http://127.0.0.1:1", WORKFLOWS_DIR: dir,
      OUTPUT_DIR: path.join(dir, "outputs"), AUTO_SAVE_OUTPUTS: "false" }), fake.client, db);
    try {
      await writeFile(path.join(dir, "test.json"), JSON.stringify({ "1": { class_type: "TextEncode", inputs: { text: "" } } }));
      await writeFile(path.join(dir, "test.manifest.json"), JSON.stringify({ name: "test", description: "test", version: 1,
        workflowFile: "test.json", params: [{ name: "text", node: "1", input: "text", type: "string", required: true }] }));
      await engine.loadWorkflowsAsync();
      const req = { workflow: "test", runs: [{ label: "missing", params: {} }, { label: "wrong type", params: { text: 1 } }],
        idempotencyKey: "historical-invalid", continueOnError, maxAttempts: 5 };
      const created = engine.manager.createBatch(engine.registry.get("test")!, req);
      // Reproduce the historical state AFTER openDb, so migration cannot hide a recovery regression.
      engine.store.updateBatchStatus(created.batchId, "running", null);
      engine.store.patchJob(engine.store.getJob(created.batchId, 0)!.id, { finished_at: lastFinishedAt });
      engine.store.patchJob(engine.store.getJob(created.batchId, 1)!.id, { finished_at: firstFinishedAt });
      expect(engine.getBatch(created.batchId).status).toBe("running");
      const before = snapshot(db);
      if (entry === "recover") await engine.recover();
      else await engine.scheduler.tick();
      expect(engine.getBatch(created.batchId)).toMatchObject({ status: "failed", stats: { total: 2, invalid: 2 } });
      expect(engine.store.getBatch(created.batchId)!.finished_at).toBe(lastFinishedAt);
      const index = await engine.getResultIndex(created.batchId, { download: false });
      expect(index).toMatchObject({ status: "failed", complete: true, total: 2, invalid: 2, unresolved: 0 });
      const records = (await readFile(index.index_path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(records.map((record) => record.status)).toEqual(["invalid", "invalid"]);
      expect(records.map((record) => record.error.code)).toEqual(["INVALID_PARAMS", "INVALID_PARAMS"]);
      expect(await engine.runBatch(req)).toMatchObject({ batch_id: created.batchId, status: "failed", reused: true, total: 2, invalid: 2 });
      expect(await engine.getResult(created.batchId, 0, { download: false })).toMatchObject({ status: "invalid", error: { code: "INVALID_PARAMS" } });
      const after = snapshot(db);
      expect(after.jobs).toEqual(before.jobs);
      expect(after.attempts).toEqual(before.attempts);
      expect(after.attempts).toEqual([]);
      expect(after.batches).toEqual((before.batches as Array<Record<string, unknown>>)
        .map((batch) => ({ ...batch, status: "failed", finished_at: lastFinishedAt })));
      await engine.recover();
      await engine.recover();
      await engine.scheduler.tick();
      expect(snapshot(db)).toEqual(after);
      expect(await engine.getResultIndex(created.batchId, { download: false })).toEqual(index);
      expect(fake.state.submitCalls).toBe(0);
      expect(fake.state.downloadCalls).toBe(0);
      expect(fake.state.interruptCalls).toEqual([]);
      expect(fake.state.deleteQueueCalls).toEqual([]);
    } finally {
      await engine.stop();
      db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
