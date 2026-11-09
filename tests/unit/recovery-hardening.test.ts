import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../../src/config.js";
import { openDb } from "../../src/core/storage/db.js";
import type Database from "better-sqlite3";
import { makeFakeClient, historyEntry, type FakeHttpState } from "../helpers/fake-client.js";
import type { ComfyEventBus } from "../../src/core/client/event-bus.js";
import { Engine } from "../../src/core/engine.js";
import type { BatchStore } from "../../src/core/batch/store.js";

/**
 * Task 005 §三 恢复测试（8 项）：
 * 1. ComfyUI 不可用时 MCP 启动（pending 不被误判 submission_unknown）
 * 2. 恢复连接后 pending 自动续跑
 * 3. 已有 queued Job 重新挂接 Tracker
 * 4. 已有 executing Job 经 history 对账定终态
 * 5. pending Job 继续执行
 * 6. submission_unknown 仍然不会重提
 * 7. 工作流修改后不执行旧 Batch 的剩余任务（版本指纹保护）
 * 8. MCP 多次启动恢复不产生重复提交
 */

const MANIFEST = {
  name: "t",
  description: "d",
  version: 1,
  workflowFile: "t.json",
  params: [
    { name: "prompt", node: "4", input: "text", type: "string", required: true },
    { name: "seed", node: "7", input: "seed", type: "integer", default: -1, special: "seed" }
  ]
};
const GRAPH = {
  "4": { class_type: "TextEncode", inputs: { text: "tpl" } },
  "7": { class_type: "KSampler", inputs: { seed: 42 } },
  "9": { class_type: "SaveImage", inputs: { images: ["8", 0] } }
};

let root: string;
let wfDir: string;
let dataDir: string;
let outDir: string;
let dbFile: string;
let fc: ReturnType<typeof makeFakeClient>;
let dbCounter = 0;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "rec-"));
  wfDir = path.join(root, "wf");
  dataDir = path.join(root, "data");
  outDir = path.join(root, "out");
  await mkdir(wfDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(wfDir, "t.manifest.json"), JSON.stringify(MANIFEST));
  await writeFile(path.join(wfDir, "t.json"), JSON.stringify(GRAPH));
  dbFile = path.join(dataDir, `rec-${++dbCounter}.db`);
  fc = makeFakeClient();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

interface Ctx {
  engine: Engine;
  db: Database.Database;
  fake: FakeHttpState;
  bus: ComfyEventBus;
}

/** 每次调用开同一 db 文件的新连接（fake client/bus 跨"重启"共享，模拟 ComfyUI 侧不变） */
async function makeEngine(): Promise<Ctx> {
  const config = loadConfig({
    COMFYUI_URL: "http://fake",
    WORKFLOWS_DIR: wfDir,
    DATA_DIR: dataDir,
    OUTPUT_DIR: outDir,
    MAX_IN_FLIGHT: "1",
    MAX_QUEUED_JOBS: "1"
  });
  const db = openDb(dbFile);
  const engine = new Engine(config, fc.client, db);
  const report = await engine.loadWorkflowsAsync();
  expect(report.errors).toEqual([]);
  return { engine, db, fake: fc.state, bus: fc.bus };
}

async function tick(e: Engine): Promise<void> {
  await e.scheduler.tick();
}

/** 推送成功事件并等待 store 中该 job 定终态 succeeded */
async function succeed(store: BatchStore, fake: FakeHttpState, promptId: string, jobId: string): Promise<void> {
  fake.history.set(promptId, historyEntry({ "9": { images: [{ filename: "img.png", subfolder: "", type: "output" }] } }));
  fake.publishSuccess(promptId);
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (store.getJobById(jobId)!.status === "succeeded") return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`succeed 超时: ${jobId} 状态 ${store.getJobById(jobId)!.status}`);
}

