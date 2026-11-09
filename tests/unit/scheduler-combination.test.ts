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
import { AssetManager } from "../../src/core/assets/asset-manager.js";
import { makeFakeClient, historyEntry, type FakeHttpState } from "../helpers/fake-client.js";
import type { ComfyEventBus } from "../../src/core/client/event-bus.js";
import type { ComfyClient } from "../../src/core/client/index.js";
import { parseManifest } from "../../src/core/workflow/manifest.js";
import type { RegisteredWorkflow, WorkflowRegistry } from "../../src/core/workflow/registry.js";

/**
 * P4.1 §二.5 调度组合语义：continue_on_error=false × max_attempts>1
 * - 失败允许先重试（重试优先于级联取消；重试未用尽期间 batch 不收敛）
 * - 级联取消仅在【终态失败】（重试用尽 / invalid）时触发
 * - 级联时：在途 job 不受影响照常执行；未提交 job → cancelled/BATCH_ABORTED
 * - 同一 tick 内重试再次失败（次数未用尽）不得提前级联（终态判定回归）
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
  fingerprints: { manifestFingerprint: "fp-manifest-t", graphFingerprint: "fp-graph-t" }
};

const registryLike = { get: (name: string) => (name === "t" ? wf : undefined) } as unknown as WorkflowRegistry;

let outDir: string;

beforeEach(async () => {
  outDir = await mkdtemp(path.join(tmpdir(), "comb-out-"));
});

afterEach(async () => {
  await rm(outDir, { recursive: true, force: true });
});

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

function makeCtx(maxInFlight = 1): Ctx {
  const db = openDb(":memory:");
  const store = new BatchStore(db);
  const fc = makeFakeClient();
  const assets = new AssetManager(fc.client, outDir);
  const tracker = new JobTracker({ client: fc.client, store, assets, autoSave: true, defaultTimeoutMs: 60_000 });
  const runner = new JobRunner({ client: fc.client, store, tracker });
  const manager = new BatchManager(store);
  const scheduler = new Scheduler({ store, registry: registryLike, runner, maxInFlight, maxQueuedJobs: maxInFlight });
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

/** 提交即被 ComfyUI 拒绝（HTTP 400）的行为 */
function rejectAll(fake: FakeHttpState): void {
  fake.submitImpl = async () => ({ ok: false, httpStatus: 400, errorBody: { type: "x" }, nodeErrors: null });
}

/** 指定文本的任务被拒绝，其余正常 */
function rejectTexts(fake: FakeHttpState, texts: string[]): void {
  fake.submitImpl = async (graph, opts) => {
    const text = String((graph["4"]!.inputs as Record<string, unknown>)["text"]);
    if (texts.includes(text)) {
      return { ok: false, httpStatus: 400, errorBody: { type: "x" }, nodeErrors: null };
    }
    return { ok: true, promptId: opts?.promptId ?? "x", number: 1, nodeErrors: {} };
  };
}

