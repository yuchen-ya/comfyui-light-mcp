import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb } from "../../src/core/storage/db.js";
import type Database from "better-sqlite3";
import { BatchStore, type JobRow } from "../../src/core/batch/store.js";
import { JobRunner } from "../../src/core/batch/runner.js";
import { JobTracker } from "../../src/core/batch/tracker.js";
import { BatchManager } from "../../src/core/batch/manager.js";
import { Scheduler } from "../../src/core/batch/scheduler.js";
import { recoverInFlight } from "../../src/core/batch/recovery.js";
import { AssetManager } from "../../src/core/assets/asset-manager.js";
import { parseManifest } from "../../src/core/workflow/manifest.js";
import type { RegisteredWorkflow, WorkflowRegistry } from "../../src/core/workflow/registry.js";
import { makeFakeClient, historyEntry, type FakeHttpState } from "../helpers/fake-client.js";
import type { ComfyEventBus } from "../../src/core/client/event-bus.js";
import type { ComfyClient } from "../../src/core/client/index.js";

/**
 * Task 004 §四 Scheduler：双窗口、串行、按 index 顺序、失败隔离、continue_on_error、
 * 重试（新 prompt_id + attempt 历史）、tick 防重、submission_unknown 占额、重启恢复。
 */

const manifest = parseManifest(
  "t.manifest.json",
  JSON.stringify({
    name: "t",
    description: "d",
    version: 1,
    workflowFile: "t.json",
    params: [
      { name: "prompt", node: "4", input: "text", type: "string", required: true },
      { name: "seed", node: "7", input: "seed", type: "integer", default: -1, special: "seed" }
    ]
  })
);

const wf: RegisteredWorkflow = {
  manifest,
  graph: {
    "4": { class_type: "TextEncode", inputs: { text: "tpl" } },
    "7": { class_type: "KSampler", inputs: { seed: 42 } },
    "9": { class_type: "SaveImage", inputs: { images: ["8", 0] } }
  },
  sourceFile: "t.manifest.json",
  fingerprint: { manifest: "fp-manifest-s", graph: "fp-graph-s" }
};

const registryLike = { get: (name: string) => (name === "t" ? wf : undefined) } as unknown as WorkflowRegistry;

interface Ctx {
  db: Database.Database;
  store: BatchStore;
  fake: FakeHttpState;
  bus: ComfyEventBus;
  client: ComfyClient;
  tracker: JobTracker;
  runner: JobRunner;
  manager: BatchManager;
  scheduler: Scheduler;
}

let outDir: string;

beforeEach(async () => {
  outDir = await mkdtemp(path.join(tmpdir(), "sched-out-"));
});

afterEach(async () => {
  await rm(outDir, { recursive: true, force: true });
});

function makeCtx(opts?: { maxInFlight?: number; maxQueuedJobs?: number }): Ctx {
  const db = openDb(":memory:");
  const store = new BatchStore(db);
  const fc = makeFakeClient();
  const assets = new AssetManager(fc.client, outDir);
  const tracker = new JobTracker({ client: fc.client, store, assets, autoSave: true, defaultTimeoutMs: 60_000 });
  const runner = new JobRunner({ client: fc.client, store, tracker });
  const manager = new BatchManager(store);
  const scheduler = new Scheduler({
    store,
    registry: registryLike,
    runner,
    maxInFlight: opts?.maxInFlight ?? 1,
    maxQueuedJobs: opts?.maxQueuedJobs ?? 1
  });
  return { db, store, fake: fc.state, bus: fc.bus, client: fc.client, tracker, runner, manager, scheduler };
}

const run = (text: string, seed = 1) => ({ label: text, params: { prompt: text, seed } });

async function succeed(store: BatchStore, fake: FakeHttpState, job: JobRow): Promise<void> {
  fake.history.set(
    job.prompt_id!,
    historyEntry({ "9": { images: [{ filename: `img-${job.idx}.png`, subfolder: "", type: "output" }] } })
  );
  fake.publishSuccess(job.prompt_id!);
  await eventually(() => store.getJobById(job.id)!.status === "succeeded");
}

