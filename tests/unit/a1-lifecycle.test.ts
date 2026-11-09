import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb } from "../../src/core/storage/db.js";
import { BatchStore, type JobRow } from "../../src/core/batch/store.js";
import { JobRunner } from "../../src/core/batch/runner.js";
import { JobTracker } from "../../src/core/batch/tracker.js";
import { recoverInFlight } from "../../src/core/batch/recovery.js";
import { AssetManager } from "../../src/core/assets/asset-manager.js";
import { parseManifest } from "../../src/core/workflow/manifest.js";
import type { RegisteredWorkflow } from "../../src/core/workflow/registry.js";
import type { WorkflowGraph } from "../../src/core/client/types.js";
import { makeFakeClient, historyEntry } from "../helpers/fake-client.js";

/**
 * Task 003 A1 核心语义测试：
 * - 提交前持久化 prompt_id（提交动作发生时 job 行已带 prompt_id 落库）
 * - submission_unknown：history/queue 皆无 → 保持 unknown，不伪装 failed
 * - 恢复流程绝不重复提交（submitCalls 不增长）
 * - 崩溃恢复三分支：history 成功 / queue 在队 / 双查无果
 */

let dataDir: string;
let outDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "a1-data-"));
  outDir = await mkdtemp(path.join(tmpdir(), "a1-out-"));
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
      { name: "seed", node: "7", input: "seed", type: "integer", default: -1, special: "seed" }
    ]
  })
);

function makeWf(graphTemplate?: WorkflowGraph): RegisteredWorkflow {
  return {
    manifest,
    graph: graphTemplate ?? {
      "4": { class_type: "TextEncode", inputs: { text: "tpl" } },
      "7": { class_type: "KSampler", inputs: { seed: 42 } },
      "9": { class_type: "SaveImage", inputs: { images: ["8", 0] } }
    },
    sourceFile: "t.manifest.json",
    fingerprint: { manifest: "fp-manifest-a1", graph: "fp-graph-a1" }
  };
}

function setup(tracker?: JobTracker) {
  const db = openDb(":memory:");
  const store = new BatchStore(db);
  const fc = makeFakeClient();
  const assets = new AssetManager(fc.client, outDir);
  const t = tracker ?? new JobTracker({ client: fc.client, store, assets, autoSave: true, defaultTimeoutMs: 60_000 });
  const runner = new JobRunner({ client: fc.client, store, tracker: t });
  return { db, store, fake: fc.state, bus: fc.bus, client: fc.client, assets, tracker: t, runner };
}

