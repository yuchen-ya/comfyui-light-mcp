import { describe, expect, it, beforeEach } from "vitest";
import { openDb } from "../../src/core/storage/db.js";
import { BatchStore } from "../../src/core/batch/store.js";
import { BatchManager, computeRequestFingerprint } from "../../src/core/batch/manager.js";
import { parseManifest } from "../../src/core/workflow/manifest.js";
import type { RegisteredWorkflow } from "../../src/core/workflow/registry.js";
import { ComfyLightError } from "../../src/shared/errors.js";
import { contentFingerprint, stableStringify } from "../../src/shared/fingerprint.js";

/**
 * P4.1 §二.4 Idempotency Fingerprint：
 * - fingerprint 覆盖 workflow/version/内容指纹/runs 顺序/continue_on_error/max_attempts
 * - JSON 对象键序不影响 fingerprint；runs 顺序影响
 * - 同键同内容 → 返回既有 batch；同键不同内容 → IDEMPOTENCY_CONFLICT
 * - 并发 UNIQUE 竞争路径同样比对指纹
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

function makeWf(fingerprints = { manifestFingerprint: "fp-m", graphFingerprint: "fp-g" }): RegisteredWorkflow {
  return {
    manifest,
    graph: {
      "4": { class_type: "TextEncode", inputs: { text: "tpl" } },
      "7": { class_type: "KSampler", inputs: { seed: 42 } }
    },
    sourceFile: "t.manifest.json",
    fingerprints
  };
}

const wf = makeWf();

let store: BatchStore;
let manager: BatchManager;

beforeEach(() => {
  const db = openDb(":memory:");
  store = new BatchStore(db);
  manager = new BatchManager(store);
});

const run = (text: string, seed = 1) => ({ params: { prompt: text, seed } });

describe("stableStringify / contentFingerprint 基础性质", () => {
  it("对象键顺序不影响 fingerprint；数组顺序保留", () => {
    const a = { x: 1, y: { b: 2, a: [3, 4] } };
    const b = { y: { a: [3, 4], b: 2 }, x: 1 };
    expect(stableStringify(a)).toBe(stableStringify(b));
    expect(contentFingerprint(a)).toBe(contentFingerprint(b));
    expect(contentFingerprint([1, 2])).not.toBe(contentFingerprint([2, 1])); // 数组有序
  });
  it("undefined 值跳过（与 JSON.stringify 一致）", () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe(stableStringify({ a: 1 }));
  });
});

describe("computeRequestFingerprint 覆盖面", () => {
  it("runs 顺序不同 → 指纹不同（顺序即语义）", () => {
    const f1 = computeRequestFingerprint(wf, { runs: [run("a"), run("b")] });
    const f2 = computeRequestFingerprint(wf, { runs: [run("b"), run("a")] });
    expect(f1).not.toBe(f2);
  });
  it("continue_on_error / max_attempts 参与指纹", () => {
    const base = computeRequestFingerprint(wf, { runs: [run("a")] });
    expect(computeRequestFingerprint(wf, { runs: [run("a")], continueOnError: false })).not.toBe(base);
    expect(computeRequestFingerprint(wf, { runs: [run("a")], maxAttempts: 2 })).not.toBe(base);
  });
  it("workflow 内容指纹参与（同 name 不同内容 → 不同指纹）", () => {
    const wf2 = makeWf({ manifestFingerprint: "fp-m2", graphFingerprint: "fp-g" });
    expect(computeRequestFingerprint(wf2, { runs: [run("a")] })).not.toBe(computeRequestFingerprint(wf, { runs: [run("a")] }));
  });
  it("max_attempts 归一化：99 与 5 等价（钳制到 5）", () => {
    const f1 = computeRequestFingerprint(wf, { runs: [run("a")], maxAttempts: 99 });
    const f2 = computeRequestFingerprint(wf, { runs: [run("a")], maxAttempts: 5 });
    expect(f1).toBe(f2);
  });
  it("参数键序不同、内容相同 → 指纹一致", () => {
    const f1 = computeRequestFingerprint(wf, { runs: [{ params: { prompt: "x", seed: 1 } }] });
    const f2 = computeRequestFingerprint(wf, { runs: [{ params: { seed: 1, prompt: "x" } }] });
    expect(f1).toBe(f2);
  });
});

/** 断言 fn 抛 IDEMPOTENCY_CONFLICT（toThrow 匹配的是 message，code 须单独断言） */
function expectConflict(fn: () => unknown): void {
  try {
    fn();
    expect.unreachable("应抛 IDEMPOTENCY_CONFLICT");
  } catch (e) {
    expect(e).toBeInstanceOf(ComfyLightError);
    expect((e as ComfyLightError).code).toBe("IDEMPOTENCY_CONFLICT");
  }
}

