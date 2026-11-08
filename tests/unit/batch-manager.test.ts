import { describe, expect, it, beforeEach } from "vitest";
import { openDb } from "../../src/core/storage/db.js";
import { BatchStore } from "../../src/core/batch/store.js";
import { BatchManager, MAX_RUNS_PER_BATCH } from "../../src/core/batch/manager.js";
import { parseManifest } from "../../src/core/workflow/manifest.js";
import type { RegisteredWorkflow } from "../../src/core/workflow/registry.js";
import { ComfyLightError } from "../../src/shared/errors.js";

/**
 * Task 004 §三 Batch Manager：批量创建、部分 invalid、幂等键、汇总统计、分页、状态过滤。
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
      { name: "seed", node: "7", input: "seed", type: "integer", default: -1, special: "seed" },
      { name: "steps", node: "7", input: "steps", type: "integer", min: 1, max: 100, default: 20 }
    ]
  })
);

const wf: RegisteredWorkflow = {
  manifest,
  graph: {
    "4": { class_type: "TextEncode", inputs: { text: "tpl" } },
    "7": { class_type: "KSampler", inputs: { seed: 42, steps: 20 } }
  },
  sourceFile: "t.manifest.json"
};

let store: BatchStore;
let manager: BatchManager;

beforeEach(() => {
  const db = openDb(":memory:");
  store = new BatchStore(db);
  manager = new BatchManager(store);
});

const okRun = (i: number) => ({ label: `item-${String(i).padStart(3, "0")}`, params: { prompt: `sphere ${i}`, seed: i } });

describe("批量创建", () => {
  it("100 个 job 单事务创建：全部 pending、attempt_no=0、无 attempt 行", () => {
    const res = manager.createBatch(wf, { runs: Array.from({ length: 100 }, (_, i) => okRun(i)) });
    expect(res.total).toBe(100);
    expect(res.invalid).toBe(0);
    expect(res.reused).toBe(false);
    expect(store.countJobs(res.batchId)).toBe(100);
    for (let i = 0; i < 100; i += 17) {
      const job = store.getJob(res.batchId, i)!;
      expect(job.status).toBe("pending");
      expect(job.attempt_no).toBe(0);
      expect(job.label).toBe(`item-${String(i).padStart(3, "0")}`);
    }
    const batch = store.getBatch(res.batchId)!;
    expect(batch.total).toBe(100);
    expect(batch.status).toBe("running");
    expect(JSON.parse(batch.options_json)).toEqual({ continue_on_error: true, max_attempts: 1 });
  });

  it("部分参数错误 → invalid 独立记录（含三段式 issues），合法任务照常 pending", () => {
    const res = manager.createBatch(wf, {
      runs: [
        okRun(0),
        { label: "bad-range", params: { prompt: "x", steps: 999 } },
        okRun(2),
        { label: "bad-unknown", params: { prompt: "x", hacker: 1 } },
        { params: { seed: 1 } } // 缺 required prompt
      ]
    });
    expect(res.total).toBe(5);
    expect(res.invalid).toBe(3);
    const bad1 = store.getJob(res.batchId, 1)!;
    expect(bad1.status).toBe("invalid");
    expect(bad1.finished_at).not.toBeNull();
    const err = JSON.parse(bad1.error_json!) as { code: string; issues: Array<{ param: string; message: string }> };
    expect(err.code).toBe("INVALID_PARAMS");
    expect(err.issues[0]!.message).toContain("须在 [1, 100] 区间");
    expect(err.issues[0]!.message).toContain("999");
    const bad4 = store.getJob(res.batchId, 4)!;
    expect((JSON.parse(bad4.error_json!) as { issues: Array<{ param: string }> }).issues[0]!.param).toBe("prompt");
    for (const i of [0, 2]) expect(store.getJob(res.batchId, i)!.status).toBe("pending");
  });

  it("runs 结构错误 → INVALID_RUNS（空数组 / 超上限）", () => {
    expect(() => manager.createBatch(wf, { runs: [] })).toThrow(ComfyLightError);
    expect(() =>
      manager.createBatch(wf, { runs: Array.from({ length: MAX_RUNS_PER_BATCH + 1 }, (_, i) => okRun(i)) })
    ).toThrow(/超过上限/);
  });

  it("max_attempts 边界收敛（1..5）并写入 options", () => {
    const res = manager.createBatch(wf, { runs: [okRun(0)], maxAttempts: 99 });
    expect(JSON.parse(store.getBatch(res.batchId)!.options_json)).toMatchObject({ max_attempts: 5 });
    const res2 = manager.createBatch(wf, { runs: [okRun(0)], maxAttempts: 0 });
    expect(JSON.parse(store.getBatch(res2.batchId)!.options_json)).toMatchObject({ max_attempts: 1 });
  });
});

describe("幂等键", () => {
  it("同一 idempotency_key 重复调用 → 同一 batch，不新建任何行", () => {
    const r1 = manager.createBatch(wf, { runs: [okRun(0), okRun(1)], idempotencyKey: "batch-request-001" });
    const r2 = manager.createBatch(wf, { runs: [okRun(0), okRun(1)], idempotencyKey: "batch-request-001" });
    expect(r2.batchId).toBe(r1.batchId);
    expect(r2.reused).toBe(true);
    expect(r2.total).toBe(2);
    expect(store.countJobs(r1.batchId)).toBe(2); // 未翻倍
    expect(manager.createBatch(wf, { runs: [okRun(9)], idempotencyKey: "batch-request-001" }).batchId).toBe(r1.batchId);
    // 不同键 → 新 batch
    const r3 = manager.createBatch(wf, { runs: [okRun(0)], idempotencyKey: "another-key" });
    expect(r3.batchId).not.toBe(r1.batchId);
  });
});

describe("getBatchView：统计 / 分页 / 过滤 / 有界", () => {
  function seedMixedStatuses(): string {
    const res = manager.createBatch(wf, { runs: Array.from({ length: 9 }, (_, i) => okRun(i)) });
    const b = res.batchId;
    store.patchJob(store.getJob(b, 0)!.id, { status: "succeeded" });
    store.patchJob(store.getJob(b, 1)!.id, { status: "succeeded" });
    store.patchJob(store.getJob(b, 2)!.id, { status: "failed", error_json: JSON.stringify({ code: "X", message: "m" }) });
    store.patchJob(store.getJob(b, 3)!.id, { status: "timeout" });
    store.patchJob(store.getJob(b, 4)!.id, { status: "submission_unknown" });
    store.patchJob(store.getJob(b, 5)!.id, { status: "invalid" });
    store.patchJob(store.getJob(b, 6)!.id, { status: "queued" });
    store.patchJob(store.getJob(b, 7)!.id, { status: "executing" });
    store.patchJob(store.getJob(b, 8)!.id, { status: "pending" });
    return b;
  }

  it("submission_unknown 单列呈现，绝不混入 failed；各状态计数准确", () => {
    const view = manager.getBatchView(seedMixedStatuses());
    expect(view.stats).toEqual({
      total: 9,
      succeeded: 2,
      failed: 2, // failed + timeout（cancelled 亦计入，本例无）
      running: 1, // executing
      queued: 1,
      pending: 1,
      invalid: 1,
      unknown: 1
    });
    expect(view.status).toBe("running");
  });

  it("分页：limit/offset/next_offset；尾页 next_offset=null", () => {
    const b = seedMixedStatuses();
    const p1 = manager.getBatchView(b, { limit: 4 });
    expect(p1.jobs.map((j) => j.index)).toEqual([0, 1, 2, 3]);
    expect(p1.next_offset).toBe(4);
    const p3 = manager.getBatchView(b, { limit: 4, offset: 8 });
    expect(p3.jobs.map((j) => j.index)).toEqual([8]);
    expect(p3.next_offset).toBeNull();
  });

  it("状态过滤：status=failed 只含失败项；unknown 别名 → submission_unknown；统计不受过滤影响", () => {
    const b = seedMixedStatuses();
    const failed = manager.getBatchView(b, { status: "failed" });
    expect(failed.jobs.map((j) => j.index)).toEqual([2]);
    const unknown = manager.getBatchView(b, { status: "unknown" });
    expect(unknown.jobs.map((j) => j.index)).toEqual([4]);
    expect(unknown.stats.unknown).toBe(1);
    expect(unknown.stats.total).toBe(9);
  });

  it("job 视图有界：错误消息 ≤200、不含 params/outputs 原文、含 attempt/prompt_id", () => {
    const res = manager.createBatch(wf, { runs: [{ params: { prompt: "x", steps: 999 } }] });
    const longMsg = "债".repeat(500);
    const job = store.getJob(res.batchId, 0)!;
    store.patchJob(job.id, { status: "failed", error_json: JSON.stringify({ code: "EXECUTION_ERROR", message: longMsg }) });
    const view = manager.getBatchView(res.batchId);
    const jv = view.jobs[0]!;
    expect(jv.error!.message.length).toBeLessThanOrEqual(200);
    expect(jv.error!.code).toBe("EXECUTION_ERROR");
    expect(JSON.stringify(view)).not.toContain("steps"); // 不泄漏完整参数
    expect(jv.attempt_no).toBe(0);
    expect(jv.outputs_count).toBe(0);
  });

  it("batch 收敛：全成功 completed / 部分成功 partial / 全失败 failed", () => {
    const all = manager.createBatch(wf, { runs: [okRun(0), okRun(1)] });
    for (const i of [0, 1]) store.patchJob(store.getJob(all.batchId, i)!.id, { status: "succeeded" });
    const { status } = store.recomputeBatchStatus(all.batchId);
    expect(status).toBe("completed");

    const part = manager.createBatch(wf, { runs: [okRun(0), okRun(1)] });
    store.patchJob(store.getJob(part.batchId, 0)!.id, { status: "succeeded" });
    store.patchJob(store.getJob(part.batchId, 1)!.id, { status: "failed", attempt_no: 1 });
    expect(store.recomputeBatchStatus(part.batchId).status).toBe("partial");

    const none = manager.createBatch(wf, { runs: [okRun(0)] });
    store.patchJob(store.getJob(none.batchId, 0)!.id, { status: "failed", attempt_no: 1 });
    expect(store.recomputeBatchStatus(none.batchId).status).toBe("failed");
  });

  it("重试未用尽的 failed 不收敛 batch（attempt_no < max_attempts 视为未决）", () => {
    const res = manager.createBatch(wf, { runs: [okRun(0), okRun(1)], maxAttempts: 3 });
    store.patchJob(store.getJob(res.batchId, 0)!.id, { status: "succeeded" });
    store.patchJob(store.getJob(res.batchId, 1)!.id, { status: "failed", attempt_no: 1 });
    expect(store.recomputeBatchStatus(res.batchId)).toEqual({ status: "running", finished: false });
    // 次数用尽 → 收敛 failed
    store.patchJob(store.getJob(res.batchId, 1)!.id, { attempt_no: 3 });
    expect(store.recomputeBatchStatus(res.batchId)).toEqual({ status: "partial", finished: true });
  });
});

describe("store 条件占位（防重复提交底层）", () => {
  it("claimForSubmit 仅对 pending 生效；占位后 job=submitting 且 attempt 行已建", () => {
    const res = manager.createBatch(wf, { runs: [okRun(0)] });
    const job = store.getJob(res.batchId, 0)!;
    const claim = store.claimForSubmit(job.id, "pid-1", "{}", new Date().toISOString());
    expect(claim).toEqual({ attemptNo: 1 });
    const after = store.getJobById(job.id)!;
    expect(after.status).toBe("submitting");
    expect(after.prompt_id).toBe("pid-1");
    expect(after.attempt_no).toBe(1);
    expect(store.getAttempts(job.id)).toHaveLength(1);
    // 已非 pending → 再占位失败
    expect(store.claimForSubmit(job.id, "pid-2", "{}", new Date().toISOString())).toBeNull();
  });
});