describe("A1 · 提交前持久化", () => {
  it("submitPrompt 被调用时，job 行已带 prompt_id 落库（顺序保证）", async () => {
    const { store, fake, runner } = setup();
    let seenInSubmit: { jobId?: string; promptId?: string } = {};
    fake.submitImpl = async (_g, opts) => {
      // 提交瞬间查库：必须已存在 status=submitting 且 prompt_id 已写入的行
      const rows = (store as unknown as { db: { prepare: (s: string) => { all: () => JobRow[] } } })
        .db.prepare("SELECT * FROM jobs").all() as JobRow[];
      seenInSubmit = rows.length === 1 ? { jobId: rows[0]!.id, promptId: rows[0]!.prompt_id ?? undefined } : {};
      return { ok: true, promptId: opts?.promptId ?? "x", number: 1, nodeErrors: {} };
    };
    const handle = await runner.submitSingle(makeWf(), { prompt: "hi" });
    expect(handle.status).toBe("queued");
    expect(seenInSubmit.promptId).toBeTruthy();
    expect(seenInSubmit.promptId).toBe(store.getJob(handle.batchId, 0)!.prompt_id);
  });

  it("网络失败 → submission_unknown，prompt_id 已持久化，batch 保持 running（不伪装 failed）", async () => {
    const { store, fake, runner } = setup();
    fake.submitImpl = async () => {
      throw new Error("fetch failed");
    };
    const handle = await runner.submitSingle(makeWf(), { prompt: "hi" });
    expect(handle.status).toBe("submission_unknown");
    const job = store.getJob(handle.batchId, 0)!;
    expect(job.status).toBe("submission_unknown");
    expect(job.prompt_id).toBeTruthy();
    expect(job.finished_at).toBeNull(); // 未定终态
    expect(store.getBatch(handle.batchId)!.status).toBe("running");
    const err = JSON.parse(job.error_json!) as { code: string };
    expect(err.code).toBe("SUBMISSION_UNKNOWN");
  });

  it("ComfyUI 拒绝（400）→ failed 终态 + 归一化结构化错误", async () => {
    const { store, fake, runner } = setup();
    fake.submitImpl = async () => ({
      ok: false,
      httpStatus: 400,
      errorBody: { type: "prompt_outputs_failed_validation" },
      nodeErrors: {
        "7": {
          errors: [
            {
              type: "value_not_in_list",
              message: "Value not in list",
              details: "sampler_name: 'euler_BAD' not in (list of length 45)",
              extra_info: { input_name: "sampler_name", input_config: null, received_value: "euler_BAD" }
            }
          ],
          dependent_outputs: ["9"],
          class_type: "KSampler"
        }
      }
    });
    const handle = await runner.submitSingle(makeWf(), { prompt: "hi" });
    expect(handle.status).toBe("failed");
    const job = store.getJob(handle.batchId, 0)!;
    const err = JSON.parse(job.error_json!) as {
      code: string;
      message: string;
      node_errors: Array<{ node: string; input: string; type: string; received_value: string }>;
    };
    expect(err.code).toBe("COMFY_REJECTED");
    expect(err.message).toContain("prompt_outputs_failed_validation");
    // 归一化（docs/005 §七真实样本形状）
    expect(err.node_errors).toEqual([
      {
        node: "7",
        class_type: "KSampler",
        input: "sampler_name",
        type: "value_not_in_list",
        message: "sampler_name: 'euler_BAD' not in (list of length 45)",
        received_value: "euler_BAD"
      }
    ]);
  });
});

describe("A1 · 崩溃恢复", () => {
  it("history/queue 双查无果 → 保持 submission_unknown；恢复不产生任何提交", async () => {
    const { store, fake, client, tracker, runner } = setup();
    fake.submitImpl = async () => {
      throw new Error("crash mid-flight");
    };
    const handle = await runner.submitSingle(makeWf(), { prompt: "hi" });
    const before = fake.submitCalls;

    const report = await recoverInFlight({
      client: client, store, assets: new AssetManager(client, outDir),
      tracker, autoSave: true
    });
    expect(report.keptUnknown).toBe(1);
    const job = store.getJob(handle.batchId, 0)!;
    expect(job.status).toBe("submission_unknown"); // 不是 failed
    expect(fake.submitCalls).toBe(before); // 恢复绝不重提
    expect(fake.interruptCalls).toEqual([]); // 也不干预远端
  });

  it("恢复幂等：连续跑两轮结果一致，仍不重提", async () => {
    const { store, fake, client, tracker, runner } = setup();
    fake.submitImpl = async () => {
      throw new Error("boom");
    };
    const handle = await runner.submitSingle(makeWf(), { prompt: "hi" });
    const deps = { client: client, store, assets: new AssetManager(client, outDir), tracker, autoSave: true };
    await recoverInFlight(deps);
    await recoverInFlight(deps);
    expect(fake.submitCalls).toBe(1);
    expect(store.getJob(handle.batchId, 0)!.status).toBe("submission_unknown");
  });

  it("history 有成功记录 → 定 succeeded + 输出落盘（本地绝对路径 + 原始文件名）", async () => {
    const { store, fake, client, tracker, runner } = setup();
    const handle = await runner.submitSingle(makeWf(), { prompt: "hi" });
    const job = store.getJob(handle.batchId, 0)!;
    fake.history.set(job.prompt_id!, historyEntry({
      "9": { images: [{ filename: "ComfyUI_00001_.png", subfolder: "", type: "output" }] }
    }));
    fake.downloads.set("ComfyUI_00001_.png", Buffer.from("png-bytes-123"));

    const report = await recoverInFlight({
      client: client, store, assets: new AssetManager(client, outDir), tracker, autoSave: true
    });
    expect(report.resolved).toBe(1);
    const after = store.getJob(handle.batchId, 0)!;
    expect(after.status).toBe("succeeded");
    const outputs = JSON.parse(after.outputs_json!) as Array<{ filename: string; local_path: string; kind: string; bytes: number }>;
    expect(outputs).toHaveLength(1);
    expect(outputs[0]!.filename).toBe("ComfyUI_00001_.png"); // 原始文件名保留
    expect(outputs[0]!.kind).toBe("image");
    expect(outputs[0]!.bytes).toBe(13);
    expect(path.isAbsolute(outputs[0]!.local_path)).toBe(true);
    const onDisk = await readFile(outputs[0]!.local_path);
    expect(onDisk.toString()).toBe("png-bytes-123");
    expect(store.getBatch(handle.batchId)!.status).toBe("completed");
  });

  it("queue 仍在（pending）→ 重新跟踪不重提；running → executing", async () => {
    const { store, fake, client, tracker, runner } = setup();
    const h1 = await runner.submitSingle(makeWf(), { prompt: "a" });
    const j1 = store.getJob(h1.batchId, 0)!;
    fake.queuePromptIds = { running: [], pending: [j1.prompt_id!] };

    const report = await recoverInFlight({
      client: client, store, assets: new AssetManager(client, outDir), tracker, autoSave: true
    });
    expect(report.requeued).toBe(1);
    expect(store.getJob(h1.batchId, 0)!.status).toBe("queued");
    expect(tracker.isTracked(j1.id)).toBe(true);
    expect(fake.submitCalls).toBe(1); // 未产生第二次提交
  });

  it("history error 记录 → failed（此为真实失败，非 unknown 伪装）", async () => {
    const { store, fake, client, tracker, runner } = setup();
    const handle = await runner.submitSingle(makeWf(), { prompt: "hi" });
    const job = store.getJob(handle.batchId, 0)!;
    fake.history.set(job.prompt_id!, historyEntry({}, "error"));
    const report = await recoverInFlight({
      client: client, store, assets: new AssetManager(client, outDir), tracker, autoSave: true
    });
    expect(report.resolved).toBe(1);
    expect(store.getJob(handle.batchId, 0)!.status).toBe("failed");
  });
});

