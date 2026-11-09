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
import { ComfyLightError } from "../../src/shared/errors.js";

/**
 * P4.1 §三 恢复加固 8 项：
 * 1. ComfyUI 不可用时 MCP 启动（engine 语义：工具明确报错、不崩溃、恢复推迟）
 * 2. ComfyUI 后续恢复连接（ws open 后调度正常提交）
 * 3. 已有 queued Job 能重新挂接 Tracker
 * 4. 已有 executing Job 能通过 history 对账定终态
 * 5. pending Job 可以继续执行
 * 6. submission_unknown 仍然不会重提
 * 7. 工作流修改后不会执行旧 Batch 的剩余任务
 * 8. MCP 多次启动恢复不产生重复提交
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

function makeWf(graphFingerprint = "fp-graph-v1"): RegisteredWorkflow {
  return {
    manifest,
    graph: {
      "4": { class_type: "TextEncode", inputs: { text: "tpl" } },
      "7": { class_type: "KSampler", inputs: { seed: 42 } },
      "9": { class_type: "SaveImage", inputs: { images: ["8", 0] } }
    },
    sourceFile: "t.manifest.json",
    fingerprints: { manifestFingerprint: "fp-manifest-v1", graphFingerprint }
  };
}

const wf = makeWf();

function makeRegistry(current: RegisteredWorkflow): WorkflowRegistry & { current: RegisteredWorkflow } {
  const r = {
    current,
    get: (name: string) => (r.current.manifest.name === name ? r.current : undefined),
    list: () => []
  } as unknown as WorkflowRegistry & { current: RegisteredWorkflow };
  return r;
}

let outDir: string;

beforeEach(async () => {
  outDir = await mkdtemp(path.join(tmpdir(), "recov-out-"));
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
  registry: WorkflowRegistry & { current: RegisteredWorkflow };
  scheduler: Scheduler;
  wsState: { state: string };
}

function makeCtx(opts?: { wsState?: { state: string }; wf?: RegisteredWorkflow }): Ctx {
  const db = openDb(":memory:");
  const store = new BatchStore(db);
  const fc = makeFakeClient();
  const wsState = opts?.wsState ?? { state: "open" };
  // 可变 ws 状态（模拟 ComfyUI 不可达 → 恢复连接）
  (fc.client as unknown as { ws: { getStats: () => { state: string } } }).ws = {
    getStats: () => ({ state: wsState.state })
  };
  const assets = new AssetManager(fc.client, outDir);
  const tracker = new JobTracker({ client: fc.client, store, assets, autoSave: true, defaultTimeoutMs: 60_000 });
  const runner = new JobRunner({ client: fc.client, store, tracker });
  const manager = new BatchManager(store);
  const registry = makeRegistry(opts?.wf ?? wf);
  const scheduler = new Scheduler({ store, registry, runner, maxInFlight: 1, maxQueuedJobs: 1 });
  return { db, store, fake: fc.state, bus: fc.bus, client: fc.client, tracker, runner, manager, registry, scheduler, wsState };
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

/** 模拟崩溃重启：全部运行时对象重建，仅 SQLite 存活（复用同一 fake ComfyUI） */
function reboot(ctx: Ctx): Pick<Ctx, "tracker" | "runner" | "manager" | "scheduler"> {
  ctx.tracker.disposeAll();
  ctx.scheduler.stop();
  const tracker = new JobTracker({ client: ctx.client, store: ctx.store, assets: new AssetManager(ctx.client, outDir), autoSave: true, defaultTimeoutMs: 60_000 });
  const runner = new JobRunner({ client: ctx.client, store: ctx.store, tracker });
  const manager = new BatchManager(ctx.store);
  const scheduler = new Scheduler({ store: ctx.store, registry: ctx.registry, runner, maxInFlight: 1, maxQueuedJobs: 1 });
  return { tracker, runner, manager, scheduler };
}

