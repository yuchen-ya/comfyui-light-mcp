import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { WorkflowRegistry } from "../../src/core/workflow/registry.js";
import { parseWorkflowGraph } from "../../src/core/workflow/loader.js";
import type { WorkflowFormatError } from "../../src/core/workflow/loader.js";
import { Engine } from "../../src/core/engine.js";
import { openDb } from "../../src/core/storage/db.js";
import { loadConfig } from "../../src/config.js";
import { makeFakeClient } from "../helpers/fake-client.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "workflow-hot-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function manifest(version = 1) {
  return {
    name: "demo",
    description: "hot reload",
    version,
    workflowFile: "demo.json",
    params: [{ name: "prompt", node: "4", input: "text", type: "string", required: true }]
  };
}

function graph(text = "v1") {
  return {
    "4": { class_type: "CLIPTextEncode", inputs: { text } },
    "9": { class_type: "SaveImage", inputs: { images: ["4", 0] } }
  };
}

async function putPair(version = 1, text = "v1"): Promise<void> {
  await writeFile(path.join(dir, "demo.manifest.json"), JSON.stringify(manifest(version)));
  await writeFile(path.join(dir, "demo.json"), JSON.stringify(graph(text)));
}

async function stableRegistry(): Promise<WorkflowRegistry> {
  const registry = new WorkflowRegistry(dir);
  await registry.load();
  // 首次 load 后才得知 graph 路径；第二轮把 graph 元数据纳入未变化快照。
  await registry.refresh();
  return registry;
}