describe("continue_on_error=false × max_attempts>1", () => {
  it("失败先重试：重试未用尽不触发级联（b/c 保持 pending，batch 不收敛）", async () => {
    const ctx = makeCtx();
    let poisonAttempts = 0;
    ctx.fake.submitImpl = async (graph, opts) => {
      const text = String((graph["4"]!.inputs as Record<string, unknown>)["text"]);
      if (text === "poison" && poisonAttempts++ < 2) {
        return { ok: false, httpStatus: 400, errorBody: { type: "x" }, nodeErrors: null }; // 前 2 次失败
      }
      return { ok: true, promptId: opts?.promptId ?? "x", number: 1, nodeErrors: {} };
    };
    const res = ctx.manager.createBatch(wf, {
      runs: [run("poison"), run("b")],
      continueOnError: false,
      maxAttempts: 3
    });
    await ctx.scheduler.tick(); // poison attempt 1 → failed（次数未用尽）
    const p = ctx.store.getJob(res.batchId, 0)!;
    expect(p.status).toBe("failed");
    expect(ctx.store.getJob(res.batchId, 1)!.status).toBe("pending"); // 未被级联放弃
    expect(ctx.store.getBatch(res.batchId)!.status).toBe("running"); // 不收敛

    await ctx.scheduler.tick(); // 重置 pending → attempt 2 → failed（仍未用尽）
    expect(ctx.store.getJob(res.batchId, 1)!.status).toBe("pending");
    await ctx.scheduler.tick(); // attempt 3 → 成功
    const p3 = ctx.store.getJob(res.batchId, 0)!;
    expect(p3.status).toBe("queued");
    expect(p3.attempt_no).toBe(3);
    await succeed(ctx.store, ctx.fake, p3);
    await ctx.scheduler.tick(); // b 正常提交
    const b = ctx.store.getJob(res.batchId, 1)!;
    expect(b.status).toBe("queued");
    await succeed(ctx.store, ctx.fake, b);
    expect(ctx.manager.getBatchView(res.batchId).status).toBe("completed"); // 全部成功
    ctx.tracker.disposeAll();
    ctx.db.close();
  });

  it("终态失败（重试用尽）才级联：剩余 pending → cancelled/BATCH_ABORTED；batch failed", async () => {
    const ctx = makeCtx();
    rejectAll(ctx.fake);
    const res = ctx.manager.createBatch(wf, {
      runs: [run("doomed"), run("b"), run("c")],
      continueOnError: false,
      maxAttempts: 2
    });
    await ctx.scheduler.tick(); // attempt 1 → failed
    await ctx.scheduler.tick(); // attempt 2 → failed（用尽）
    await ctx.scheduler.tick(); // 终态失败 → 级联
    const view = ctx.manager.getBatchView(res.batchId);
    expect(view.jobs.map((j) => [j.index, j.status])).toEqual([[0, "failed"], [1, "cancelled"], [2, "cancelled"]]);
    expect(view.jobs[1]!.error!.code).toBe("BATCH_ABORTED");
    expect(view.status).toBe("failed");
    expect(ctx.store.getJob(res.batchId, 0)!.attempt_no).toBe(2); // 重试历史完整
    expect(ctx.fake.submitCalls).toBe(2); // 只提交过 doomed 的两次尝试
    ctx.tracker.disposeAll();
    ctx.db.close();
  });

  it("invalid（创建即终态，无重试概念）也触发级联——首个 tick 即放弃，未提交任务不消耗生成", async () => {
    const ctx = makeCtx();
    const res = ctx.manager.createBatch(wf, {
      runs: [run("ok"), { params: { prompt: "x", seed: 1, no_such_param: 1 } }, run("c")], // run1 参数非法 → invalid
      continueOnError: false,
      maxAttempts: 3
    });
    await ctx.scheduler.tick(); // invalid 创建即定 → 首个 tick 级联取消全部 pending（含 run0，从未提交）
    const view = ctx.manager.getBatchView(res.batchId);
    expect(view.jobs.map((j) => [j.index, j.status])).toEqual([[0, "cancelled"], [1, "invalid"], [2, "cancelled"]]);
    expect(view.jobs[0]!.error!.code).toBe("BATCH_ABORTED");
    expect(view.status).toBe("failed");
    expect(ctx.fake.submitCalls).toBe(0); // 无任何提交/生成
    ctx.tracker.disposeAll();
    ctx.db.close();
  });

  it("级联时在途 job 照常执行至完成（不取消已提交的）", async () => {
    const ctx = makeCtx(2); // 窗口 2：a、b 可同时在途
    rejectTexts(ctx.fake, ["poison"]);
    const res = ctx.manager.createBatch(wf, {
      runs: [run("good-1"), run("poison"), run("good-2"), run("d")],
      continueOnError: false,
      maxAttempts: 1
    });
    await ctx.scheduler.tick(); // good-1、poison 在途/定败
    const g1 = ctx.store.getJob(res.batchId, 0)!;
    expect(g1.status).toBe("queued"); // 在途
    expect(ctx.store.getJob(res.batchId, 1)!.status).toBe("failed"); // poison 终态失败（attempts=1）
    await ctx.scheduler.tick(); // 级联：good-2、d（pending）→ cancelled；good-1 在途不动
    expect(ctx.store.getJob(res.batchId, 2)!.status).toBe("cancelled");
    expect(ctx.store.getJob(res.batchId, 3)!.status).toBe("cancelled");
    expect(ctx.store.getJob(res.batchId, 0)!.status).toBe("queued"); // 在途不受影响
    await succeed(ctx.store, ctx.fake, g1); // 在途任务完成
    const view = ctx.manager.getBatchView(res.batchId);
    expect(view.status).toBe("partial");
    // failed 口径 = failed(1) + cancelled(2)（unknown/paused 单列口径不变）
    expect(view.stats).toMatchObject({ succeeded: 1, failed: 3 });
    ctx.tracker.disposeAll();
    ctx.db.close();
  });

  it("回归：同一 tick 内重试再次失败（次数未用尽）不得提前级联", async () => {
    const ctx = makeCtx();
    let attempts = 0;
    ctx.fake.submitImpl = async (graph, opts) => {
      const text = String((graph["4"]!.inputs as Record<string, unknown>)["text"]);
      if (text === "flaky" && attempts++ < 2) {
        return { ok: false, httpStatus: 400, errorBody: { type: "x" }, nodeErrors: null };
      }
      return { ok: true, promptId: opts?.promptId ?? "x", number: 1, nodeErrors: {} };
    };
    const res = ctx.manager.createBatch(wf, {
      runs: [run("flaky"), run("b")],
      continueOnError: false,
      maxAttempts: 3
    });
    await ctx.scheduler.tick(); // attempt 1 失败（tick 内提交循环的 abort 重查不得级联 b）
    expect(ctx.store.getJob(res.batchId, 1)!.status).toBe("pending");
    await ctx.scheduler.tick(); // 重置 → attempt 2 失败（同上，仍不得级联）
    expect(ctx.store.getJob(res.batchId, 1)!.status).toBe("pending");
    await ctx.scheduler.tick(); // attempt 3 → 成功
    const f = ctx.store.getJob(res.batchId, 0)!;
    expect(f.status).toBe("queued");
    await succeed(ctx.store, ctx.fake, f);
    await ctx.scheduler.tick();
    await succeed(ctx.store, ctx.fake, ctx.store.getJob(res.batchId, 1)!);
    expect(ctx.manager.getBatchView(res.batchId).status).toBe("completed");
    ctx.tracker.disposeAll();
    ctx.db.close();
  });

  it("对照：continue_on_error=true 时同样的终态失败不级联不挂起（其余照常跑完）", async () => {
    const ctx = makeCtx();
    rejectTexts(ctx.fake, ["poison"]);
    const res = ctx.manager.createBatch(wf, {
      runs: [run("a"), run("poison"), run("c")],
      continueOnError: true,
      maxAttempts: 2
    });
    // 驱动至收敛：每轮 tick + 完成在途
    for (let round = 0; round < 20; round++) {
      await ctx.scheduler.tick();
      const active = ctx.store
        .inFlightJobs()
        .filter((j) => j.batch_id === res.batchId && (j.status === "queued" || j.status === "executing"));
      for (const j of active) await succeed(ctx.store, ctx.fake, j);
      const done = ctx.store.getBatch(res.batchId)!.status !== "running";
      if (done) break;
    }
    const view = ctx.manager.getBatchView(res.batchId);
    expect(view.status).toBe("partial");
    expect(view.stats).toMatchObject({ succeeded: 2, failed: 1 });
    expect(ctx.store.getJob(res.batchId, 1)!.attempt_no).toBe(2); // poison 重试过一次
    expect(ctx.store.getAttempts(ctx.store.getJob(res.batchId, 1)!.id)).toHaveLength(2);
    ctx.tracker.disposeAll();
    ctx.db.close();
  });
});
