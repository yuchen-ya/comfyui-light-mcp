import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { legacyDb } from "../helpers/legacy-db.js";
import { historyEntry, makeFakeClient } from "../helpers/fake-client.js";
import { openDb, migrate } from "../../src/core/storage/db.js";
import { WorkflowRegistry } from "../../src/core/workflow/registry.js";
import { Engine } from "../../src/core/engine.js";
import { loadConfig } from "../../src/config.js";

const submittedAt = "2026-01-01T00:00:00.000Z";
const finishedAt = "2026-01-01T00:10:00.000Z";
const oldPrompt = "legacy-remote-prompt";
const timeoutError = { code: "TIMEOUT", message: "Legacy local timeout", remote_cancel: { queue_delete: "error", interrupt: "error" } };

describe("Task005R2 pending retry safety", () => {
  let dir: string;
  let registry: WorkflowRegistry;
  let db: ReturnType<typeof openDb> | undefined;
  let engine: Engine;
  let fake: ReturnType<typeof makeFakeClient>;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pending-retry-"));
    await writeFile(path.join(dir, "test.json"), JSON.stringify({ "1": { class_type: "Test", inputs: { text: "fixture" } } }));
    await writeFile(path.join(dir, "test.manifest.json"), JSON.stringify({ name: "test", description: "pending retry fixture", version: 1,
      workflowFile: "test.json", params: [{ name: "text", node: "1", input: "text", type: "string", default: "fixture" }] }));
    registry = new WorkflowRegistry(dir);
    await registry.load();
    fake = makeFakeClient();
  });

  afterEach(async () => {
    if (db) {
      await engine.stop();
      db.close();
      db = undefined;
    }
    vi.useRealTimers();
    await rm(dir, { recursive: true, force: true });
  });

  async function loadEngine(file: string): Promise<void> {
    db = openDb(file);
    engine = new Engine({ ...loadConfig({ WORKFLOWS_DIR: dir, OUTPUT_DIR: dir }), maxInFlight: 1, maxQueuedJobs: 1 }, fake.client, db);
    await engine.loadWorkflowsAsync();
    vi.useFakeTimers();
  }

  function seedLegacy(version: "4.1new" | "v4", maxAttempts: number, reason: "TIMEOUT" | "NO_HISTORY" = "TIMEOUT"): string {
    const file = path.join(dir, "legacy.db");
    const old = legacyDb(file, version);
    const wf = registry.get("test")!;
    old.prepare(`INSERT INTO batches (id, workflow, workflow_version, status, total, options_json, created_at,
      manifest_fingerprint, graph_fingerprint) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run("batch", "test", 1, "running", 1, JSON.stringify({ continue_on_error: false, max_attempts: maxAttempts }), submittedAt,
        wf.fingerprints.manifestFingerprint, wf.fingerprints.graphFingerprint);
    const error = JSON.stringify(reason === "TIMEOUT" ? timeoutError : { code: "NO_HISTORY", message: "Success observed; history unavailable" });
    old.prepare(`INSERT INTO jobs (id, batch_id, idx, params_json, status, attempt_no, prompt_id, error_json, submitted_at, finished_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run("job", "batch", 0, "{}", reason === "TIMEOUT" ? "timeout" : "failed", 1, oldPrompt, reason === "TIMEOUT" ? error : null, submittedAt, finishedAt);
    old.prepare(`INSERT INTO job_attempts (id, job_id, attempt_no, prompt_id, status, error_json, submitted_at, finished_at)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run("attempt", "job", 1, oldPrompt, reason === "TIMEOUT" ? "timeout" : "failed", reason === "NO_HISTORY" ? error : null, submittedAt, finishedAt);
    // Reproduce the old reset, including the interruption before claim/POST.
    old.exec("UPDATE jobs SET status = 'pending', finished_at = NULL WHERE status IN ('failed','timeout')");
    expect(old.prepare("SELECT status, attempt_no, prompt_id, finished_at FROM jobs").get())
      .toEqual({ status: "pending", attempt_no: 1, prompt_id: oldPrompt, finished_at: null });
    expect(old.pragma("user_version", { simple: true })).toBe(version === "v4" ? 4 : 3);
    old.close();
    return file;
  }

  const legacyCases = (["4.1new", "v4"] as const).flatMap((version) => [
    { version, outcome: "success", maxAttempts: 2 },
    { version, outcome: "interrupted", maxAttempts: 1 },
    { version, outcome: "interrupted", maxAttempts: 2 }
  ]);

  it.each(legacyCases)("$version pending timeout holds its slot until $outcome (max_attempts=$maxAttempts)", async ({ version, outcome, maxAttempts }) => {
    await loadEngine(seedLegacy(version, maxAttempts));
    expect(db!.pragma("user_version", { simple: true })).toBe(5);
    const job = engine.store.getJobById("job")!;
    expect(job).toMatchObject({ status: "submission_unknown", attempt_no: 1, prompt_id: oldPrompt, finished_at: null });
    expect(engine.store.getAttempt(job)).toMatchObject({ status: "submission_unknown", terminal_confirmed: 0,
      cancel_requested_at: finishedAt, finished_at: null });
    expect(JSON.parse(job.error_json!)).toEqual(timeoutError);
    expect(engine.store.getBatch("batch")!.graph_fingerprint).toBe(registry.get("test")!.fingerprints.graphFingerprint);
    migrate(db!); // Idempotence must not change the restored intent.
    engine.start();
    for (let i = 0; i < 4; i++) await engine.scheduler.tick();
    await vi.advanceTimersByTimeAsync(6000);
    expect(fake.state.submitCalls).toBe(0);
    expect(engine.store.windowCounts()).toEqual({ inFlight: 1, queued: 0 });
    expect(engine.store.getJobById("job")).toMatchObject({ status: "submission_unknown", prompt_id: oldPrompt, attempt_no: 1 });
    expect(engine.store.getAttempt(job)).toMatchObject({ cancel_requested_at: finishedAt, terminal_confirmed: 0 });
    expect(JSON.parse(engine.store.getJobById("job")!.error_json!).remote_cancel).toEqual(timeoutError.remote_cancel);

    fake.state.history.set(oldPrompt, historyEntry({}, outcome));
    await vi.advanceTimersByTimeAsync(3000);
    const attempts = engine.store.getAttempts("job");
    expect(attempts[0]).toMatchObject({ prompt_id: oldPrompt, status: outcome === "success" ? "succeeded" : "timeout",
      cancel_requested_at: finishedAt, terminal_confirmed: 1 });
    if (outcome === "interrupted") expect(JSON.parse(attempts[0]!.error_json!).remote_cancel).toEqual(timeoutError.remote_cancel);
    const retries = outcome === "interrupted" && maxAttempts > 1 ? 1 : 0;
    expect(fake.state.submitCalls).toBe(retries);
    expect(attempts).toHaveLength(1 + retries);
    expect(engine.store.windowCounts().inFlight).toBe(retries);
    expect(engine.store.getJobById("job")!.status).toBe(retries ? "queued" : outcome === "success" ? "succeeded" : "timeout");
    if (retries) expect(attempts[1]!.prompt_id).not.toBe(oldPrompt);
    else expect(engine.store.getJobById("job")!.prompt_id).toBe(oldPrompt);
  });

  it.each(["4.1new", "v4"] as const)("%s restores NO_HISTORY intent from the previous attempt without cancelling or resubmitting", async (version) => {
    await loadEngine(seedLegacy(version, 2, "NO_HISTORY"));
    const job = engine.store.getJobById("job")!;
    expect(engine.store.getAttempt(job)).toMatchObject({ success_observed_at: finishedAt, cancel_requested_at: null, terminal_confirmed: 0 });
    engine.start();
    await vi.advanceTimersByTimeAsync(6000);
    expect(engine.store.getJobById("job")!.status).toBe("submission_unknown");
    expect(engine.store.windowCounts().inFlight).toBe(1);
    expect(fake.state.submitCalls).toBe(0);
    expect(fake.state.interruptCalls).toEqual([]);
    expect(fake.state.deleteQueueCalls).toEqual([]);
    fake.state.history.set(oldPrompt, historyEntry({}));
    await vi.advanceTimersByTimeAsync(3000);
    expect(engine.store.getJobById("job")!.status).toBe("succeeded");
    expect(engine.store.getAttempts("job")).toHaveLength(1);
    expect(fake.state.submitCalls).toBe(0);
  });

  it("v4 migration leaves first submissions and confirmed pending retries executable after reopening", async () => {
    const file = seedLegacy("v4", 2);
    const old = new Database(file);
    old.exec("UPDATE job_attempts SET terminal_confirmed = 1");
    old.close();
    // A legitimate v4 retry has remote confirmation; opening must preserve it.
    await loadEngine(file);
    expect(engine.store.getJobById("job")!.status).toBe("pending");
    const fresh = engine.manager.createBatch(engine.registry.get("test")!, { runs: [{ params: {} }] });
    await engine.stop();
    db!.close();
    db = undefined;
    vi.useRealTimers();
    await loadEngine(file);
    expect(engine.store.getJobById("job")!.status).toBe("pending");
    expect(engine.store.getJob(fresh.batchId, 0)).toMatchObject({ status: "pending", attempt_no: 0 });
    engine.start();
    await engine.scheduler.tick();
    expect(fake.state.submitCalls).toBe(1);
    expect(engine.store.getJobById("job")).toMatchObject({ status: "queued", attempt_no: 2 });
    const retry = engine.store.getJobById("job")!;
    fake.state.history.set(retry.prompt_id!, historyEntry({}));
    await vi.advanceTimersByTimeAsync(3000);
    expect(fake.state.submitCalls).toBe(2);
    expect(engine.store.getJob(fresh.batchId, 0)).toMatchObject({ status: "queued", attempt_no: 1 });
  });

  it.each([
    { status: "timeout", confirmed: 0, maxAttempts: 2, allowed: false },
    { status: "missing", confirmed: 0, maxAttempts: 2, allowed: false },
    { status: "succeeded", confirmed: 1, maxAttempts: 2, allowed: false },
    { status: "cancelled", confirmed: 1, maxAttempts: 2, allowed: false },
    { status: "timeout", confirmed: 1, maxAttempts: 1, allowed: false },
    { status: "failed", confirmed: 1, maxAttempts: 2, allowed: true },
    { status: "timeout", confirmed: 1, maxAttempts: 2, allowed: true }
  ])("claim checks previous $status confirmation=$confirmed and max_attempts=$maxAttempts inside the submit transaction", async ({ status, confirmed, maxAttempts, allowed }) => {
    await loadEngine(":memory:");
    const batch = engine.manager.createBatch(engine.registry.get("test")!, { runs: [{ params: {} }], maxAttempts });
    const job = engine.store.getJob(batch.batchId, 0)!;
    engine.store.claimForSubmit(job.id, oldPrompt, "{}", submittedAt);
    if (status === "missing") db!.prepare("DELETE FROM job_attempts WHERE job_id = ?").run(job.id);
    else db!.prepare("UPDATE job_attempts SET status = ?, terminal_confirmed = ? WHERE job_id = ?").run(status, confirmed, job.id);
    engine.store.patchJob(job.id, { status: "pending" }); // Bypass retry candidate filtering.
    const handle = await engine.runner.submitJob(engine.registry.get("test")!, engine.store.getJobById(job.id)!);
    expect(handle === null).toBe(!allowed);
    expect(fake.state.submitCalls).toBe(allowed ? 1 : 0);
    if (allowed) expect(engine.store.getJobById(job.id)!.prompt_id).not.toBe(oldPrompt);
    else expect(engine.store.getJobById(job.id)!.prompt_id).toBe(oldPrompt);
    expect(engine.store.getJobById(job.id)!.attempt_no).toBe(allowed ? 2 : 1);
    expect(engine.store.getAttempts(job.id)).toHaveLength(status === "missing" ? 0 : allowed ? 2 : 1);
  });
});
