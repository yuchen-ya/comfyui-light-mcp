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
import { makeFakeClient, historyEntry, type FakeHttpState } from "../helpers/fake-client.js";
import type { ComfyEventBus } from "../../src/core/client/event-bus.js";
import type { ComfyClient } from "../../src/core/client/index.js";
import { parseManifest } from "../../src/core/workflow/manifest.js";
import type { RegisteredWorkflow, WorkflowRegistry } from "../../src/core/workflow/registry.js";
import { fingerprintMismatch } from "../../src/core/workflow/fingerprint.js";
import { contentFingerprint } from "../../src/shared/fingerprint.js";

/**
 * P4.1 §二.2 工作流版本保护：
 * - batch 创建时保存 manifest version + manifest/图内容指纹
 * - 提交 pending / 恢复时验证：漂移 → 暂停该 batch 剩余 pending（WORKFLOW_VERSION_MISMATCH），
 *   不静默用新版本续跑、不影响其他 batch
 * - 指纹恢复一致（工作流还原）→ 自动解除暂停续跑
 * - job 级不复制 workflow JSON（指纹只在 batch 行）
 */

function buildManifest(version = 1) {
  return parseManifest(
    "t.manifest.json",
    JSON.stringify({
      name: "t",
      description: "d",
      version,
      workflowFile: "t.json",
      params: [
        { name: "prompt", node: "4", input: "text", type: "string", required: true },
        { name: "seed", node: "7", input: "seed", type: "integer", default: -1, special: "seed" }
      ]
    })
  );
}

function makeWf(opts?: { version?: number; manifestFingerprint?: string; graphFingerprint?: string }): RegisteredWorkflow {
  const manifest = buildManifest(opts?.version);
  return {
    manifest,
    graph: {
      "4": { class_type: "TextEncode", inputs: { text: "tpl" } },
      "7": { class_type: "KSampler", inputs: { seed: 42 } },
      "9": { class_type: "SaveImage", inputs: { images: ["8", 0] } }
    },
    sourceFile: "t.manifest.json",
    fingerprints: {
      manifestFingerprint: opts?.manifestFingerprint ?? contentFingerprint(manifest),
      graphFingerprint: opts?.graphFingerprint ?? "fp-graph-v1"
    }
  };
}

let outDir: string;

