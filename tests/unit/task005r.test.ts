import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Engine } from "../../src/core/engine.js";
import { loadConfig } from "../../src/config.js";
import { openDb } from "../../src/core/storage/db.js";
import { historyVerdict } from "../../src/core/batch/tracker.js";
import { makeFakeClient, historyEntry } from "../helpers/fake-client.js";

describe("Task005R safe recovery and retry", () => {
  let dir: string;
  let db: ReturnType<typeof openDb>;
  let engine: Engine;
  let fake: ReturnType<typeof makeFakeClient>;
  let online: boolean;
  let reconnects: number;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "task005r-"));
    await writeFile(path.join(dir, "test.json"), JSON.stringify({ "1": { class_type: "Test", inputs: { seed: 1 } } }));
    await writeFile(path.join(dir, "test.manifest.json"), JSON.stringify({
      name: "test", description: "regression fixture", version: 1, workflowFile: "test.json",
      params: [{ name: "seed", node: "1", input: "seed", type: "integer", special: "seed", default: -1, min: 10, max: 20 }]
    }));
    db = openDb(":memory:");
    fake = makeFakeClient();
    online = true;
    reconnects = 0;
    fake.client.ws.getStats = () => ({ state: online ? "open" : "reconnecting", reconnects }) as never;
    engine = new Engine({ ...loadConfig({ WORKFLOWS_DIR: dir, OUTPUT_DIR: dir }), jobTimeoutMs: 1000 }, fake.client, db);
    await engine.loadWorkflowsAsync();
    vi.useFakeTimers();
  });

  afterEach(async () => {
    await engine.stop();
    db.close();
    vi.useRealTimers();
    await rm(dir, { recursive: true, force: true });
  });

  function create(count = 1, maxAttempts = 2, continueOnError = true) {
    return engine.manager.createBatch(engine.registry.get("test")!, {
      runs: Array.from({ length: count }, () => ({ params: {} })), maxAttempts, continueOnError
    }).batchId;
  }

  function interrupted(promptId: string) {
    return { ...historyEntry({}, "error"), status: { status_str: "error", completed: false,
      messages: [["execution_start", { prompt_id: promptId }], ["execution_interrupted", { prompt_id: promptId, node_id: "1" }]] } };
  }

  it("offline startup gates pending; delayed connection automatically reconciles all in-flight states without POST", async () => {
    const ids = Array.from({ length: 4 }, () => create());
    for (const [i, status] of ["queued", "executing", "submission_unknown"].entries()) {
      const j = engine.store.getJob(ids[i]!, 0)!;
      engine.store.claimForSubmit(j.id, `remote-${i}`, "{}", new Date().toISOString());
      engine.store.patchJob(j.id, { status: status as "queued" });
    }
    fake.state.queuePromptIds.pending = ["remote-0"];
    fake.state.history.set("remote-1", historyEntry({}));
    online = false;
    engine.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fake.state.submitCalls).toBe(0);
    online = true;
    await vi.advanceTimersByTimeAsync(500);
    expect(engine.store.getJob(ids[1]!, 0)!.status).toBe("succeeded");
    expect(engine.store.getAttempts(engine.store.getJob(ids[1]!, 0)!.id)[0]!.status).toBe("succeeded");
    expect(engine.tracker.isTracked(engine.store.getJob(ids[0]!, 0)!.id)).toBe(true);
    expect(engine.store.getJob(ids[2]!, 0)!.status).toBe("submission_unknown");
    expect(fake.state.submitCalls).toBe(0);
    fake.state.history.set("remote-2", historyEntry({}));
    online = false;
    reconnects++;
    await vi.advanceTimersByTimeAsync(500);
    online = true;
    await vi.advanceTimersByTimeAsync(500);
    expect(engine.store.getJob(ids[2]!, 0)!.status).toBe("succeeded");
    expect(fake.state.submitCalls).toBe(0);
  });

  it("rechecks connection before every submission in a 2/2 window", async () => {
    await engine.stop();
    engine = new Engine({ ...engine.config, maxInFlight: 2, maxQueuedJobs: 2 }, fake.client, db);
    await engine.loadWorkflowsAsync();
    const id = create(2);
    fake.state.submitImpl = async (_graph, opts) => { online = false; return { ok: true, promptId: opts!.promptId!, number: 1, nodeErrors: {} }; };
    await engine.scheduler.tick();
    expect(fake.state.submitCalls).toBe(1);
    expect(engine.store.getJob(id, 1)!.status).toBe("pending");
  });

  it("a disconnect/reconnect during submission requires reconciliation before the next POST", async () => {
    await engine.stop();
    engine = new Engine({ ...engine.config, maxInFlight: 2, maxQueuedJobs: 2 }, fake.client, db);
    await engine.loadWorkflowsAsync();
    const id = create(2);
    fake.state.submitImpl = async (_graph, opts) => {
      reconnects++;
      fake.state.history.set(opts!.promptId!, historyEntry({}));
      return { ok: true, promptId: opts!.promptId!, number: 1, nodeErrors: {} };
    };
    await engine.scheduler.tick();
    expect(fake.state.submitCalls).toBe(1);
    expect(engine.store.getJob(id, 1)!.status).toBe("pending");
    await engine.scheduler.tick();
    expect(engine.store.getJob(id, 0)!.status).toBe("succeeded");
    expect(fake.state.submitCalls).toBe(2);
  });

  it("real 0.41 interruption history cancels without retry; partial outputs alone prove nothing", async () => {
    await engine.stop();
    engine = new Engine({ ...engine.config, jobTimeoutMs: 10_000 }, fake.client, db);
    await engine.loadWorkflowsAsync();
    expect(historyVerdict(interrupted("p"))).toBe("interrupted");
    expect(historyVerdict({ outputs: { "1": { images: [{ filename: "partial.png" }] } } })).toBeNull();
    const id = create();
    await engine.scheduler.tick();
    const j = engine.store.getJob(id, 0)!;
    fake.state.history.set(j.prompt_id!, interrupted(j.prompt_id!));
    await vi.advanceTimersByTimeAsync(3000);
    await engine.scheduler.tick();
    expect(engine.store.getJob(id, 0)!.status).toBe("cancelled");
    expect(fake.state.submitCalls).toBe(1);
  });

  it.each(["failed RPC", "lost response", "HTTP 200"])("timeout with %s remains in flight until remote terminal evidence", async (mode) => {
    const id = create();
    await engine.scheduler.tick();
    const j = engine.store.getJob(id, 0)!;
    if (mode !== "HTTP 200") {
      fake.state.deleteQueueImpl = async () => { throw new Error(mode); };
      fake.state.interruptImpl = async () => { throw new Error(mode); };
    }
    await vi.advanceTimersByTimeAsync(10_000);
    for (let i = 0; i < 4; i++) await engine.scheduler.tick();
    expect(fake.state.submitCalls).toBe(1);
    expect(engine.store.windowCounts().inFlight).toBe(1);
    expect(engine.store.getJob(id, 0)!.status).toBe("submission_unknown");
    fake.state.history.set(j.prompt_id!, historyEntry({}));
    await vi.advanceTimersByTimeAsync(3000);
    expect(engine.store.getJob(id, 0)!.status).toBe("succeeded");
    expect(engine.store.getAttempts(j.id)[0]!.status).toBe("succeeded");
    expect(engine.store.getBatch(id)!.status).toBe("completed");
    expect(fake.state.submitCalls).toBe(1);
  });

  it("success with temporarily absent or failed history queries retries collection, never generation", async () => {
    const id = create();
    await engine.scheduler.tick();
    const j = engine.store.getJob(id, 0)!;
    vi.spyOn(fake.client.http, "getHistory").mockRejectedValueOnce(new Error("history temporarily unavailable"));
    fake.state.publishSuccess(j.prompt_id!);
    await vi.advanceTimersByTimeAsync(5000);
    await engine.scheduler.tick();
    expect(fake.state.submitCalls).toBe(1);
    expect(fake.state.interruptCalls).toHaveLength(0);
    fake.state.history.set(j.prompt_id!, historyEntry({}));
    await vi.advanceTimersByTimeAsync(3000);
    expect(engine.store.getJob(id, 0)!.status).toBe("succeeded");
  });

  it("persisted timeout intent and original deadline survive tracker recreation", async () => {
    const id = create();
    await engine.scheduler.tick();
    const j = engine.store.getJob(id, 0)!;
    fake.state.interruptImpl = async () => { throw new Error("response lost"); };
    await vi.advanceTimersByTimeAsync(1000);
    await engine.stop();
    engine = new Engine(engine.config, fake.client, db);
    await engine.loadWorkflowsAsync();
    fake.state.history.set(j.prompt_id!, interrupted(j.prompt_id!));
    engine.start();
    await vi.advanceTimersByTimeAsync(500);
    expect(engine.store.getAttempts(j.id)[0]!.status).toBe("timeout");
    // Confirmed interruption now permits attempt 2; the old attempt keeps its timeout reason.
    expect(fake.state.submitCalls).toBe(2);
  });

  it("query failures preserve uncertainty and distinguish failures from successful misses", async () => {
    const id = create();
    const job = engine.store.getJob(id, 0)!;
    engine.store.claimForSubmit(job.id, "already-accepted", "{}", new Date().toISOString());
    engine.store.patchJob(job.id, { status: "queued" });
    const history = vi.spyOn(fake.client.http, "getHistory").mockRejectedValue(new Error("history unavailable"));
    await engine.scheduler.tick();
    expect(engine.store.getJob(id, 0)!.status).toBe("queued");
    expect(JSON.parse(engine.store.getJob(id, 0)!.error_json!).code).toBe("RECONCILIATION_FAILED");
    for (let i = 0; i < 10; i++) await engine.scheduler.tick();
    expect(history).toHaveBeenCalledTimes(1);
    history.mockResolvedValue(null);
    vi.spyOn(fake.client.http, "getQueue").mockRejectedValue(new Error("queue unavailable"));
    await vi.advanceTimersByTimeAsync(3000);
    expect(engine.store.getJob(id, 0)!.error_json).toContain("queue query failed");
    expect(engine.store.getJob(id, 0)!.error_json).not.toContain("found no");
    expect(fake.state.submitCalls).toBe(0);
  });

  it("unknown later found executing then completed converges automatically without another POST", async () => {
    const id = create();
    fake.state.submitImpl = async () => { throw new Error("accepted but response lost"); };
    await engine.scheduler.tick();
    const job = engine.store.getJob(id, 0)!;
    fake.state.queuePromptIds.running = [job.prompt_id!];
    engine.start();
    await vi.advanceTimersByTimeAsync(3000);
    // The original 1s deadline is retained, so cancellation uncertainty still holds the slot.
    expect(engine.tracker.isTracked(job.id)).toBe(true);
    expect(engine.store.getJob(id, 0)!.status).toBe("executing");
    await vi.advanceTimersByTimeAsync(100);
    expect(engine.store.getAttempt(job)!.cancel_requested_at).not.toBeNull();
    fake.state.history.set(job.prompt_id!, historyEntry({}));
    await vi.advanceTimersByTimeAsync(3000);
    expect(engine.store.getJob(id, 0)!.status).toBe("succeeded");
    expect(fake.state.submitCalls).toBe(1);
  });

  it("2/2 window holds later work until the retry's remote outcome is final", async () => {
    await engine.stop();
    engine = new Engine({ ...engine.config, maxInFlight: 2, maxQueuedJobs: 2 }, fake.client, db);
    await engine.loadWorkflowsAsync();
    const id = create(3, 2, false);
    await engine.scheduler.tick();
    const first = engine.store.getJob(id, 0)!;
    const second = engine.store.getJob(id, 1)!;
    fake.bus.publish({ type: "execution_error", data: { prompt_id: first.prompt_id, exception_message: "injected failure" } });
    await engine.scheduler.tick();
    const retry = engine.store.getJob(id, 0)!;
    expect(retry.attempt_no).toBe(2);
    fake.state.history.set(second.prompt_id!, historyEntry({}));
    await engine.tracker.reconcile(second.id);
    await engine.scheduler.tick();
    expect(engine.store.getJob(id, 2)!.status).toBe("pending");
    expect(fake.state.submitCalls).toBe(3);
    fake.state.history.set(retry.prompt_id!, historyEntry({}));
    await engine.tracker.reconcile(retry.id);
    // Late messages from attempt 1 cannot cancel or overwrite attempt 2.
    fake.bus.publish({ type: "execution_interrupted", data: { prompt_id: first.prompt_id } });
    expect(engine.store.getJob(id, 0)!.status).toBe("succeeded");
    await engine.scheduler.tick();
    expect(engine.store.getJob(id, 2)!.status).toBe("queued");
    expect(fake.state.submitCalls).toBe(4);
  });

  it("explicit and default random seeds share bounds; resolved values satisfy those bounds", async () => {
    const handle = await engine.runSingle({ workflow: "test", params: { seed: -1 } });
    const result = await engine.getResult(handle.batch_id, 0, { download: false });
    expect(result.params_resolved!.seed).toBeGreaterThanOrEqual(10);
    expect(result.params_resolved!.seed).toBeLessThanOrEqual(20);
    await expect(engine.runSingle({ workflow: "test", params: { seed: -2 } })).rejects.toThrow();
    await expect(engine.runSingle({ workflow: "test", params: { seed: 21 } })).rejects.toThrow();
  });

  it("concurrent recovery/late history shares one download; graceful stop drains it before reopening", async () => {
    const id = create();
    await engine.scheduler.tick();
    const job = engine.store.getJob(id, 0)!;
    fake.state.history.set(job.prompt_id!, historyEntry({ "1": { images: [{ filename: "one.png", subfolder: "", type: "output" }] } }));
    let finishDownload!: (response: Response) => void;
    let downloadStarted!: () => void;
    const started = new Promise<void>((resolve) => { downloadStarted = resolve; });
    const download = vi.spyOn(fake.client.http, "downloadOutput").mockImplementation(async () => {
      downloadStarted();
      return new Promise<Response>((resolve) => { finishDownload = resolve; });
    });
    const collecting = engine.tracker.reconcile(job.id);
    await started;
    const recovering = engine.recover();
    fake.state.publishSuccess(job.prompt_id!);
    const stopping = engine.stop();
    finishDownload(new Response(new Uint8Array([1, 2, 3])));
    await Promise.all([collecting, recovering, stopping]);
    expect(download).toHaveBeenCalledTimes(1);
    expect(engine.store.getJob(id, 0)!.status).toBe("succeeded");
    engine = new Engine(engine.config, fake.client, db);
    await engine.loadWorkflowsAsync();
    await engine.scheduler.tick();
    expect(download).toHaveBeenCalledTimes(1);
    expect(engine.store.getAttempts(job.id)[0]!.status).toBe("succeeded");
  });

  it("download failure retains references, and get_result retries only download", async () => {
    const id = create();
    await engine.scheduler.tick();
    const job = engine.store.getJob(id, 0)!;
    fake.state.history.set(job.prompt_id!, historyEntry({ "1": { images: [{ filename: "retry.png", subfolder: "", type: "output" }] } }));
    const download = vi.spyOn(fake.client.http, "downloadOutput").mockRejectedValueOnce(new Error("download disconnected"));
    await engine.tracker.reconcile(job.id);
    expect(engine.store.getJob(id, 0)!.status).toBe("succeeded");
    expect(JSON.parse(engine.store.getJob(id, 0)!.outputs_json!)[0].local_path).toBe("");
    await engine.scheduler.tick();
    const result = await engine.getResult(id, 0);
    expect(result.outputs[0]!.local_path).not.toBe("");
    expect(download).toHaveBeenCalledTimes(2);
    expect(fake.state.submitCalls).toBe(1);
  });
});