async function eventually(pred: () => boolean, ms = 4000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error("eventually 超时");
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** 反复 tick + 完成 in-flight，直到 batch 收敛（无 pending、无重试候选、无在途） */
async function drain(ctx: Ctx, batchId: string, maxRounds = 300): Promise<void> {
  for (let i = 0; i < maxRounds; i++) {
    await ctx.scheduler.tick();
    const active = ctx.store.inFlightJobs().filter((j) => j.status === "queued" || j.status === "executing");
    for (const j of active) await succeed(ctx.store, ctx.fake, j);
    const pending = ctx.store.countJobs(batchId, "pending");
    const retry = ctx.store.retryEligibleJobs().filter((j) => j.batch_id === batchId).length;
    const inFlight = ctx.store
      .inFlightJobs()
      .filter((j) => j.batch_id === batchId && j.status !== "submission_unknown").length;
    if (pending === 0 && retry === 0 && inFlight === 0) return;
  }
  throw new Error("drain 超时：batch 未收敛");
}

describe("双窗口与顺序", () => {
  it("串行（1/1）实际断言：逐个完成，提交顺序 = index 顺序", async () => {
    const ctx = makeCtx(); // 1/1
    const res = ctx.manager.createBatch(wf, { runs: ["a", "b", "c", "d", "e"].map((t) => run(t)) });
    const order: string[] = [];
    for (let i = 0; i < 5; i++) {
      await ctx.scheduler.tick();
      expect(ctx.fake.submitCalls).toBe(i + 1);
      const job = ctx.store.getJob(res.batchId, i)!;
      expect(job.status).toBe("queued"); // index 顺序
      order.push(String((ctx.fake.submitGraphs[i]!["4"]!.inputs as Record<string, unknown>)["text"]));
      await succeed(ctx.store, ctx.fake, job);
    }
    expect(order).toEqual(["a", "b", "c", "d", "e"]);
    const view = ctx.manager.getBatchView(res.batchId);
    expect(view.status).toBe("completed");
    expect(view.stats).toMatchObject({ total: 5, succeeded: 5 });
    ctx.tracker.disposeAll();
    ctx.db.close();
  });

  it("MAX_QUEUED_JOBS=1 且 MAX_IN_FLIGHT=4：排队窗口先满即停", async () => {
    const ctx = makeCtx({ maxInFlight: 4, maxQueuedJobs: 1 });
    const res = ctx.manager.createBatch(wf, { runs: [run("a"), run("b"), run("c")] });
    await ctx.scheduler.tick();
    expect(ctx.fake.submitCalls).toBe(1); // queued=1 达到 MAX_QUEUED_JOBS
    expect(ctx.store.getJob(res.batchId, 1)!.status).toBe("pending");
    await ctx.scheduler.tick(); // 窗口仍满（无人完成）
    expect(ctx.fake.submitCalls).toBe(1);
    ctx.tracker.disposeAll();
    ctx.db.close();
  });

  it("MAX_IN_FLIGHT=2：在途总数（queued+executing）不超上限", async () => {
    const ctx = makeCtx({ maxInFlight: 2, maxQueuedJobs: 2 });
    const res = ctx.manager.createBatch(wf, { runs: [run("a"), run("b"), run("c"), run("d")] });
    await ctx.scheduler.tick();
    expect(ctx.fake.submitCalls).toBe(2);
    expect(ctx.store.windowCounts()).toEqual({ inFlight: 2, queued: 2 });
    expect(ctx.store.getJob(res.batchId, 2)!.status).toBe("pending");
    // 完成 1 个后可再提交 1 个
    await succeed(ctx.store, ctx.fake, ctx.store.getJob(res.batchId, 0)!);
    await ctx.scheduler.tick();
    expect(ctx.fake.submitCalls).toBe(3);
    ctx.tracker.disposeAll();
    ctx.db.close();
  });

  it("submission_unknown 持续占用在途额度（后续 job 不再提交）", async () => {
    const ctx = makeCtx(); // 1/1
    ctx.fake.submitImpl = async () => {
      throw new Error("fetch failed");
    };
    const res = ctx.manager.createBatch(wf, { runs: [run("a"), run("b")] });
    await ctx.scheduler.tick();
    expect(ctx.store.getJob(res.batchId, 0)!.status).toBe("submission_unknown");
    await ctx.scheduler.tick();
    await ctx.scheduler.tick();
    expect(ctx.fake.submitCalls).toBe(1); // 额度被 unknown 占据
    expect(ctx.store.getJob(res.batchId, 1)!.status).toBe("pending");
    ctx.tracker.disposeAll();
    ctx.db.close();
  });

  it("跨 batch FIFO：先创建的 batch 优先消耗窗口", async () => {
    const ctx = makeCtx(); // 1/1
    const b1 = ctx.manager.createBatch(wf, { runs: [run("b1-0"), run("b1-1")] });
    await ctx.scheduler.tick(); // b1-0 提交
    const b2 = ctx.manager.createBatch(wf, { runs: [run("b2-0")] });
    await succeed(ctx.store, ctx.fake, ctx.store.getJob(b1.batchId, 0)!);
    await ctx.scheduler.tick();
    // b1 创建更早 → b1-1 先于 b2-0
    expect(ctx.store.getJob(b1.batchId, 1)!.status).toBe("queued");
    expect(ctx.store.getJob(b2.batchId, 0)!.status).toBe("pending");
    ctx.tracker.disposeAll();
    ctx.db.close();
  });
});

describe("失败隔离与重试", () => {
  it("单 job 失败不影响其余（默认 continue_on_error=true）", async () => {
    const ctx = makeCtx();
    ctx.fake.submitImpl = async (graph) => {
      const text = String((graph["4"]!.inputs as Record<string, unknown>)["text"]);
      if (text === "poison") {
        return { ok: false, httpStatus: 400, errorBody: { type: "prompt_outputs_failed_validation" }, nodeErrors: null };
      }
      return { ok: true, promptId: "x", number: 1, nodeErrors: {} };
    };
    const res = ctx.manager.createBatch(wf, { runs: [run("a"), run("poison"), run("c"), run("d")] });
    await drain(ctx, res.batchId);
    const view = ctx.manager.getBatchView(res.batchId);
    expect(view.stats).toEqual({ total: 4, succeeded: 3, failed: 1, running: 0, queued: 0, pending: 0, invalid: 0, unknown: 0 });
    expect(view.status).toBe("partial");
    const poison = view.jobs.find((j) => j.index === 1)!;
    expect(poison.status).toBe("failed");
    expect(poison.error!.code).toBe("COMFY_REJECTED");
    ctx.tracker.disposeAll();
    ctx.db.close();
  });

  it("continue_on_error=false：首个失败级联放弃剩余 pending", async () => {
    const ctx = makeCtx();
    ctx.fake.submitImpl = async (graph) => {
      const text = String((graph["4"]!.inputs as Record<string, unknown>)["text"]);
      if (text === "poison") {
        return { ok: false, httpStatus: 400, errorBody: { type: "x" }, nodeErrors: null };
      }
      return { ok: true, promptId: "x", number: 1, nodeErrors: {} };
    };
    const res = ctx.manager.createBatch(wf, { runs: [run("poison"), run("b"), run("c")], continueOnError: false });
    await ctx.scheduler.tick(); // poison → failed
    await ctx.scheduler.tick(); // 级联放弃 b、c
    const view = ctx.manager.getBatchView(res.batchId);
    expect(view.jobs.map((j) => [j.index, j.status])).toEqual([[0, "failed"], [1, "cancelled"], [2, "cancelled"]]);
    expect(view.jobs[1]!.error!.code).toBe("BATCH_ABORTED");
    expect(view.status).toBe("failed");
    expect(ctx.fake.submitCalls).toBe(1); // 剩余未提交
    ctx.tracker.disposeAll();
    ctx.db.close();
  });

  it("重试：max_attempts=2 → 新 prompt_id + 两行独立 attempt 历史", async () => {
    const ctx = makeCtx();
    let seenRetryMe = 0;
    ctx.fake.submitImpl = async (graph, opts) => {
      const text = String((graph["4"]!.inputs as Record<string, unknown>)["text"]);
      if (text === "retry-me" && seenRetryMe++ === 0) {
        return { ok: false, httpStatus: 400, errorBody: { type: "x" }, nodeErrors: null }; // 首次被拒
      }
      return { ok: true, promptId: opts?.promptId ?? "x", number: 1, nodeErrors: {} };
    };
    const res = ctx.manager.createBatch(wf, { runs: [run("retry-me", 77)], maxAttempts: 2 });
    await ctx.scheduler.tick();
    const job0 = ctx.store.getJob(res.batchId, 0)!;
    expect(job0.status).toBe("failed");
    expect(job0.attempt_no).toBe(1);
    const firstPromptId = job0.prompt_id!;
    expect(ctx.store.getBatch(res.batchId)!.status).toBe("running"); // 重试未用尽不收敛

    await ctx.scheduler.tick(); // 重置 pending + 重新提交（同一拍内）
    const job1 = ctx.store.getJob(res.batchId, 0)!;
    expect(job1.status).toBe("queued");
    expect(job1.attempt_no).toBe(2);
    expect(job1.prompt_id).not.toBe(firstPromptId); // 全新 prompt_id
    const attempts = ctx.store.getAttempts(job1.id);
    expect(attempts).toHaveLength(2); // 独立 attempt 记录
    expect(attempts.map((a) => a.prompt_id)).toEqual([firstPromptId, job1.prompt_id]);
    expect(attempts[0]!.status).toBe("failed"); // 首次尝试终态回写
    expect(attempts[1]!.status).toBe("queued");

    await succeed(ctx.store, ctx.fake, job1);
    expect(ctx.store.getAttempts(job1.id)[1]!.status).toBe("succeeded"); // 成功后 attempt 终态更新
    const view = ctx.manager.getBatchView(res.batchId);
    expect(view.status).toBe("completed");
    expect(view.jobs[0]!.attempt_no).toBe(2);
    ctx.tracker.disposeAll();
    ctx.db.close();
  });

  it("重试耗尽 → 终态 failed（attempt_no = max_attempts）", async () => {
    const ctx = makeCtx();
    ctx.fake.submitImpl = async () => ({ ok: false, httpStatus: 400, errorBody: { type: "x" }, nodeErrors: null });
    const res = ctx.manager.createBatch(wf, { runs: [run("always-bad")], maxAttempts: 2 });
    await ctx.scheduler.tick(); // attempt 1 → failed
    await ctx.scheduler.tick(); // retry → attempt 2 → failed
    await ctx.scheduler.tick(); // 次数用尽：不再重置
    const job = ctx.store.getJob(res.batchId, 0)!;
    expect(job.status).toBe("failed");
    expect(job.attempt_no).toBe(2);
    expect(ctx.store.getAttempts(job.id)).toHaveLength(2);
    expect(ctx.manager.getBatchView(res.batchId).status).toBe("failed");
    expect(ctx.fake.submitCalls).toBe(2);
    ctx.tracker.disposeAll();
    ctx.db.close();
  });

  it("submission_unknown 永不自动重试（即使 max_attempts>1）", async () => {
    const ctx = makeCtx();
    ctx.fake.submitImpl = async () => {
      throw new Error("network gone");
    };
    const res = ctx.manager.createBatch(wf, { runs: [run("u")], maxAttempts: 3 });
    await ctx.scheduler.tick();
    for (let i = 0; i < 5; i++) await ctx.scheduler.tick();
    expect(ctx.fake.submitCalls).toBe(1);
    expect(ctx.store.getJob(res.batchId, 0)!.status).toBe("submission_unknown");
    expect(ctx.store.getAttempts(ctx.store.getJob(res.batchId, 0)!.id)).toHaveLength(1);
    ctx.tracker.disposeAll();
    ctx.db.close();
  });
});

describe("组合语义：continue_on_error=false × max_attempts>1（Task 005 §二.5）", () => {
  it("失败且重试未耗尽 → 先重试，不级联；重试成功则整批照常完成", async () => {
    const ctx = makeCtx();
    let flakySeen = 0;
    ctx.fake.submitImpl = async (graph, opts) => {
      const text = String((graph["4"]!.inputs as Record<string, unknown>)["text"]);
      if (text === "flaky" && flakySeen++ === 0) {
        return { ok: false, httpStatus: 400, errorBody: { type: "x" }, nodeErrors: null };
      }
      return { ok: true, promptId: opts?.promptId ?? "x", number: 1, nodeErrors: {} };
    };
    const res = ctx.manager.createBatch(wf, {
      runs: [run("flaky"), run("b"), run("c")],
      continueOnError: false, // 严格模式
      maxAttempts: 2
    });
    await drain(ctx, res.batchId);
    // 首次失败未触发级联（b/c 未被取消），重试后全部完成
    const view = ctx.manager.getBatchView(res.batchId);
    expect(view.jobs.map((j) => [j.index, j.status])).toEqual([[0, "succeeded"], [1, "succeeded"], [2, "succeeded"]]);
    expect(view.status).toBe("completed");
    expect(ctx.fake.submitCalls).toBe(4); // flaky×2 + b + c
    ctx.tracker.disposeAll();
    ctx.db.close();
  });

  it("重试耗尽的终态失败才级联：pending → cancelled；已在途 job 继续执行且结果保留", async () => {
    const ctx = makeCtx({ maxInFlight: 2, maxQueuedJobs: 1 });
    ctx.fake.submitImpl = async (graph) => {
      const text = String((graph["4"]!.inputs as Record<string, unknown>)["text"]);
      if (text === "always-bad") {
        return { ok: false, httpStatus: 400, errorBody: { type: "x" }, nodeErrors: null };
      }
      return { ok: true, promptId: "x", number: 1, nodeErrors: {} };
    };
    const res = ctx.manager.createBatch(wf, {
      runs: [run("always-bad"), run("in-flight-ok"), run("pending-1"), run("pending-2")],
      continueOnError: false,
      maxAttempts: 2
    });
    // 拍 1：always-bad 提交即拒（不占额度）；in-flight-ok 入队（MAX_QUEUED_JOBS=1 满）
    await ctx.scheduler.tick();
    expect(ctx.fake.submitCalls).toBe(2);
    const inFlight = ctx.store.getJob(res.batchId, 1)!;
    expect(inFlight.status).toBe("queued"); // 在途
    expect(ctx.store.getJob(res.batchId, 0)!.status).toBe("failed"); // attempt 1 失败（非终态：还有重试）
    // 拍 2：bad 重置为 pending 等待重试，但 MAX_QUEUED_JOBS=1 被 in-flight-ok 占据 →
    // 重试暂不提交；此时无终态失败 → 不级联（pending-1/2 保持 pending）
    await ctx.scheduler.tick();
    const bad = ctx.store.getJob(res.batchId, 0)!;
    expect(bad.status).toBe("pending"); // 等窗口
    expect(bad.attempt_no).toBe(1);
    expect(ctx.store.getJob(res.batchId, 2)!.status).toBe("pending"); // 未级联
    // 在途任务自然完成（未被取消，结果保留）
    await succeed(ctx.store, ctx.fake, inFlight);
    expect(ctx.store.getJob(res.batchId, 1)!.status).toBe("succeeded");
    // 拍 3：窗口空出 → bad 重试（attempt 2）→ 再次失败 = 终态失败 → 同拍级联取消 pending-1/2
    await ctx.scheduler.tick();
    const badFinal = ctx.store.getJob(res.batchId, 0)!;
    expect(badFinal.status).toBe("failed");
    expect(badFinal.attempt_no).toBe(2);
    const p1 = ctx.store.getJob(res.batchId, 2)!;
    const p2 = ctx.store.getJob(res.batchId, 3)!;
    expect(p1.status).toBe("cancelled");
    expect(p2.status).toBe("cancelled");
    expect((JSON.parse(p1.error_json!) as { code: string }).code).toBe("BATCH_ABORTED");
    const view = ctx.manager.getBatchView(res.batchId);
    // failed 口径 = failed(1) + cancelled(2)
    expect(view.stats).toEqual({ total: 4, succeeded: 1, failed: 3, running: 0, queued: 0, pending: 0, invalid: 0, unknown: 0 });
    expect(view.status).toBe("partial");
    expect(ctx.fake.submitCalls).toBe(3); // bad×2 + in-flight；pending 从未提交
    ctx.tracker.disposeAll();
    ctx.db.close();
  });

  it("invalid（创建即拒）在严格模式下同样触发级联", async () => {
    const ctx = makeCtx();
    const res = ctx.manager.createBatch(wf, {
      runs: [{ params: {} }, run("b")], // 缺 required prompt → invalid
      continueOnError: false
    });
    await ctx.scheduler.tick();
    expect(ctx.store.getJob(res.batchId, 1)!.status).toBe("cancelled"); // 未提交即放弃
    expect(ctx.fake.submitCalls).toBe(0);
    ctx.tracker.disposeAll();
    ctx.db.close();
  });
});

describe("tick 防重与恢复", () => {
  it("并发 5 个 tick（窗口 3/3）：每个 job 恰好提交一次", async () => {
    const ctx = makeCtx({ maxInFlight: 3, maxQueuedJobs: 3 });
    const res = ctx.manager.createBatch(wf, { runs: [run("a"), run("b"), run("c")] });
    await Promise.all([ctx.scheduler.tick(), ctx.scheduler.tick(), ctx.scheduler.tick(), ctx.scheduler.tick(), ctx.scheduler.tick()]);
    expect(ctx.fake.submitCalls).toBe(3);
    const promptIds = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const job = ctx.store.getJob(res.batchId, i)!;
      expect(job.attempt_no).toBe(1);
      promptIds.add(job.prompt_id!);
    }
    expect(promptIds.size).toBe(3);
    ctx.tracker.disposeAll();
    ctx.db.close();
  });

  it("同一 job 并发 submitJob：条件占位仅一方成功", async () => {
    const ctx = makeCtx();
    const res = ctx.manager.createBatch(wf, { runs: [run("a")] });
    const job = ctx.store.getJob(res.batchId, 0)!;
    const [r1, r2] = await Promise.all([
      ctx.runner.submitJob(wf, job),
      ctx.runner.submitJob(wf, { ...job }) // 模拟另一路径持同一 job 行
    ]);
    expect(ctx.fake.submitCalls).toBe(1);
    expect([r1 === null, r2 === null].filter(Boolean)).toHaveLength(1);
    ctx.tracker.disposeAll();
    ctx.db.close();
  });

  it("重启恢复：在途 re-track + pending 续跑（新 Scheduler 实例接管同一 store）", async () => {
    const ctx = makeCtx();
    const res = ctx.manager.createBatch(wf, { runs: [run("a"), run("b")] });
    await ctx.scheduler.tick(); // a → queued
    const jobA = ctx.store.getJob(res.batchId, 0)!;
    ctx.fake.queuePromptIds.pending.push(jobA.prompt_id!);

    // —— 模拟崩溃重启：丢弃全部运行时对象，仅 SQLite 存活 ——
    ctx.tracker.disposeAll();
    ctx.scheduler.stop();
    const store = ctx.store;
    const assets = new AssetManager(ctx.client, outDir);
    const tracker2 = new JobTracker({ client: ctx.client, store, assets, autoSave: true, defaultTimeoutMs: 60_000 });
    const runner2 = new JobRunner({ client: ctx.client, store, tracker: tracker2 });
    const scheduler2 = new Scheduler({ store, registry: registryLike, runner: runner2, maxInFlight: 1, maxQueuedJobs: 1 });

    // 恢复：a 仍在队列 → 重新跟踪（不重提）；随后完成 a，b 由新调度器续跑
    const report = await recoverInFlight({ client: ctx.client, store, assets, tracker: tracker2, autoSave: true });
    expect(report.requeued).toBe(1);
    await succeed(store, ctx.fake, store.getJob(res.batchId, 0)!);
    await scheduler2.tick();
    const jobB = store.getJob(res.batchId, 1)!;
    expect(jobB.status).toBe("queued");
    await succeed(store, ctx.fake, jobB);
    const view = new BatchManager(store).getBatchView(res.batchId);
    expect(view.status).toBe("completed");
    expect(view.stats).toMatchObject({ succeeded: 2 });
    tracker2.disposeAll();
    ctx.db.close();
  });

  it("批量创建后未提交即重启：pending 由调度器直接续跑", async () => {
    const ctx = makeCtx();
    const res = ctx.manager.createBatch(wf, { runs: [run("late-0"), run("late-1")] });
    // 未 tick（模拟提交前崩溃）→ 新调度器接管
    ctx.tracker.disposeAll();
    const store = ctx.store;
    const tracker2 = new JobTracker({ client: ctx.client, store, assets: new AssetManager(ctx.client, outDir), autoSave: true, defaultTimeoutMs: 60_000 });
    const runner2 = new JobRunner({ client: ctx.client, store, tracker: tracker2 });
    const scheduler2 = new Scheduler({ store, registry: registryLike, runner: runner2, maxInFlight: 1, maxQueuedJobs: 1 });
    await scheduler2.tick();
    expect(ctx.fake.submitCalls).toBe(1);
    expect(store.getJob(res.batchId, 0)!.status).toBe("queued");
    tracker2.disposeAll();
    ctx.db.close();
  });

  it("工作流消失 → invalid，不阻断其他 batch", async () => {
    const ctx = makeCtx();
    const gone = ctx.manager.createBatch(
      { ...wf, manifest: parseManifest("g.manifest.json", JSON.stringify({ ...JSON.parse(JSON.stringify({ ...manifest, name: "gone" })), name: "gone" })) },
      { runs: [run("x")] }
    );
    const b2 = ctx.manager.createBatch(wf, { runs: [run("ok")] });
    // gone 的 manifest name 不同 → registryLike.get("gone") 返回 undefined
    await ctx.scheduler.tick();
    await ctx.scheduler.tick();
    expect(ctx.store.getJob(gone.batchId, 0)!.status).toBe("invalid");
    expect(ctx.store.getJob(b2.batchId, 0)!.status).toBe("queued");
    ctx.tracker.disposeAll();
    ctx.db.close();
  });
});