describe("恢复加固（Task 005 §三）", () => {
  it("1+2. ComfyUI 不可用时启动：pending 原地等待（不产生 unknown）；重连后自动续跑完成", async () => {
    const c1 = await makeEngine();
    fc.state.wsState = "closed"; // ComfyUI 不可达
    const created = c1.engine.manager.createBatch(c1.engine.registry.get("t")!, {
      runs: [{ params: { prompt: "a" } }, { params: { prompt: "b" } }]
    });
    c1.engine.start();
    await tick(c1.engine);
    await tick(c1.engine);
    // 连接门控生效：零提交、零 unknown（连接断开 ≠ 提交结果未知）
    expect(fc.state.submitCalls).toBe(0);
    expect(c1.engine.getBatch(created.batchId).stats).toMatchObject({ pending: 2, unknown: 0 });
    // 恢复连接 → 自动续跑
    fc.state.wsState = "open";
    await tick(c1.engine);
    expect(fc.state.submitCalls).toBe(1);
    const job0 = c1.engine.store.getJob(created.batchId, 0)!;
    await succeed(c1.engine.store, fc.state, job0.prompt_id!, job0.id);
    await tick(c1.engine);
    expect(fc.state.submitCalls).toBe(2);
    const job1 = c1.engine.store.getJob(created.batchId, 1)!;
    await succeed(c1.engine.store, fc.state, job1.prompt_id!, job1.id);
    expect(c1.engine.getBatch(created.batchId).status).toBe("completed");
    c1.engine.stop();
    c1.db.close();
  });

  it("3+4. 重启恢复：queued 重新挂 Tracker；executing 经 history 对账定终态", async () => {
    const c1 = await makeEngine();
    const created = c1.engine.manager.createBatch(c1.engine.registry.get("t")!, {
      runs: [{ params: { prompt: "queued-one" } }, { params: { prompt: "exec-one" } }]
    });
    await tick(c1.engine); // job0 queued（窗口 1/1，job1 仍 pending）
    const j0 = c1.engine.store.getJob(created.batchId, 0)!;
    const j1 = c1.engine.store.getJob(created.batchId, 1)!;
    // 模拟崩溃瞬间的远端实况：job0 仍在队列；job1"曾在执行且远端已完成"
    // （直接构造 executing 态 + prompt_id + history 记录——提交细节与本测试无关）
    fc.state.queuePromptIds = { running: [], pending: [j0.prompt_id!] };
    const j1Pid = "exec-recovered-pid";
    fc.state.history.set(j1Pid, historyEntry({ "9": { images: [{ filename: "done.png", subfolder: "", type: "output" }] } }));
    c1.engine.store.patchJob(j1.id, { status: "executing", prompt_id: j1Pid, attempt_no: 1 });
    const submitsBefore = fc.state.submitCalls;
    c1.engine.stop(); // 旧实例资源释放
    c1.db.close();

    // —— 重启：新 Engine 接管同一 db ——
    const c2 = await makeEngine();
    const rec = await c2.engine.recover();
    expect(rec.resolved).toBe(1); // executing → history 对账 succeeded
    expect(rec.requeued).toBe(1); // queued → 重新挂 Tracker
    expect(c2.engine.store.getJob(created.batchId, 1)!.status).toBe("succeeded");
    expect(c2.engine.store.getJob(created.batchId, 0)!.status).toBe("queued");
    expect(fc.state.submitCalls).toBe(submitsBefore); // 恢复绝不重提
    // re-track 的 job0 由（共享 bus 的）新 tracker 跟随事件定终态
    await succeed(c2.engine.store, fc.state, j0.prompt_id!, j0.id);
    expect(c2.engine.store.getJob(created.batchId, 0)!.status).toBe("succeeded");
    c2.engine.stop();
    c2.db.close();
  });

  it("5. 未提交即重启的 pending：新调度器直接续跑", async () => {
    const c1 = await makeEngine();
    const created = c1.engine.manager.createBatch(c1.engine.registry.get("t")!, {
      runs: [{ params: { prompt: "late" } }]
    });
    c1.db.close(); // 未 tick（提交前崩溃）→ 重启
    const c2 = await makeEngine();
    await c2.engine.recover();
    await tick(c2.engine);
    expect(fc.state.submitCalls).toBe(1);
    expect(c2.engine.store.getJob(created.batchId, 0)!.status).toBe("queued");
    c2.engine.stop();
    c2.db.close();
  });

  it("6. submission_unknown 仍不重提，且持续占用窗口（后续 pending 等待）", async () => {
    const c1 = await makeEngine();
    fc.state.submitImpl = async () => {
      throw new Error("connection reset mid-submit");
    };
    const created = c1.engine.manager.createBatch(c1.engine.registry.get("t")!, {
      runs: [{ params: { prompt: "u" } }, { params: { prompt: "blocked" } }]
    });
    await tick(c1.engine); // job0 → submission_unknown
    c1.db.close();
    // 重启 + 恢复（history/queue 皆无）→ 保持 unknown
    const c2 = await makeEngine();
    const rec = await c2.engine.recover();
    expect(rec.keptUnknown).toBe(1);
    for (let i = 0; i < 3; i++) await tick(c2.engine);
    expect(fc.state.submitCalls).toBe(1); // 绝无第二次提交
    expect(c2.engine.getBatch(created.batchId).stats).toMatchObject({ unknown: 1, pending: 1 }); // 占额生效
    c2.engine.stop();
    c2.db.close();
  });

  it("7. 工作流修改后：旧 batch 的 pending 拒绝执行（WORKFLOW_VERSION_MISMATCH），在途不受影响，其他 batch 不受影响", async () => {
    const c1 = await makeEngine();
    const old = c1.engine.manager.createBatch(c1.engine.registry.get("t")!, {
      runs: [{ params: { prompt: "in-flight" } }, { params: { prompt: "leftover" } }]
    });
    await tick(c1.engine); // job0 提交（按旧指纹）
    const j0 = c1.engine.store.getJob(old.batchId, 0)!;
    expect(j0.status).toBe("queued");
    fc.state.queuePromptIds = { running: [], pending: [j0.prompt_id!] }; // 崩溃时仍在队列
    c1.engine.stop();
    c1.db.close();

    // 工作流内容变更（graph 改动）+ 重启（重扫 → 新指纹）
    await writeFile(path.join(wfDir, "t.json"), JSON.stringify({ ...GRAPH, "4": { class_type: "TextEncode", inputs: { text: "CHANGED" } } }));
    const c2 = await makeEngine();
    await c2.engine.recover(); // 在途 j0 重新挂 Tracker（按旧版已提交，照常对账）
    await tick(c2.engine);
    // 旧 batch 的 pending → cancelled + WORKFLOW_VERSION_MISMATCH（在途 j0 占窗口，新 batch 暂不提交）
    const leftover = c2.engine.store.getJob(old.batchId, 1)!;
    expect(leftover.status).toBe("cancelled");
    expect((JSON.parse(leftover.error_json!) as { code: string }).code).toBe("WORKFLOW_VERSION_MISMATCH");
    expect(c2.engine.store.getJob(old.batchId, 0)!.status).toBe("queued"); // 在途不受影响
    // 在途照常对账完成
    await succeed(c2.engine.store, fc.state, j0.prompt_id!, j0.id);
    expect(c2.engine.store.getJob(old.batchId, 0)!.status).toBe("succeeded");
    expect(c2.engine.getBatch(old.batchId).status).toBe("partial");

    // 新 batch（创建于新指纹之后）不受影响：窗口空出后正常提交
    const fresh = c2.engine.manager.createBatch(c2.engine.registry.get("t")!, {
      runs: [{ params: { prompt: "new-batch" } }]
    });
    const submitsBefore = fc.state.submitCalls;
    await tick(c2.engine);
    expect(c2.engine.store.getJob(fresh.batchId, 0)!.status).toBe("queued");
    expect(fc.state.submitCalls).toBe(submitsBefore + 1);
    c2.engine.stop();
    c2.db.close();
  });

  it("8. 多次启动恢复不产生重复提交（3 轮重启，job 恰好一次提交）", async () => {
    const c1 = await makeEngine();
    const created = c1.engine.manager.createBatch(c1.engine.registry.get("t")!, {
      runs: [{ params: { prompt: "multi" } }]
    });
    await tick(c1.engine); // job0 → queued
    const j0 = c1.engine.store.getJob(created.batchId, 0)!;
    fc.state.queuePromptIds = { running: [], pending: [j0.prompt_id!] };
    c1.db.close();

    for (let round = 0; round < 3; round++) {
      const cn = await makeEngine();
      await cn.engine.recover();
      await tick(cn.engine);
      expect(cn.engine.store.getJob(created.batchId, 0)!.status).toBe("queued");
      cn.db.close();
    }
    expect(fc.state.submitCalls).toBe(1); // 3 轮重启零新增提交
    // 最后一次接管后完成
    const cEnd = await makeEngine();
    await cEnd.engine.recover();
    await succeed(cEnd.engine.store, fc.state, j0.prompt_id!, j0.id);
    expect(cEnd.engine.store.getJob(created.batchId, 0)!.status).toBe("succeeded");
    cEnd.db.close();
  });
});