describe("同键同内容 / 同键不同内容", () => {
  it("同键同内容（键序不同）→ 返回既有 batch，无新行", () => {
    const r1 = manager.createBatch(wf, { runs: [run("a"), run("b")], idempotencyKey: "k1" });
    const r2 = manager.createBatch(wf, {
      runs: [{ params: { seed: 1, prompt: "a" } }, { params: { seed: 1, prompt: "b" } }],
      idempotencyKey: "k1"
    });
    expect(r2.reused).toBe(true);
    expect(r2.batchId).toBe(r1.batchId);
    expect(store.countJobs(r1.batchId)).toBe(2);
  });

  it("同键不同内容（runs 不同）→ IDEMPOTENCY_CONFLICT，既有 batch 不受影响", () => {
    const r1 = manager.createBatch(wf, { runs: [run("a")], idempotencyKey: "k2" });
    expectConflict(() => manager.createBatch(wf, { runs: [run("a"), run("b")], idempotencyKey: "k2" }));
    try {
      manager.createBatch(wf, { runs: [run("different")], idempotencyKey: "k2" });
      expect.unreachable("应抛 IDEMPOTENCY_CONFLICT");
    } catch (e) {
      expect(e).toBeInstanceOf(ComfyLightError);
      expect((e as ComfyLightError).message).toContain("idempotency_key");
    }
    // 既有 batch 完好
    expect(store.countJobs(r1.batchId)).toBe(1);
    expect(store.getBatch(r1.batchId)!.status).toBe("running");
  });

  it("同键不同 continue_on_error → IDEMPOTENCY_CONFLICT", () => {
    manager.createBatch(wf, { runs: [run("a")], idempotencyKey: "k3", continueOnError: true });
    expectConflict(() => manager.createBatch(wf, { runs: [run("a")], idempotencyKey: "k3", continueOnError: false }));
  });

  it("同键不同 max_attempts → IDEMPOTENCY_CONFLICT", () => {
    manager.createBatch(wf, { runs: [run("a")], idempotencyKey: "k4", maxAttempts: 1 });
    expectConflict(() => manager.createBatch(wf, { runs: [run("a")], idempotencyKey: "k4", maxAttempts: 3 }));
  });

  it("v3 前旧行（request_fingerprint=NULL）同键 → 尽力兼容按命中处理", () => {
    const r1 = manager.createBatch(wf, { runs: [run("a")], idempotencyKey: "legacy" });
    // 模拟旧行：直接抹掉请求指纹（v2 库迁移场景）
    (store as unknown as { db: { prepare: (s: string) => { run: (id: string) => unknown } } })
      .db.prepare("UPDATE batches SET request_fingerprint = NULL WHERE id = ?").run(r1.batchId);
    const r2 = manager.createBatch(wf, { runs: [run("totally-different")], idempotencyKey: "legacy" });
    expect(r2.reused).toBe(true);
    expect(r2.batchId).toBe(r1.batchId);
  });
});

describe("并发 UNIQUE 竞争", () => {
  it("占位后另一路径插入同键 → UNIQUE 竞争回查：同指纹命中 / 异指纹冲突", () => {
    // 场景 A：同内容 → 命中返回既有
    const r1 = manager.createBatch(wf, { runs: [run("race")], idempotencyKey: "race-key" });
    // 模拟竞争窗口：early check 时看不到（返回 undefined），插入时撞 UNIQUE，回查时才可见
    const realGet = store.getBatchByIdempotencyKey.bind(store);
    let calls = 0;
    store.getBatchByIdempotencyKey = (key: string) => {
      calls++;
      return calls === 1 ? undefined : realGet(key); // 首查（early check）不可见，回查可见
    };
    const r2 = manager.createBatch(wf, { runs: [{ params: { seed: 1, prompt: "race" } }], idempotencyKey: "race-key" });
    expect(r2.reused).toBe(true);
    expect(r2.batchId).toBe(r1.batchId);
    store.getBatchByIdempotencyKey = realGet;

    // 场景 B：不同内容 → 竞争回查后仍冲突
    const realGet2 = store.getBatchByIdempotencyKey.bind(store);
    let calls2 = 0;
    store.getBatchByIdempotencyKey = (key: string) => {
      calls2++;
      return calls2 === 1 ? undefined : realGet2(key);
    };
    expectConflict(() => manager.createBatch(wf, { runs: [run("other-content")], idempotencyKey: "race-key" }));
    store.getBatchByIdempotencyKey = realGet2;
  });
});