describe("1+2 · ComfyUI 不可用时启动 / 后续恢复连接", () => {
  it("不可达时 run 工具明确报 COMFY_UNREACHABLE，恢复推迟不误伤状态", async () => {
    const ctx = makeCtx({ wsState: { state: "reconnecting" } });
    // 存量在途 job（上次会话遗留）在 ComfyUI 不可达时恢复：不崩溃、不伪装
    const res = ctx.manager.createBatch(wf, { runs: [run("a")] });
    await ctx.scheduler.tick();
    const job = ctx.store.getJob(res.batchId, 0)!;
    expect(job.status).toBe("queued");
    // ComfyUI "不可达"：history 无记录、队列为空 → 恢复对账保持 unknown
    // （不伪装 failed；下次启动 ComfyUI 恢复后再查证）
    const report = await recoverInFlight({
      client: ctx.client, store: ctx.store, assets: new AssetManager(ctx.client, outDir),
      tracker: ctx.tracker, autoSave: true, registry: ctx.registry
    });
    expect(report.keptUnknown).toBe(1);
    expect(ctx.store.getJobById(job.id)!.status).toBe("submission_unknown");
    // 连通性门禁语义（engine.assertConnected 同款判定）：工具层明确报错而非挂起
    expect(() => {
      if (ctx.client.ws.getStats().state !== "open") {
        throw new ComfyLightError("COMFY_UNREACHABLE", "ComfyUI WebSocket 未连接（服务可能未启动）");
      }
    }).toThrow(ComfyLightError);
    ctx.tracker.disposeAll();
    ctx.db.close();
  });

  it("ws 恢复 open 后：待执行请求正常提交、生成恢复（无人工干预）", async () => {
    const wsState = { state: "reconnecting" };
    const ctx = makeCtx({ wsState });
    const res = ctx.manager.createBatch(wf, { runs: [run("after-revival")] });
    // 模拟 engine.runSingle 的连通性门禁在不可达时拒绝
    expect(() => {
      if (ctx.client.ws.getStats().state !== "open") {
        throw new ComfyLightError("COMFY_UNREACHABLE", "ComfyUI WebSocket 未连接");
      }
    }).toThrow(ComfyLightError);
    // ComfyUI 恢复连接 → 调度照常提交
    wsState.state = "open";
    await ctx.scheduler.tick();
    const job = ctx.store.getJob(res.batchId, 0)!;
    expect(job.status).toBe("queued");
    await succeed(ctx.store, ctx.fake, job);
    expect(ctx.manager.getBatchView(res.batchId).status).toBe("completed");
    ctx.tracker.disposeAll();
    ctx.db.close();
  });
});

