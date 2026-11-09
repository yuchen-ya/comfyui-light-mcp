import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb } from "../../src/core/storage/db.js";
import type Database from "better-sqlite3";
import { BatchStore, type JobRow } from "../../src/core/batch/store.js";
import { JobRunner } from "../../src/core/batch/runner.js";
import { JobTracker } from "../../src/core/batch/tracker.js";
import { AssetManager } from "../../src/core/assets/asset-manager.js";
import { makeFakeClient, historyEntry, type FakeHttpState } from "../helpers/fake-client.js";
import type { ComfyEventBus } from "../../src/core/client/event-bus.js";
import type { ComfyClient } from "../../src/core/client/index.js";
import { parseManifest } from "../../src/core/workflow/manifest.js";
import type { RegisteredWorkflow } from "../../src/core/workflow/registry.js";

/**
 * P4.1 §二.1 统一任务中断状态：
 * - 用户主动取消（WS execution_interrupted / history interrupted）→ cancelled
 * - 执行超时 → timeout；超时取消过程中收到的 interrupted 不改判 failed/cancelled，
 *   且保留远端取消操作结果（remote_cancel）
 * - ComfyUI 执行失败（execution_error / history error）→ failed
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

let outDir: string;

beforeEach(async () => {
  outDir = await mkdtemp(path.join(tmpdir(), "intr-out-"));
});

afterEach(async () => {
  await rm(outDir, { recursive: true, force: true });
});

function setup(timeoutMs = 60_000): {
  db: Database.Database;
  store: BatchStore;
  fake: FakeHttpState;
  bus: ComfyEventBus;
  client: ComfyClient;
  tracker: JobTracker;
  runner: JobRunner;
} {
  const db = openDb(":memory:");
  const store = new BatchStore(db);
  const fc = makeFakeClient();
  const assets = new AssetManager(fc.client, outDir);
  const tracker = new JobTracker({ client: fc.client, store, assets, autoSave: true, defaultTimeoutMs: timeoutMs });
  const runner = new JobRunner({ client: fc.client, store, tracker });
  return { db, store, fake: fc.state, bus: fc.bus, client: fc.client, tracker, runner };
}

async function submitOne(ctx: ReturnType<typeof setup>): Promise<JobRow> {
  const handle = await ctx.runner.submitSingle(wf, { prompt: "x", seed: 1 });
  const job = ctx.store.getJob(handle.batchId, 0)!;
  expect(job.status).toBe("queued");
  return job;
}

async function eventually(pred: () => boolean, ms = 4000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error("eventually 超时");
    await new Promise((r) => setTimeout(r, 20));
  }
}

function readError(store: BatchStore, jobId: string): { code: string; message: string; remote_cancel?: { queue_delete: string; interrupt: string } } {
  const job = store.getJobById(jobId)!;
  return JSON.parse(job.error_json!) as { code: string; message: string; remote_cancel?: { queue_delete: string; interrupt: string } };
}

describe("用户/外部中断 → cancelled（不再误标 failed）", () => {
  it("WS execution_interrupted 事件 → cancelled + code=INTERRUPTED", async () => {
    const ctx = setup();
    const job = await submitOne(ctx);
    ctx.bus.publish({ type: "execution_interrupted", data: { prompt_id: job.prompt_id } });
    await eventually(() => ctx.store.getJobById(job.id)!.status === "cancelled");
    const err = readError(ctx.store, job.id);
    expect(err.code).toBe("INTERRUPTED");
    expect(ctx.store.getJobById(job.id)!.status).toBe("cancelled");
    ctx.tracker.disposeAll();
    ctx.db.close();
  });

  it("history 轮询判定 interrupted → cancelled（WS 断线兜底路径）", async () => {
    const ctx = setup();
    const job = await submitOne(ctx);
    // 不发 WS 事件；history 记录 interrupted → 轮询兜底判定
    ctx.fake.history.set(job.prompt_id!, historyEntry({}, "interrupted"));
    await eventually(() => ctx.store.getJobById(job.id)!.status === "cancelled");
    expect(readError(ctx.store, job.id).code).toBe("INTERRUPTED");
    ctx.tracker.disposeAll();
    ctx.db.close();
  });
});

describe("超时取消期间的 interrupted → 仍判 timeout，保留 remote_cancel", () => {
  it("组合取消触发服务端 interrupted 事件：终态 timeout（非 failed/cancelled），remote_cancel 完整", async () => {
    const ctx = setup(80); // 80ms 超时
    const job = await submitOne(ctx);
    // 组合取消期间 ComfyUI 发出 execution_interrupted（我们自己的 interrupt 的效果）
    ctx.fake.interruptImpl = async (promptId) => {
      ctx.bus.publish({ type: "execution_interrupted", data: { prompt_id: promptId ?? job.prompt_id } });
    };
    await eventually(() => ctx.store.getJobById(job.id)!.status === "timeout");
    const j = ctx.store.getJobById(job.id)!;
    expect(j.status).toBe("timeout");
    const err = readError(ctx.store, job.id);
    expect(err.code).toBe("TIMEOUT");
    expect(err.remote_cancel).toEqual({ queue_delete: "ok", interrupt: "ok" }); // 远端取消结果保留
    expect(err.message).toContain("interrupted"); // 审计注记：取消期间的 interrupted 是取消效果
    // attempt 终态同步
    const attempts = ctx.store.getAttempts(job.id);
    expect(attempts[0]!.status).toBe("timeout");
    ctx.tracker.disposeAll();
    ctx.db.close();
  });

  it("超时取消期间 history 先记 interrupted → 仍 timeout（轮询不抢判 cancelled）", async () => {
    const ctx = setup(80);
    const job = await submitOne(ctx);
    // interrupt 生效后 history 立刻记录 interrupted；同时拖住 queue delete，
    // 让 3s history 轮询在取消进行中插进来——轮询须跳过（是我们自己的取消效果）
    ctx.fake.interruptImpl = async () => {
      ctx.fake.history.set(job.prompt_id!, historyEntry({}, "interrupted"));
    };
    ctx.fake.deleteQueueImpl = async () => {
      await new Promise((r) => setTimeout(r, 3300));
    };
    await eventually(() => ctx.store.getJobById(job.id)!.status === "timeout", 8000);
    expect(ctx.store.getJobById(job.id)!.status).toBe("timeout");
    expect(readError(ctx.store, job.id).remote_cancel).toEqual({ queue_delete: "ok", interrupt: "ok" });
    ctx.tracker.disposeAll();
    ctx.db.close();
  });

  it("取消进行中任务恰好成功 → succeeded（先到者为准，不改判 timeout）", async () => {
    const ctx = setup(80);
    const job = await submitOne(ctx);
    ctx.fake.deleteQueueImpl = async () => {
      // 取消瞬间任务其实已完成（WS success 已定终态）
      ctx.fake.history.set(
        job.prompt_id!,
        historyEntry({ "9": { images: [{ filename: "win.png", subfolder: "", type: "output" }] } })
      );
      ctx.bus.publish({ type: "execution_success", data: { prompt_id: job.prompt_id } });
    };
    await eventually(() => ctx.store.getJobById(job.id)!.status === "succeeded");
    const j = ctx.store.getJobById(job.id)!;
    expect(j.status).toBe("succeeded");
    expect(j.error_json).toBeNull(); // 成功无错误
    ctx.tracker.disposeAll();
    ctx.db.close();
  });

  it("远端取消失败 → 保持 unknown 且 remote_cancel 记录失败明细", async () => {
    const ctx = setup(80);
    const job = await submitOne(ctx);
    ctx.fake.interruptImpl = async () => {
      throw new Error("interrupt RPC broken");
    };
    ctx.fake.deleteQueueImpl = async () => {
      throw new Error("queue delete RPC broken");
    };
    await eventually(() => ctx.store.getJobById(job.id)!.status === "submission_unknown");
    const err = readError(ctx.store, job.id);
    expect(err.remote_cancel?.queue_delete).toContain("error");
    expect(err.remote_cancel?.interrupt).toContain("error");
    ctx.tracker.disposeAll();
    ctx.db.close();
  });
});

describe("ComfyUI 执行失败 → failed（不受取消语义影响）", () => {
  it("WS execution_error 事件 → failed", async () => {
    const ctx = setup();
    const job = await submitOne(ctx);
    ctx.bus.publish({
      type: "execution_error",
      data: { prompt_id: job.prompt_id, exception_message: "OOM" }
    });
    await eventually(() => ctx.store.getJobById(job.id)!.status === "failed");
    expect(readError(ctx.store, job.id).code).toBe("EXECUTION_ERROR");
    ctx.tracker.disposeAll();
    ctx.db.close();
  });

  it("execution_success 但 history 实为 error → 防御守卫判 failed（终态优先级）", async () => {
    const ctx = setup();
    const job = await submitOne(ctx);
    ctx.fake.history.set(job.prompt_id!, historyEntry({ "9": { images: [{ filename: "p.png", subfolder: "", type: "output" }] } }, "error"));
    ctx.bus.publish({ type: "execution_success", data: { prompt_id: job.prompt_id } });
    await eventually(() => ctx.store.getJobById(job.id)!.status === "failed");
    expect(readError(ctx.store, job.id).code).toBe("EXECUTION_ERROR");
    ctx.tracker.disposeAll();
    ctx.db.close();
  });
});
