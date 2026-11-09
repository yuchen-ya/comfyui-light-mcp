import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb } from "../../src/core/storage/db.js";
import { BatchStore } from "../../src/core/batch/store.js";
import { JobRunner } from "../../src/core/batch/runner.js";
import { JobTracker, historyVerdict } from "../../src/core/batch/tracker.js";
import { recoverInFlight } from "../../src/core/batch/recovery.js";
import { AssetManager } from "../../src/core/assets/asset-manager.js";
import { parseManifest } from "../../src/core/workflow/manifest.js";
import type { RegisteredWorkflow } from "../../src/core/workflow/registry.js";
import { makeFakeClient, historyEntry } from "../helpers/fake-client.js";
import { Engine } from "../../src/core/engine.js";
import { loadConfig } from "../../src/config.js";

/**
 * Task 004 §二 P2 遗留修复回归：
 * ① History 终态优先级（error 不得因部分 outputs 判 succeeded）
 * ② 超时取消组合（queue delete + interrupt）+ 竞态 + 远端结果记录
 * ③ AUTO_SAVE_OUTPUTS=false 时 get_result 按需下载
 * ④ manifest default 语义（mapper 层测试另有覆盖，此处验证端到端 resolved）
 */

let dataDir: string;
let outDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "fix-data-"));
  outDir = await mkdtemp(path.join(tmpdir(), "fix-out-"));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(outDir, { recursive: true, force: true });
});

const manifest = parseManifest(
  "t.manifest.json",
  JSON.stringify({
    name: "t",
    description: "d",
    version: 1,
    workflowFile: "t.json",
    params: [
      { name: "prompt", node: "4", input: "text", type: "string", required: true },
      { name: "seed", node: "7", input: "seed", type: "integer", default: -1, special: "seed" },
      { name: "steps", node: "7", input: "steps", type: "integer", min: 1, max: 100, default: 20 }
    ]
  })
);

function makeWf(): RegisteredWorkflow {
  return {
    manifest,
    graph: {
      "4": { class_type: "TextEncode", inputs: { text: "tpl" } },
      "7": { class_type: "KSampler", inputs: { seed: 42, steps: 20 } },
      "9": { class_type: "SaveImage", inputs: { images: ["8", 0] } }
    },
    sourceFile: "t.manifest.json",
    fingerprints: { manifestFingerprint: "fp-manifest-t", graphFingerprint: "fp-graph-t" }
  };
}

function setup(trackerOpts?: { autoSave?: boolean; timeoutMs?: number }) {
  const db = openDb(":memory:");
  const store = new BatchStore(db);
  const fc = makeFakeClient();
  const assets = new AssetManager(fc.client, outDir);
  const tracker = new JobTracker({
    client: fc.client,
    store,
    assets,
    autoSave: trackerOpts?.autoSave ?? true,
    defaultTimeoutMs: trackerOpts?.timeoutMs ?? 60_000
  });
  const runner = new JobRunner({ client: fc.client, store, tracker });
  return { db, store, fake: fc.state, bus: fc.bus, client: fc.client, assets, tracker, runner };
}