describe("3+4+5+6 · 重启恢复四路", () => {
  it("queued job 重启后重新挂接 Tracker（不重提，事件照常定终态）", async () => {
    const ctx = makeCtx();
    const res = ctx.manager.createBatch(wf, { runs: [run("a"), run("b")] });
    await ctx.scheduler.tick(); // a → queued
    const a = ctx.store.getJob(res.batchId, 0)!;
    ctx.fake.queuePromptIds.pending.push(a.prompt_id!); // 远端队列仍在
    const rt = reboot(ctx);
    const report = await recoverInFlight({
      client: ctx.client, store: ctx.store, assets: new AssetManager(ctx.client, outDir),
      tracker: rt.tracker, autoSave: true, registry: ctx.registry
    });
    expect(report.requeued).toBe(1);
    expect(ctx.store.getJobById(a.id)!.status).toBe("queued");
    expect(rt.tracker.isTracked(a.id)).toBe(true); // 已重新挂接
    const submitsBefore = ctx.fake.submitCalls;
    await rt.scheduler.tick(); // 不重提 a；b 受窗口约束等待
    expect(ctx.fake.submitCalls).toBe(submitsBefore);
    await succeed(ctx.store, ctx.fake, a); // 事件驱动定终态（重挂接生效）
    await rt.scheduler.tick(); // b 续跑
    await succeed(ctx.store, ctx.fake, ctx.store.getJob(res.batchId, 1)!);
    expect(rt.manager.getBatchView(res.batchId).status).toBe("completed");
    rt.tracker.disposeAll();
    ctx.db.close();
  });

  it("executing job 重启后经 history 对账定终态（成功 + 输出落盘）", async () => {
    const ctx = makeCtx();
    const res = ctx.manager.createBatch(wf, { runs: [run("exec-me")] });
    await ctx.scheduler.tick();
    const job = ctx.store.getJob(res.batchId, 0)!;
    ctx.store.patchJob(job.id, { status: "executing", started_at: new Date().toISOString() });
    // 崩溃期间执行完成（history 有成功记录，队列已清）
    ctx.fake.history.set(
      job.prompt_id!,
      historyEntry({ "9": { images: [{ filename: "recov.png", subfolder: "", type: "output" }] } })
    );
    const rt = reboot(ctx);
    const report = await recoverInFlight({
      client: ctx.client, store: ctx.store, assets: new AssetManager(ctx.client, outDir),
      tracker: rt.tracker, autoSave: true, registry: ctx.registry
    });
    expect(report.resolved).toBe(1);
    const after = ctx.store.getJobById(job.id)!;
    expect(after.status).toBe("succeeded");
    const outputs = JSON.parse(after.outputs_json!) as Array<{ filename: string; local_path: string }>;
    expect(outputs[0]!.filename).toBe("recov.png");
    expect(outputs[0]!.local_path).not.toBe(""); // 已落盘
    rt.tracker.disposeAll();
    ctx.db.close();
  });

  it("pending job 重启后由 Scheduler 继续执行（不丢任务）", async () => {
    const ctx = makeCtx();
    const res = ctx.manager.createBatch(wf, { runs: [run("p0"), run("p1")] });
    const rt = reboot(ctx); // 未提交即重启
    const report = await recoverInFlight({
      client: ctx.client, store: ctx.store, assets: new AssetManager(ctx.client, outDir),
      tracker: rt.tracker, autoSave: true, registry: ctx.registry
    });
    expect(report.resolved + report.requeued + report.keptUnknown + report.requeuedAsExecuting).toBe(0);
    await rt.scheduler.tick();
    const p0 = ctx.store.getJob(res.batchId, 0)!;
    expect(p0.status).toBe("queued");
    await succeed(ctx.store, ctx.fake, p0);
    await rt.scheduler.tick();
    await succeed(ctx.store, ctx.fake, ctx.store.getJob(res.batchId, 1)!);
    expect(rt.manager.getBatchView(res.batchId).status).toBe("completed");
    rt.tracker.disposeAll();
    ctx.db.close();
  });

  it("submission_unknown 重启后仍不重提（history/queue 均无 → 保持 unknown）", async () => {
    const ctx = makeCtx();
    ctx.fake.submitImpl = async () => {
      throw new Error("fetch failed");
    };
    const res = ctx.manager.createBatch(wf, { runs: [run("u")] });
    await ctx.scheduler.tick();
    const job = ctx.store.getJob(res.batchId, 0)!;
    expect(job.status).toBe("submission_unknown");
    const rt = reboot(ctx);
    for (let i = 0; i < 3; i++) {
      const report = await recoverInFlight({
        client: ctx.client, store: ctx.store, assets: new AssetManager(ctx.client, outDir),
        tracker: rt.tracker, autoSave: true, registry: ctx.registry
      });
      expect(report.keptUnknown).toBe(1);
    }
    expect(ctx.store.getJobById(job.id)!.status).toBe("submission_unknown");
    expect(ctx.fake.submitCalls).toBe(1); // 从未重提
    expect(ctx.store.getAttempts(job.id)).toHaveLength(1);
    rt.tracker.disposeAll();
    ctx.db.close();
  });
});

describe("7 · 工作流修改后不执行旧 Batch 剩余任务", () => {
  it("重启时发现漂移 → pending 暂停 + 调度不提交（其他 batch 不受影响）", async () => {
    const ctx = makeCtx();
    const res = ctx.manager.createBatch(wf, { runs: [run("a"), run("b"), run("c")] });
    await ctx.scheduler.tick(); // a 提交
    const a = ctx.store.getJob(res.batchId, 0)!;
    ctx.fake.queuePromptIds.pending.push(a.prompt_id!);
    // 停机期间工作流被修改
    ctx.registry.current = makeWf("fp-graph-CHANGED");
    const other = ctx.manager.createBatch(ctx.registry.current, { runs: [run("other-0")] });
    const rt = reboot(ctx);
    const report = await recoverInFlight({
      client: ctx.client, store: ctx.store, assets: new AssetManager(ctx.client, outDir),
      tracker: rt.tracker, autoSave: true, registry: ctx.registry
    });
    expect(report.requeued).toBe(1); // a 照常重挂接（旧图已提交，与漂移无关）
    expect(report.pausedOnVersionMismatch).toBe(2); // b、c 暂停
    await rt.scheduler.tick();
    expect(ctx.store.getJob(res.batchId, 1)!.status).toBe("paused");
    expect(ctx.store.getJob(res.batchId, 2)!.status).toBe("paused");
    // a（重挂接的在途）完成释放窗口后，其他 batch（用新工作流创建）不受影响照常提交
    await succeed(ctx.store, ctx.fake, ctx.store.getJob(res.batchId, 0)!);
    await rt.scheduler.tick();
    expect(ctx.store.getJob(other.batchId, 0)!.status).toBe("queued");
    await succeed(ctx.store, ctx.fake, ctx.store.getJob(other.batchId, 0)!);
    rt.tracker.disposeAll();
    ctx.db.close();
  });
});