describe("WorkflowRegistry 热加载", () => {
  it("未变化复用对象；修改后不重启原子替换版本与指纹", async () => {
    await putPair();
    const registry = await stableRegistry();
    const v1 = registry.get("demo")!;
    expect((await registry.refresh()).errors).toEqual([]);
    expect(registry.get("demo")).toBe(v1);

    await putPair(2, "v2");
    const report = await registry.refresh();
    const v2 = registry.get("demo")!;
    expect(report.errors).toEqual([]);
    expect(v2).not.toBe(v1);
    expect(v2.manifest.version).toBe(2);
    expect(v2.graph["4"]!.inputs["text"]).toBe("v2");
    expect(v2.fingerprints.graphFingerprint).not.toBe(v1.fingerprints.graphFingerprint);
    expect(registry.list()[0]).toMatchObject({ name: "demo", status: "ready", version: 2 });
  });

  it("暂态非法 JSON 不污染最后有效版本，修复后可再次热加载", async () => {
    await putPair();
    const registry = await stableRegistry();
    const previous = registry.get("demo")!;

    await writeFile(path.join(dir, "demo.json"), '{"4":');
    const invalid = await registry.refresh();
    expect(invalid.errors[0]).toMatchObject({ code: "INVALID_JSON" });
    expect(registry.get("demo")).toBeUndefined();
    expect(registry.getLastValid("demo")).toBe(previous);
    expect(registry.statusOf("demo")).toMatchObject({ status: "invalid" });
    expect(registry.list()[0]).toMatchObject({ name: "demo", status: "invalid", workflow_fingerprint: null });

    await writeFile(path.join(dir, "demo.json"), JSON.stringify(graph("repaired")));
    expect((await registry.refresh()).errors).toEqual([]);
    expect(registry.get("demo")?.graph["4"]!.inputs["text"]).toBe("repaired");
  });

  it("manifest 与 workflow 不同步时标记 invalid，绝不把旧版本注册成新版本", async () => {
    await putPair();
    const registry = await stableRegistry();
    const changed = manifest(2);
    changed.params[0]!.node = "missing";
    await writeFile(path.join(dir, "demo.manifest.json"), JSON.stringify(changed));
    const report = await registry.refresh();
    expect(report.errors[0]).toMatchObject({ code: "INVALID_MANIFEST_TARGET", node_id: "missing", input: "text" });
    expect(registry.get("demo")).toBeUndefined();
    expect(registry.getLastValid("demo")?.manifest.version).toBe(1);

    await writeFile(path.join(dir, "demo.manifest.json"), JSON.stringify(manifest(2)));
    await writeFile(path.join(dir, "demo.json"), JSON.stringify(graph("v2")));
    await registry.refresh();
    expect(registry.get("demo")?.manifest.version).toBe(2);
  });

  it("删除工作流有 tombstone；其他工作流变化不会清掉删除状态", async () => {
    await putPair();
    await mkdir(path.join(dir, "other"));
    await writeFile(path.join(dir, "other", "other.manifest.json"), JSON.stringify({ ...manifest(), name: "other", workflowFile: "other.json" }));
    await writeFile(path.join(dir, "other", "other.json"), JSON.stringify(graph("other")));
    const registry = await stableRegistry();
    await rm(path.join(dir, "demo.manifest.json"));
    await registry.refresh();
    expect(registry.statusOf("demo")?.status).toBe("deleted");

    await writeFile(path.join(dir, "other", "other.json"), JSON.stringify(graph("other-v2")));
    await registry.refresh();
    expect(registry.list().find((w) => w.name === "demo")?.status).toBe("deleted");
  });

  it("manifest 内 name 改名会保留旧名 deleted 状态", async () => {
    await putPair();
    const registry = await stableRegistry();
    await writeFile(path.join(dir, "demo.manifest.json"), JSON.stringify({ ...manifest(2), name: "renamed" }));
    await registry.refresh();
    expect(registry.statusOf("demo")?.status).toBe("deleted");
    expect(registry.statusOf("renamed")?.status).toBe("ready");
  });

  it("并发 refresh 共享一次加载并返回同一个当前对象", async () => {
    await putPair();
    const registry = await stableRegistry();
    await putPair(2, "concurrent");
    const reports = await Promise.all(Array.from({ length: 12 }, () => registry.refresh()));
    expect(reports.every((r) => r.errors.length === 0)).toBe(true);
    const current = registry.get("demo");
    expect(current?.manifest.version).toBe(2);
    expect(reports.map((r) => r.loaded[0]?.name)).toEqual(Array.from({ length: 12 }, () => "demo"));
  });

  it("拒绝重复节点 ID 与非法节点 ID", () => {
    expect(() => parseWorkflowGraph("dup.json", '{"1":{"class_type":"A","inputs":{}},"1":{"class_type":"B","inputs":{}}}'))
      .toThrowError(expect.objectContaining({ code: "DUPLICATE_NODE_ID", nodeId: "1" }) as WorkflowFormatError);
    expect(() => parseWorkflowGraph("bad.json", '{"bad id":{"class_type":"A","inputs":{}}}'))
      .toThrowError(expect.objectContaining({ code: "INVALID_NODE_ID", nodeId: "bad id" }) as WorkflowFormatError);
  });
});