beforeEach(async () => {
  outDir = await mkdtemp(path.join(tmpdir(), "wfv-out-"));
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
  registry: { current: RegisteredWorkflow | undefined };
  scheduler: Scheduler;
}

function makeCtx(wf: RegisteredWorkflow, maxInFlight = 1): Ctx {
  const db = openDb(":memory:");
  const store = new BatchStore(db);
  const fc = makeFakeClient();
  const assets = new AssetManager(fc.client, outDir);
  const tracker = new JobTracker({ client: fc.client, store, assets, autoSave: true, defaultTimeoutMs: 60_000 });
  const runner = new JobRunner({ client: fc.client, store, tracker });
  const manager = new BatchManager(store);
  const registry = {
    current: wf,
    get: (name: string) => (registry.current?.manifest.name === name ? registry.current : undefined),
    list: () => []
  } as unknown as WorkflowRegistry & { current: RegisteredWorkflow | undefined };
  const scheduler = new Scheduler({ store, registry, runner, maxInFlight, maxQueuedJobs: maxInFlight });
  return { db, store, fake: fc.state, bus: fc.bus, client: fc.client, tracker, runner, manager, registry, scheduler };
}

const run = (text: string, seed = 1) => ({ params: { prompt: text, seed } });

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

describe("fingerprintMismatch 判定", () => {
  it("一致 → null；manifest 漂移/图漂移/版本变化 → 差异明细", () => {
    const wf = makeWf();
    expect(fingerprintMismatch(
      { workflowVersion: 1, manifestFingerprint: wf.fingerprints.manifestFingerprint, graphFingerprint: "fp-graph-v1" },
      { version: 1, ...wf.fingerprints }
    )).toBeNull();
    expect(fingerprintMismatch(
      { workflowVersion: 2, manifestFingerprint: wf.fingerprints.manifestFingerprint, graphFingerprint: "fp-graph-v1" },
      { version: 1, ...wf.fingerprints }
    )).toContain("版本");
    expect(fingerprintMismatch(
      { workflowVersion: 1, manifestFingerprint: "other", graphFingerprint: "fp-graph-v1" },
      { version: 1, ...wf.fingerprints }
    )).toContain("manifest 指纹");
    expect(fingerprintMismatch(
      { workflowVersion: 1, manifestFingerprint: wf.fingerprints.manifestFingerprint, graphFingerprint: "changed" },
      { version: 1, ...wf.fingerprints }
    )).toContain("工作流图指纹");
  });
  it("旧行（两指纹均 NULL）→ 明确缺少快照", () => {
    expect(fingerprintMismatch(
      { workflowVersion: 9, manifestFingerprint: null, graphFingerprint: null },
      { version: 1, manifestFingerprint: "x", graphFingerprint: "y" }
    )).toContain("LEGACY_SNAPSHOT_MISSING");
  });
});

describe("提交时验证：漂移 → 暂停，不影响其他 batch", () => {
  it("首个 job 提交后工作流被修改 → 剩余 pending 全部 paused（WORKFLOW_VERSION_MISMATCH）", async () => {
    const wfV1 = makeWf();
    const ctx = makeCtx(wfV1);
    const res = ctx.manager.createBatch(wfV1, { runs: [run("a"), run("b"), run("c")] });
    await ctx.scheduler.tick(); // 提交 a（用 v1）
    expect(ctx.store.getJob(res.batchId, 0)!.status).toBe("queued");

    // 工作流被修改（图内容变化，version 也升了）
    ctx.registry.current = makeWf({ version: 2, graphFingerprint: "fp-graph-v2" });
    await ctx.scheduler.tick(); // b、c 应被暂停而非用 v2 继续跑
    const b = ctx.store.getJob(res.batchId, 1)!;
    const c = ctx.store.getJob(res.batchId, 2)!;
    expect(b.status).toBe("paused");
    expect(c.status).toBe("paused");
    const err = JSON.parse(b.error_json!) as { code: string; message: string };
    expect(err.code).toBe("WORKFLOW_VERSION_MISMATCH");
    expect(err.message).toContain("工作流图指纹");
    expect(ctx.fake.submitCalls).toBe(1); // b/c 未被提交（没有静默用新版本）
    // batch 不收敛，保持 running（等待还原或人工处理）
    expect(ctx.store.getBatch(res.batchId)!.status).toBe("running");
    // stats 单列 paused
    const view = ctx.manager.getBatchView(res.batchId);
    expect(view.stats.paused).toBe(2);
    expect(view.stats.pending).toBe(0);
    ctx.tracker.disposeAll();
    ctx.db.close();
  });

  it("漂移只影响本 batch：其他 batch 照常调度", async () => {
    const wfV1 = makeWf();
    const wfV2 = makeWf({ version: 2, graphFingerprint: "fp-graph-v2" });
    const ctx = makeCtx(wfV1, 2);
    const stale = ctx.manager.createBatch(wfV1, { runs: [run("stale-0"), run("stale-1"), run("stale-2")] });
    await ctx.scheduler.tick(); // 窗口 2：stale-0、stale-1 提交
    await succeed(ctx.store, ctx.fake, ctx.store.getJob(stale.batchId, 0)!);
    await succeed(ctx.store, ctx.fake, ctx.store.getJob(stale.batchId, 1)!); // 窗口清空，stale-2 待提交
    const fresh = ctx.manager.createBatch(wfV2, { runs: [run("fresh-0")] });
    // registry 换成 v2：stale batch 漂移（stale-2 暂停），fresh batch 匹配（照常提交）
    ctx.registry.current = wfV2;
    await ctx.scheduler.tick();
    expect(ctx.store.getJob(stale.batchId, 2)!.status).toBe("paused"); // 老 batch 剩余暂停
    expect(ctx.store.getJob(fresh.batchId, 0)!.status).toBe("queued"); // 新 batch 正常提交
    ctx.tracker.disposeAll();
    ctx.db.close();
  });

  it("指纹恢复一致（工作流还原）→ paused 自动解除续跑至完成", async () => {
    const wfV1 = makeWf();
    const ctx = makeCtx(wfV1);
    const res = ctx.manager.createBatch(wfV1, { runs: [run("a"), run("b")] });
    await ctx.scheduler.tick(); // a 提交
    ctx.registry.current = makeWf({ version: 2, graphFingerprint: "fp-graph-v2" });
    await ctx.scheduler.tick(); // b 暂停
    expect(ctx.store.getJob(res.batchId, 1)!.status).toBe("paused");

    // 用户把工作流还原为 batch 创建时的内容
    ctx.registry.current = wfV1;
    await succeed(ctx.store, ctx.fake, ctx.store.getJob(res.batchId, 0)!);
    await ctx.scheduler.tick(); // 解除暂停 + 提交 b
    const b = ctx.store.getJob(res.batchId, 1)!;
    expect(b.status).toBe("queued");
    expect(b.error_json).toBeNull(); // 暂停错误清除
    await succeed(ctx.store, ctx.fake, b);
    const view = ctx.manager.getBatchView(res.batchId);
    expect(view.status).toBe("completed");
    expect(view.stats).toMatchObject({ succeeded: 2, paused: 0 });
    ctx.tracker.disposeAll();
    ctx.db.close();
  });

  it("已提交的在途 job 不受漂移影响（旧图已在 ComfyUI 执行，照常定终态）", async () => {
    const wfV1 = makeWf();
    const ctx = makeCtx(wfV1, 2);
    const res = ctx.manager.createBatch(wfV1, { runs: [run("a"), run("b")] });
    await ctx.scheduler.tick(); // a、b 都在途（窗口 2）
    ctx.registry.current = makeWf({ version: 2, graphFingerprint: "fp-graph-v2" });
    await ctx.scheduler.tick(); // 漂移检查只针对 pending——在途无 pending 不暂停
    const a = ctx.store.getJob(res.batchId, 0)!;
    const b = ctx.store.getJob(res.batchId, 1)!;
    expect(a.status).toBe("queued");
    expect(b.status).toBe("queued");
    await succeed(ctx.store, ctx.fake, a);
    await succeed(ctx.store, ctx.fake, b);
    expect(ctx.manager.getBatchView(res.batchId).status).toBe("completed");
    ctx.tracker.disposeAll();
    ctx.db.close();
  });
});

describe("恢复时验证", () => {
  it("重启后工作流已漂移 → 恢复即暂停 pending，不执行剩余任务", async () => {
    const wfV1 = makeWf();
    const ctx = makeCtx(wfV1);
    const res = ctx.manager.createBatch(wfV1, { runs: [run("a"), run("b"), run("c")] });
    await ctx.scheduler.tick(); // a 提交
    const a = ctx.store.getJob(res.batchId, 0)!;
    ctx.fake.queuePromptIds.pending.push(a.prompt_id!); // a 仍在远端队列

    // 模拟重启：工作流在停机期间被修改
    ctx.registry.current = makeWf({ version: 2, graphFingerprint: "fp-graph-v2" });
    const report = await recoverInFlight({
      client: ctx.client,
      store: ctx.store,
      assets: new AssetManager(ctx.client, outDir),
      tracker: ctx.tracker,
      autoSave: true,
      registry: ctx.registry as unknown as WorkflowRegistry
    });
    expect(report.requeued).toBe(1); // a 重新挂接跟踪
    expect(report.pausedOnVersionMismatch).toBe(2); // b、c 暂停
    expect(ctx.store.getJob(res.batchId, 1)!.status).toBe("paused");
    await ctx.scheduler.tick();
    expect(ctx.fake.submitCalls).toBe(1); // 未重提也未提交 b/c
    ctx.tracker.disposeAll();
    ctx.db.close();
  });

  it("旧行（指纹 NULL）→ 恢复/提交均暂停，零 POST", async () => {
    const wfV1 = makeWf();
    const ctx = makeCtx(wfV1);
    const res = ctx.manager.createBatch(wfV1, { runs: [run("a"), run("b")] });
    // 抹掉指纹模拟 v2 旧行
    (ctx.store as unknown as { db: { prepare: (s: string) => { run: (id: string) => unknown } } })
      .db.prepare("UPDATE batches SET manifest_fingerprint = NULL, graph_fingerprint = NULL WHERE id = ?")
      .run(res.batchId);
    // 历史图无法证明相同；即使有当前工作流，也必须暂停。
    ctx.registry.current = makeWf({ version: 2, graphFingerprint: "fp-graph-v2" });
    const report = await recoverInFlight({
      client: ctx.client,
      store: ctx.store,
      assets: new AssetManager(ctx.client, outDir),
      tracker: ctx.tracker,
      autoSave: true,
      registry: ctx.registry as unknown as WorkflowRegistry
    });
    expect(report.pausedOnVersionMismatch).toBe(2);
    await ctx.scheduler.tick();
    expect(ctx.store.getJob(res.batchId, 0)!.status).toBe("paused");
    expect(ctx.store.getJob(res.batchId, 1)!.status).toBe("paused");
    expect(ctx.fake.submitCalls).toBe(0);
    ctx.tracker.disposeAll();
    ctx.db.close();
  });
});