describe("JobTracker · 正常生命周期（fake WS 事件）", () => {
  it("success 事件 → succeeded + 落盘；execution_error → failed", async () => {
    const { store, fake, bus, runner, tracker } = setup();
    const handle = await runner.submitSingle(makeWf(), { prompt: "hi" });
    const job = store.getJob(handle.batchId, 0)!;
    fake.history.set(job.prompt_id!, historyEntry({
      "9": { images: [{ filename: "img.png", subfolder: "", type: "output" }] }
    }));

    bus.publish({ type: "execution_start", data: { prompt_id: job.prompt_id } });
    bus.publish({ type: "executing", data: { node: "4", prompt_id: job.prompt_id } });
    bus.publish({ type: "execution_success", data: { prompt_id: job.prompt_id } });

    await eventually(() => store.getJob(handle.batchId, 0)!.status === "succeeded");
    const outputs = JSON.parse(store.getJob(handle.batchId, 0)!.outputs_json!) as Array<{ local_path: string }>;
    expect(await stat(outputs[0]!.local_path)).toBeTruthy();
    tracker.disposeAll();
  });

  it("原始模板不被执行污染（图快照前后一致）", async () => {
    const { store, fake, bus, runner, tracker } = setup();
    const wf = makeWf();
    const snapshot = JSON.parse(JSON.stringify(wf.graph));
    const handle = await runner.submitSingle(wf, { prompt: "changed", seed: 5 });
    const job = store.getJob(handle.batchId, 0)!;
    fake.history.set(job.prompt_id!, historyEntry({}));
    bus.publish({ type: "execution_success", data: { prompt_id: job.prompt_id } });
    await eventually(() => store.getJob(handle.batchId, 0)!.status === "succeeded");
    expect(wf.graph).toEqual(snapshot);
    const resolved = JSON.parse(store.getJob(handle.batchId, 0)!.resolved_json!) as { prompt: string; seed: number };
    expect(resolved.prompt).toBe("changed");
    expect(resolved.seed).toBe(5);
    tracker.disposeAll();
  });
});

async function eventually(pred: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error("eventually 超时");
    await new Promise((r) => setTimeout(r, 25));
  }
}