describe("Engine 热加载与版本保护", () => {
  let db: Database.Database | undefined;
  let engine: Engine | undefined;

  afterEach(async () => {
    await engine?.stop();
    db?.close();
    db = undefined;
    engine = undefined;
  });

  function makeEngine(): ReturnType<typeof makeFakeClient> {
    const fake = makeFakeClient();
    db = openDb(":memory:");
    engine = new Engine(loadConfig({
      COMFYUI_URL: "http://fake",
      WORKFLOWS_DIR: dir,
      DATA_DIR: path.join(dir, "data"),
      OUTPUT_DIR: path.join(dir, "out")
    }), fake.client, db);
    return fake;
  }

  it("修改后无效的新执行返回 WORKFLOW_INVALID，零数据库写入、零 POST", async () => {
    await putPair();
    const fake = makeEngine();
    await engine!.loadWorkflowsAsync();
    await writeFile(path.join(dir, "demo.json"), "not-json");
    await expect(engine!.runSingle({ workflow: "demo", params: { prompt: "x" } }))
      .rejects.toMatchObject({ code: "WORKFLOW_INVALID" });
    expect(fake.state.submitCalls).toBe(0);
    expect(db!.prepare("SELECT count(*) AS n FROM batches").get()).toEqual({ n: 0 });
    expect(db!.prepare("SELECT count(*) AS n FROM jobs").get()).toEqual({ n: 0 });
  });

  it("single and batch replays report fingerprint conflict before changed-manifest parameter errors", async () => {
    await putPair();
    const fake = makeEngine();
    await engine!.loadWorkflowsAsync();
    const request = { workflow: "demo", params: { prompt: "original" }, idempotencyKey: "changed-manifest" };
    const original = await engine!.runSingle(request);
    await engine!.stop();
    const changed = manifest(2);
    changed.params[0]!.name = "renamed_prompt";
    await writeFile(path.join(dir, "demo.manifest.json"), JSON.stringify(changed));
    await expect(engine!.runSingle(request)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(engine!.runBatch({
      workflow: request.workflow, runs: [{ params: request.params }], idempotencyKey: request.idempotencyKey
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(fake.state.submitCalls).toBe(1);
    expect(engine!.store.getAttempts(engine!.store.getJob(original.batch_id, 0)!.id)).toHaveLength(1);
    expect(db!.prepare("SELECT count(*) AS n FROM batches").get()).toEqual({ n: 1 });
  });

  it("无效文件暂停旧 Batch 时使用 WORKFLOW_INVALID，不误报版本漂移", async () => {
    await putPair();
    const fake = makeEngine();
    await engine!.loadWorkflowsAsync();
    const batch = await engine!.runBatch({
      workflow: "demo",
      runs: [{ params: { prompt: "old-1" } }, { params: { prompt: "old-2" } }]
    });
    await engine!.stop();
    await writeFile(path.join(dir, "demo.json"), "not-json");
    await engine!.listWorkflows();
    await engine!.scheduler.tick();
    const pending = engine!.store.getJob(batch.batch_id, 1)!;
    expect(pending.status).toBe("paused");
    expect(JSON.parse(pending.error_json!) as { code: string }).toMatchObject({ code: "WORKFLOW_INVALID" });
    expect(fake.state.submitCalls).toBe(1);
  });

  it("旧 Batch 剩余任务暂停，新 Batch 使用新 fingerprint，已提交任务不受影响", async () => {
    await putPair();
    const fake = makeEngine();
    await engine!.loadWorkflowsAsync();
    const oldBatch = await engine!.runBatch({
      workflow: "demo",
      runs: [{ params: { prompt: "old-1" } }, { params: { prompt: "old-2" } }]
    });
    // runBatch 启动的独立后台刷新不参与本用例的确定性文件写入窗口。
    await engine!.stop();
    const submitted = engine!.store.getJob(oldBatch.batch_id, 0)!;
    expect(submitted.status).toBe("queued");
    fake.state.queuePromptIds.pending.push(submitted.prompt_id!);
    const oldFingerprint = engine!.store.getBatch(oldBatch.batch_id)!.graph_fingerprint;

    await putPair(2, "v2");
    const list = await engine!.listWorkflows();
    expect(list["refresh"]).toBe("ok");
    await engine!.scheduler.tick();
    expect(engine!.store.getJob(oldBatch.batch_id, 0)!.status).toBe("queued");
    expect(engine!.store.getJob(oldBatch.batch_id, 1)!.status).toBe("paused");
    expect(JSON.parse(engine!.store.getJob(oldBatch.batch_id, 1)!.error_json!) as { code: string })
      .toMatchObject({ code: "WORKFLOW_VERSION_MISMATCH" });
    expect(fake.state.submitCalls).toBe(1);

    const fresh = await engine!.runBatch({ workflow: "demo", runs: [{ params: { prompt: "new" } }] });
    const freshRow = engine!.store.getBatch(fresh.batch_id)!;
    expect(freshRow.workflow_version).toBe(2);
    expect(freshRow.graph_fingerprint).not.toBe(oldFingerprint);
    expect(fake.state.submitCalls).toBe(1);
  });
});
