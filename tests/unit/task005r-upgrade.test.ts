import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { legacyDb } from "../helpers/legacy-db.js";
import { openDb, migrate } from "../../src/core/storage/db.js";
import { makeFakeClient } from "../helpers/fake-client.js";
import { Engine } from "../../src/core/engine.js";
import { loadConfig } from "../../src/config.js";
import { BatchStore } from "../../src/core/batch/store.js";

describe("Task005R actual legacy schema upgrades", () => {
  it.each(["v2", "4.1", "4.1new"] as const)("%s preserves history and pauses pending without fabricating a snapshot", async (variant) => {
    const dir = await mkdtemp(path.join(tmpdir(), "upgrade-"));
    const file = path.join(dir, "legacy.db");
    const old = legacyDb(file, variant);
    old.prepare("INSERT INTO batches (id, workflow, workflow_version, idempotency_key, status, total, options_json, created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run("legacy", "test", 1, "old-key", "running", 1, "{}", new Date().toISOString());
    old.prepare("INSERT INTO jobs (id, batch_id, idx, params_json, status) VALUES (?,?,?,?,?)").run("pending", "legacy", 0, "{}", "pending");
    old.prepare("INSERT INTO batches (id, workflow, workflow_version, status, total, options_json, created_at, finished_at) VALUES (?,?,?,?,?,?,?,?)")
      .run("history", "test", 1, "completed", 1, "{}", "2026-01-01", "2026-01-01");
    old.prepare("INSERT INTO jobs (id, batch_id, idx, params_json, status) VALUES (?,?,?,?,?)").run("finished", "history", 0, "{}", "succeeded");
    if (variant === "4.1") old.exec("UPDATE batches SET manifest_fp='raw-manifest', graph_fp='raw-graph', request_fp='raw-request'");
    old.close();
    // The workflow changed while the application was stopped; no historical copy exists.
    await writeFile(path.join(dir, "test.json"), JSON.stringify({ "1": { class_type: "Changed", inputs: { text: "changed" } } }));
    await writeFile(path.join(dir, "test.manifest.json"), JSON.stringify({ name: "test", description: "changed", version: 2,
      workflowFile: "test.json", params: [{ name: "text", node: "1", input: "text", type: "string" }] }));
    const db = openDb(file);
    const fake = makeFakeClient();
    const engine = new Engine(loadConfig({ WORKFLOWS_DIR: dir, OUTPUT_DIR: dir }), fake.client, db);
    try {
      await engine.loadWorkflowsAsync();
      engine.start();
      await engine.scheduler.tick();
      expect(db.pragma("user_version", { simple: true })).toBe(4);
      expect(engine.store.getJobById("pending")!.status).toBe("paused");
      expect(engine.store.getJobById("pending")!.error_json).toContain("LEGACY_SNAPSHOT_MISSING");
      expect(fake.state.submitCalls).toBe(0);
      expect(engine.store.getBatch("legacy")!.graph_fingerprint).toBeNull();
      expect(engine.getBatch("history").status).toBe("completed");
      expect(engine.store.getJobById("finished")!.status).toBe("succeeded");
      await expect(engine.runSingle({ workflow: "test", params: {}, idempotencyKey: "old-key" }))
        .rejects.toMatchObject({ code: "LEGACY_IDEMPOTENCY_CONFLICT" });
      if (variant === "4.1") expect(db.prepare("SELECT graph_fp FROM batches WHERE id='legacy'").get()).toEqual({ graph_fp: "raw-graph" });
      migrate(db);
      expect(engine.store.getJobById("pending")!.status).toBe("paused");
    } finally {
      await engine.stop();
      db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("DDL and user_version roll back together when a migration fails", () => {
    const db = legacyDb(":memory:", "v2");
    db.exec("ALTER TABLE batches ADD COLUMN graph_fingerprint TEXT");
    expect(() => migrate(db)).toThrow();
    expect(db.pragma("user_version", { simple: true })).toBe(2);
    expect((db.prepare("PRAGMA table_info(batches)").all() as Array<{ name: string }>).map((c) => c.name))
      .not.toContain("manifest_fingerprint");
    db.close();
  });

  it("legacy unconfirmed timeout in a running batch keeps its slot and cannot become retryable", () => {
    const db = legacyDb(":memory:", "4.1new");
    for (const [id, status] of [["active", "running"], ["historical", "failed"]]) {
      db.prepare("INSERT INTO batches (id, workflow, workflow_version, status, total, options_json, created_at) VALUES (?,?,?,?,?,?,?)")
        .run(id, "test", 1, status, 1, '{"max_attempts":2}', "2026-01-01T00:00:00Z");
      db.prepare("INSERT INTO jobs (id, batch_id, idx, params_json, status, attempt_no, prompt_id, submitted_at, finished_at) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(id, id, 0, "{}", "timeout", 1, `prompt-${id}`, "2026-01-01T00:00:00Z", "2026-01-01T00:10:00Z");
      db.prepare("INSERT INTO job_attempts (id, job_id, attempt_no, prompt_id, status, submitted_at, finished_at) VALUES (?,?,?,?,?,?,?)")
        .run(id, id, 1, `prompt-${id}`, "timeout", "2026-01-01T00:00:00Z", "2026-01-01T00:10:00Z");
    }
    migrate(db);
    const store = new BatchStore(db);
    expect(store.getJobById("active")!.status).toBe("submission_unknown");
    expect(store.getAttempt(store.getJobById("active")!)!.status).toBe("submission_unknown");
    expect(store.getAttempt(store.getJobById("active")!)!.finished_at).toBeNull();
    expect(store.getAttempt(store.getJobById("active")!)!.cancel_requested_at).toBe("2026-01-01T00:10:00Z");
    expect(store.windowCounts().inFlight).toBe(1);
    expect(store.retryEligibleJobs()).toEqual([]);
    expect(store.getJobById("historical")!.status).toBe("timeout");
    expect(store.getBatch("historical")!.status).toBe("failed");
    db.close();
  });
});