async function eventually(pred: () => boolean, ms = 4000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error("eventually 超时");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("① History 终态优先级", () => {
  it("historyVerdict：error + 部分 outputs → error（绝不因 outputs 判成功）", () => {
    const partialOutputs = { "9": { images: [{ filename: "half.png", subfolder: "", type: "output" }] } };
    expect(historyVerdict(historyEntry(partialOutputs, "error"))).toBe("error");
    expect(historyVerdict(historyEntry(partialOutputs, "interrupted"))).toBe("interrupted");
    expect(historyVerdict(historyEntry(partialOutputs, "success"))).toBe("success");
    expect(historyVerdict({ outputs: {} })).toBeNull(); // 无状态无输出 → 未定
    expect(historyVerdict({ outputs: partialOutputs })).toBeNull(); // 部分输出不能证明成功
  });

  it("tracker：execution_success 事件到达但 history 实为 error → failed（防御守卫）", async () => {
    const { store, fake, bus, runner, tracker } = setup();
    const handle = await runner.submitSingle(makeWf(), { prompt: "hi" });
    const job = store.getJob(handle.batchId, 0)!;
    fake.history.set(
      job.prompt_id!,
      historyEntry({ "9": { images: [{ filename: "partial.png", subfolder: "", type: "output" }] } }, "error")
    );
    bus.publish({ type: "execution_success", data: { prompt_id: job.prompt_id } });
    await eventually(() => store.getJob(handle.batchId, 0)!.status === "failed");
    const after = store.getJob(handle.batchId, 0)!;
    expect(after.outputs_json).toBeNull(); // 不收获输出
    expect((JSON.parse(after.error_json!) as { code: string }).code).toBe("EXECUTION_ERROR");
    tracker.disposeAll();
  });

  it("recovery：history error + 部分 outputs → failed，且不落任何文件", async () => {
    const { store, fake, client, tracker, runner } = setup();
    const handle = await runner.submitSingle(makeWf(), { prompt: "hi" });
    const job = store.getJob(handle.batchId, 0)!;
    fake.history.set(
      job.prompt_id!,
      historyEntry({ "9": { images: [{ filename: "partial.png", subfolder: "", type: "output" }] } }, "error")
    );
    const report = await recoverInFlight({ client, store, assets: new AssetManager(client, outDir), tracker, autoSave: true });
    expect(report.resolved).toBe(1);
    expect(store.getJob(handle.batchId, 0)!.status).toBe("failed"); // 不是 succeeded
    expect(await readdir(outDir)).toEqual([]); // 零文件落盘
  });
});

describe("② 超时取消组合", () => {
  it("超时 → queue delete + interrupt 双动作、未确认时保持 unknown、remote_cancel 记录", async () => {
    const { store, fake, runner, tracker } = setup({ timeoutMs: 80 });
    const handle = await runner.submitSingle(makeWf(), { prompt: "hi" });
    const job = store.getJob(handle.batchId, 0)!;
    fake.queuePromptIds.pending.push(job.prompt_id!); // 模拟仍在排队
    await eventually(() => store.getJob(handle.batchId, 0)!.status === "submission_unknown");
    expect(fake.deleteQueueCalls).toEqual([[job.prompt_id!]]); // queued → queue delete
    expect(fake.interruptCalls).toEqual([job.prompt_id!]); // executing → interrupt（组合防竞态）
    const err = JSON.parse(store.getJob(handle.batchId, 0)!.error_json!) as {
      code: string;
      remote_cancel: { queue_delete: string; interrupt: string };
    };
    expect(err.code).toBe("TIMEOUT_UNCONFIRMED");
    expect(err.remote_cancel).toEqual({ queue_delete: "ok", interrupt: "ok" }); // 远端取消结果落库
    tracker.disposeAll();
  });

  it("竞态：取消触发前 job 已成功 → 不取消、不覆盖终态", async () => {
    const { store, fake, runner, tracker } = setup({ timeoutMs: 100 });
    const handle = await runner.submitSingle(makeWf(), { prompt: "hi" });
    const job = store.getJob(handle.batchId, 0)!;
    fake.history.set(job.prompt_id!, historyEntry({ "9": { images: [{ filename: "ok.png", subfolder: "", type: "output" }] } }));
    fake.publishSuccess(job.prompt_id!); // 先于超时定终态
    await eventually(() => store.getJob(handle.batchId, 0)!.status === "succeeded");
    await new Promise((r) => setTimeout(r, 250)); // 越过超时时刻
    expect(store.getJob(handle.batchId, 0)!.status).toBe("succeeded"); // 先到者胜
    expect(fake.deleteQueueCalls).toEqual([]); // 未发任何取消
    expect(fake.interruptCalls).toEqual([]);
    tracker.disposeAll();
  });

  it("远端取消请求失败 → 保持 unknown，失败明细记入 remote_cancel", async () => {
    const { store, fake, runner, tracker } = setup({ timeoutMs: 60 });
    const handle = await runner.submitSingle(makeWf(), { prompt: "hi" });
    fake.deleteQueueImpl = async () => {
      throw new Error("conn refused");
    };
    fake.interruptImpl = async () => {
      throw new Error("conn refused");
    };
    await eventually(() => store.getJob(handle.batchId, 0)!.status === "submission_unknown");
    const err = JSON.parse(store.getJob(handle.batchId, 0)!.error_json!) as {
      remote_cancel: { queue_delete: string; interrupt: string };
    };
    expect(err.remote_cancel.queue_delete).toMatch(/^error: /);
    expect(err.remote_cancel.interrupt).toMatch(/^error: /);
    tracker.disposeAll();
  });
});

describe("③ AUTO_SAVE_OUTPUTS=false 按需下载", () => {
  function makeEngine(autoSave: boolean) {
    const config = loadConfig({
      COMFYUI_URL: "http://fake",
      WORKFLOWS_DIR: "./workflows",
      DATA_DIR: dataDir,
      OUTPUT_DIR: outDir,
      AUTO_SAVE_OUTPUTS: autoSave ? "true" : "false"
    });
    const db = openDb(":memory:");
    const fc = makeFakeClient();
    const engine = new Engine(config, fc.client, db);
    return { engine, fake: fc.state, db };
  }

  async function runAndSucceed(engine: Engine, fake: ReturnType<typeof makeFakeClient>["state"]): Promise<string> {
    const handle = await engine.runSingle({ workflow: "qwen-image-demo", params: { prompt: "x", steps: 4, seed: 5 } });
    // 注意：Engine 用真实注册表（workflows/），此处 batch 创建后由调度器提交
    const job = engine.store.getJob(handle.batch_id, 0)!;
    fake.history.set(job.prompt_id!, historyEntry({
      "9": { images: [{ filename: "ondemand_00001_.png", subfolder: "", type: "output" }] }
    }));
    fake.publishSuccess(job.prompt_id!);
    await eventually(() => engine.store.getJobById(job.id)!.status === "succeeded");
    return handle.batch_id;
  }

  it("autoSave=false：结算只存引用；get_result 默认按需下载并持久化（幂等）", async () => {
    const { engine, fake, db } = makeEngine(false);
    await engine.loadWorkflowsAsync();
    try {
      const batchId = await runAndSucceed(engine, fake);
      const job = engine.store.getJob(batchId, 0)!;
      const refs = JSON.parse(job.outputs_json!) as Array<{ local_path: string; bytes: number }>;
      expect(refs[0]!.local_path).toBe(""); // 未自动落盘
      expect(refs[0]!.bytes).toBe(0);
      const downloads0 = fake.downloadCalls;

      const view = await engine.getResult(batchId, 0); // download 默认 true
      const outs = view.outputs as Array<{ local_path: string; bytes: number; filename: string }>;
      expect(path.isAbsolute(outs[0]!.local_path)).toBe(true);
      expect(outs[0]!.bytes).toBeGreaterThan(0);
      expect(fake.downloadCalls).toBe(downloads0 + 1); // 恰好一次下载
      const st = await stat(outs[0]!.local_path);
      expect(st.size).toBe(outs[0]!.bytes); // 文件真实存在

      // 持久化 + 幂等：再次查询不再下载
      const view2 = await engine.getResult(batchId, 0);
      expect((view2.outputs as Array<{ local_path: string }>)[0]!.local_path).toBe(outs[0]!.local_path);
      expect(fake.downloadCalls).toBe(downloads0 + 1);
      const persisted = JSON.parse(engine.store.getJob(batchId, 0)!.outputs_json!) as Array<{ local_path: string }>;
      expect(persisted[0]!.local_path).toBeTruthy();
    } finally {
      await engine.stop();
      db.close();
    }
  });

  it("download=false：只读引用，不产生下载", async () => {
    const { engine, fake, db } = makeEngine(false);
    await engine.loadWorkflowsAsync();
    try {
      const batchId = await runAndSucceed(engine, fake);
      const downloads0 = fake.downloadCalls;
      const view = await engine.getResult(batchId, 0, { download: false });
      const outs = view.outputs as Array<{ local_path: string }>;
      expect(outs[0]!.local_path).toBe("");
      expect(fake.downloadCalls).toBe(downloads0);
    } finally {
      await engine.stop();
      db.close();
    }
  });

  it("autoSave=true：结算即落盘，get_result 无需下载", async () => {
    const { engine, fake, db } = makeEngine(true);
    await engine.loadWorkflowsAsync();
    try {
      const batchId = await runAndSucceed(engine, fake);
      const downloads0 = fake.downloadCalls;
      const view = await engine.getResult(batchId, 0);
      const outs = view.outputs as Array<{ local_path: string }>;
      expect(path.isAbsolute(outs[0]!.local_path)).toBe(true);
      expect(fake.downloadCalls).toBe(downloads0); // 结算时已下载（下载计数来自 submit 后 harvest）
    } finally {
      await engine.stop();
      db.close();
    }
  });
});

describe("④ default 语义端到端", () => {
  it("缺省调用 → resolved 记录 default 生效值（steps=20），batch 全流程可复现", async () => {
    const { store, runner, tracker } = setup();
    const handle = await runner.submitSingle(makeWf(), { prompt: "only-prompt" });
    const job = store.getJob(handle.batchId, 0)!;
    const resolved = JSON.parse(job.resolved_json!) as { steps: number; prompt: string; seed: number };
    expect(resolved.steps).toBe(20); // manifest default
    expect(resolved.prompt).toBe("only-prompt");
    expect(resolved.seed).toBeGreaterThanOrEqual(0); // seed default -1 → 随机并回写
    tracker.disposeAll();
  });
});