describe("8 · 多次启动恢复不产生重复提交", () => {
  it("连续两次重启恢复：重挂接幂等、无重复 attempt、无重复远端提交", async () => {
    const ctx = makeCtx();
    const res = ctx.manager.createBatch(wf, { runs: [run("a"), run("b")] });
    await ctx.scheduler.tick(); // a → queued
    const a = ctx.store.getJob(res.batchId, 0)!;
    ctx.fake.queuePromptIds.pending.push(a.prompt_id!);

    // 第一次重启恢复
    const rt1 = reboot(ctx);
    const r1 = await recoverInFlight({
      client: ctx.client, store: ctx.store, assets: new AssetManager(ctx.client, outDir),
      tracker: rt1.tracker, autoSave: true, registry: ctx.registry
    });
    expect(r1.requeued).toBe(1);
    // 第二次重启恢复（tracker 再次重建；job 仍 queued 且在远端队列）
    const rt2 = reboot({
      ...ctx,
      tracker: rt1.tracker,
      scheduler: rt1.scheduler
    } as Ctx);
    const r2 = await recoverInFlight({
      client: ctx.client, store: ctx.store, assets: new AssetManager(ctx.client, outDir),
      tracker: rt2.tracker, autoSave: true, registry: ctx.registry
    });
    expect(r2.requeued).toBe(1); // 仍识别为队列在途
    expect(ctx.fake.submitCalls).toBe(1); // 从未重复提交
    expect(ctx.store.getAttempts(a.id)).toHaveLength(1); // 无重复 attempt 行
    // 第二次恢复后 tracker 仍能定终态并续跑 b
    await succeed(ctx.store, ctx.fake, ctx.store.getJob(res.batchId, 0)!);
    await rt2.scheduler.tick();
    await succeed(ctx.store, ctx.fake, ctx.store.getJob(res.batchId, 1)!);
    expect(rt2.manager.getBatchView(res.batchId).status).toBe("completed");
    rt2.tracker.disposeAll();
    ctx.db.close();
  });

  it("恢复中途已定终态的 job：二次恢复是 no-op（不重复收获输出）", async () => {
    const ctx = makeCtx();
    const res = ctx.manager.createBatch(wf, { runs: [run("a")] });
    await ctx.scheduler.tick();
    const a = ctx.store.getJob(res.batchId, 0)!;
    ctx.store.patchJob(a.id, { status: "executing", started_at: new Date().toISOString() });
    ctx.fake.history.set(
      a.prompt_id!,
      historyEntry({ "9": { images: [{ filename: "once.png", subfolder: "", type: "output" }] } })
    );
    const rt = reboot(ctx);
    const deps = {
      client: ctx.client, store: ctx.store, assets: new AssetManager(ctx.client, outDir),
      tracker: rt.tracker, autoSave: true, registry: ctx.registry
    };
    const r1 = await recoverInFlight(deps);
    expect(r1.resolved).toBe(1);
    const r2 = await recoverInFlight(deps); // 已终态 → 不在 in-flight 扫描集
    expect(r2.resolved + r2.requeued + r2.keptUnknown).toBe(0);
    expect(ctx.store.getJobById(a.id)!.status).toBe("succeeded");
    expect(ctx.fake.downloadCalls).toBe(1); // 输出只收获/下载一次
    rt.tracker.disposeAll();
    ctx.db.close();
  });
});
