import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { Engine } from "../../src/core/engine.js";
import { openDb } from "../../src/core/storage/db.js";
import { loadConfig } from "../../src/config.js";
import { makeFakeClient, type FakeHttpState } from "../helpers/fake-client.js";
import type { ObjectInfoNode } from "../../src/core/client/types.js";
import type { ComfyClient } from "../../src/core/client/index.js";

const SCHEMA: Record<string, ObjectInfoNode> = {
  CheckpointLoaderSimple: {
    input: { required: { ckpt_name: [["model-a.safetensors", "model-b.safetensors"], {}] } },
    output: ["MODEL", "CLIP", "VAE"],
    output_node: false
  },
  CLIPTextEncode: {
    input: { required: { text: ["STRING", { multiline: true }], clip: ["CLIP"] } },
    output: ["CONDITIONING"],
    output_node: false
  },
  EmptyLatentImage: {
    input: { required: {
      width: ["INT", { default: 64, min: 16, max: 4096, step: 8 }],
      height: ["INT", { default: 64, min: 16, max: 4096, step: 8 }],
      batch_size: ["INT", { default: 1, min: 1, max: 64 }]
    } },
    output: ["LATENT"],
    output_node: false
  },
  KSampler: {
    input: { required: {
      model: ["MODEL"], positive: ["CONDITIONING"], negative: ["CONDITIONING"], latent_image: ["LATENT"],
      seed: ["INT", { default: 0, min: 0, max: 4294967295 }],
      steps: ["INT", { default: 10, min: 1, max: 1000 }],
      cfg: ["FLOAT", { default: 1, min: 0, max: 100 }],
      sampler_name: [["euler", "ddim"], {}],
      scheduler: [["normal", "simple"], {}],
      denoise: ["FLOAT", { default: 1, min: 0, max: 1 }]
    } },
    output: ["LATENT"],
    output_node: false
  },
  VAEDecode: { input: { required: { samples: ["LATENT"], vae: ["VAE"] } }, output: ["IMAGE"], output_node: false },
  SaveImage: {
    input: { required: { images: ["IMAGE"], filename_prefix: ["STRING", { default: "dry-run" }] } },
    output: [],
    output_node: true
  }
};

function manifest() {
  return {
    name: "demo",
    description: "dry run fixture",
    version: 1,
    workflowFile: "demo.json",
    params: [
      { name: "prompt", node: "2", input: "text", type: "string", required: true },
      { name: "checkpoint", node: "1", input: "ckpt_name", type: "string", default: "model-a.safetensors" },
      { name: "seed", node: "4", input: "seed", type: "integer", special: "seed", default: 7 },
      { name: "steps", node: "4", input: "steps", type: "integer", min: 1, max: 100, default: 10 },
      { name: "sampler", node: "4", input: "sampler_name", type: "string", default: "euler" }
    ]
  };
}

function graph() {
  return {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "model-a.safetensors" } },
    "2": { class_type: "CLIPTextEncode", inputs: { text: "fixture", clip: ["1", 1] } },
    "3": { class_type: "EmptyLatentImage", inputs: { width: 64, height: 64, batch_size: 1 } },
    "4": { class_type: "KSampler", inputs: {
      model: ["1", 0], positive: ["2", 0], negative: ["2", 0], latent_image: ["3", 0],
      seed: 1, steps: 10, cfg: 1, sampler_name: "euler", scheduler: "normal", denoise: 1
    } },
    "5": { class_type: "VAEDecode", inputs: { samples: ["4", 0], vae: ["1", 2] } },
    "6": { class_type: "SaveImage", inputs: { images: ["5", 0], filename_prefix: "dry-run" } }
  };
}

interface Ctx {
  engine: Engine;
  fake: FakeHttpState;
  client: ComfyClient;
  db: Database.Database;
  dir: string;
}

let ctx: Ctx | undefined;

beforeEach(async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "dry-run-"));
  await writeFile(path.join(dir, "demo.manifest.json"), JSON.stringify(manifest()));
  await writeFile(path.join(dir, "demo.json"), JSON.stringify(graph()));
  const fake = makeFakeClient();
  fake.state.objectInfoImpl = async () => SCHEMA;
  const db = openDb(":memory:");
  const engine = new Engine(loadConfig({
    COMFYUI_URL: "http://fake",
    WORKFLOWS_DIR: dir,
    DATA_DIR: path.join(dir, "data"),
    OUTPUT_DIR: path.join(dir, "out")
  }), fake.client, db);
  expect((await engine.loadWorkflowsAsync()).errors).toEqual([]);
  ctx = { engine, fake: fake.state, client: fake.client, db, dir };
});

afterEach(async () => {
  if (!ctx) return;
  await ctx.engine.stop();
  ctx.db.close();
  await rm(ctx.dir, { recursive: true, force: true });
  ctx = undefined;
});

function counts(db: Database.Database): unknown[] {
  return ["batches", "jobs", "job_attempts"].map((table) =>
    (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n
  );
}

function validParams(): Record<string, unknown> {
  return { prompt: "a red sphere", seed: 7 };
}

describe("Engine dry-run 零副作用与结果汇总", () => {
  it.each([
    { prompt: "explicit seed", seed: 7 },
    { prompt: "default random seed" },
    { prompt: "explicit random seed", seed: -1 }
  ])("preserves a random seed default during dry-run: %j", async (params) => {
    const c = ctx!;
    const fixture = manifest();
    fixture.params.find((param) => param.name === "seed")!.default = -1;
    await writeFile(path.join(c.dir, "demo.manifest.json"), JSON.stringify(fixture));
    expect((await c.engine.loadWorkflowsAsync()).errors).toEqual([]);
    const result = await c.engine.dryRun({ workflow: "demo", runs: [{ params }] });
    expect(result.valid).toBe(true);
    expect(result.checks.manifest_mapping).toBe("passed");
    expect(result.checks.node_types).toBe("passed");
    expect(result.errors).toEqual([]);
    expect(result.submission).toBe("not_submitted");
    expect(counts(c.db)).toEqual([0, 0, 0]);
    expect(c.fake.submitCalls).toBe(0);
    expect(c.engine.scheduler.isRunning()).toBe(false);
    expect(JSON.parse(await readFile(path.join(c.dir, "demo.manifest.json"), "utf8")).params
      .find((param: { name: string }) => param.name === "seed").default).toBe(-1);
  });

  it("合法单任务通过；第二次命中缓存；文件、DB、提交、调度与输出均无副作用", async () => {
    const c = ctx!;
    const beforeGraph = createHash("sha256").update(await readFile(path.join(c.dir, "demo.json"))).digest("hex");
    const first = await c.engine.dryRun({ workflow: "demo", runs: [{ params: validParams() }] });
    expect(first).toMatchObject({
      dry_run: true,
      valid: true,
      runs: { total: 1, valid: 1, invalid: 0 },
      checks: {
        json_format: "passed", workflow_structure: "passed", node_types: "passed",
        manifest_mapping: "passed", parameters: "passed", model_dependencies: "passed"
      },
      models: { found: 1, missing: 0, unknown: 0 },
      validation_sources: { node_schema: { source: "live" } },
      submission: "not_submitted"
    });
    expect(c.fake.objectInfoCalls).toBe(1);

    const second = await c.engine.dryRun({ workflow: "demo", runs: [{ params: validParams() }] });
    expect(second.validation_sources.node_schema.source).toBe("cache");
    expect(c.fake.objectInfoCalls).toBe(1);
    expect(counts(c.db)).toEqual([0, 0, 0]);
    expect(c.fake.submitCalls).toBe(0);
    expect(c.fake.interruptCalls).toEqual([]);
    expect(c.engine.scheduler.isRunning()).toBe(false);
    await expect(access(path.join(c.dir, "out"))).rejects.toThrow();
    const afterGraph = createHash("sha256").update(await readFile(path.join(c.dir, "demo.json"))).digest("hex");
    expect(afterGraph).toBe(beforeGraph);
    expect(JSON.stringify(second)).not.toContain("model-b.safetensors");
  });

  it("20 runs 中 18 valid / 2 invalid，按 run 汇总且零创建", async () => {
    const c = ctx!;
    const runs = Array.from({ length: 20 }, (_, index) => ({
      label: `run-${index}`,
      params: index === 3
        ? { ...validParams(), steps: 999 }
        : index === 17
          ? { ...validParams(), unknown: true }
          : validParams()
    }));
    const result = await c.engine.dryRun({ workflow: "demo", runs });
    expect(result.valid).toBe(false);
    expect(result.runs).toMatchObject({ total: 20, valid: 18, invalid: 2 });
    expect(result.runs.invalid_runs).toEqual([
      { index: 3, error_count: 1 },
      { index: 17, error_count: 1 }
    ]);
    expect(result.checks.parameters).toBe("failed");
    expect(result.errors.filter((e) => e.code === "INVALID_PARAMS").map((e) => e.index)).toEqual([3, 17]);
    expect(result.submission).toBe("not_submitted");
    expect(counts(c.db)).toEqual([0, 0, 0]);
    expect(c.fake.submitCalls).toBe(0);
  });

  it("非法 combo 与缺失模型返回具体节点，不泄露模型清单", async () => {
    const c = ctx!;
    const combo = await c.engine.dryRun({ workflow: "demo", runs: [{ params: { ...validParams(), sampler: "bogus" } }] });
    expect(combo.valid).toBe(false);
    expect(combo.errors.find((e) => e.code === "INVALID_COMBO_VALUE")).toMatchObject({ index: 0, node_id: "4", input: "sampler_name" });

    const missing = await c.engine.dryRun({ workflow: "demo", runs: [{ params: { ...validParams(), checkpoint: "missing.safetensors" } }] });
    expect(missing.valid).toBe(false);
    expect(missing.checks.model_dependencies).toBe("failed");
    expect(missing.models).toMatchObject({ found: 0, missing: 1 });
    const issue = missing.errors.find((e) => e.code === "MODEL_MISSING");
    expect(issue).toMatchObject({ node_id: "1", input: "ckpt_name" });
    expect(issue?.message).toContain("missing.safetensors");
    expect(issue?.message).not.toContain("model-b.safetensors");
    expect(counts(c.db)).toEqual([0, 0, 0]);
  });

  it("object_info 不可用只能 unknown；刷新失败只能 stale，均不伪装 passed", async () => {
    const c = ctx!;
    c.fake.objectInfoImpl = async () => { throw new Error("offline fixture"); };
    const unavailable = await c.engine.dryRun({ workflow: "demo", runs: [{ params: validParams() }] });
    expect(unavailable.valid).toBe(true);
    expect(unavailable.checks.node_types).toBe("unknown");
    expect(unavailable.checks.model_dependencies).toBe("unknown");
    expect(unavailable.validation_sources.node_schema.source).toBe("unavailable");
    expect(unavailable.warnings.some((w) => w.code === "OBJECT_INFO_UNAVAILABLE")).toBe(true);
  });

  it("连接 epoch 变化后刷新失败返回 stale + unknown", async () => {
    const c = ctx!;
    let epoch = 0;
    (c.client.ws as unknown as { getStats: () => { state: string; reconnects: number } }).getStats =
      () => ({ state: "open", reconnects: epoch });
    const live = await c.engine.dryRun({ workflow: "demo", runs: [{ params: validParams() }] });
    expect(live.validation_sources.node_schema.source).toBe("live");

    epoch = 1;
    c.fake.objectInfoImpl = async () => { throw new Error("refresh failed"); };
    const stale = await c.engine.dryRun({ workflow: "demo", runs: [{ params: validParams() }] });
    expect(stale.validation_sources.node_schema.source).toBe("stale");
    expect(stale.checks.node_types).toBe("unknown");
    expect(stale.checks.model_dependencies).toBe("unknown");
    expect(stale.warnings.some((w) => w.code === "OBJECT_INFO_STALE")).toBe(true);
    expect(counts(c.db)).toEqual([0, 0, 0]);
  });

  it("超长参数错误和无效工作流错误均有 200 字符上限", async () => {
    const c = ctx!;
    const result = await c.engine.dryRun({ workflow: "demo", runs: [{ params: { steps: "x".repeat(200_000) } }] });
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.message.length).toBeLessThanOrEqual(200);
    expect(JSON.stringify(result).length).toBeLessThan(20_000);

    await writeFile(path.join(c.dir, "demo.json"), "x".repeat(200_000));
    const invalid = await c.engine.dryRun({ workflow: "demo", runs: [{ params: validParams() }] });
    expect(invalid.errors[0]!.message.length).toBeLessThanOrEqual(200);
  });

  it("热加载发现非法 JSON / UI 格式时返回预检失败，不执行旧版本", async () => {
    const c = ctx!;
    await writeFile(path.join(c.dir, "demo.json"), '{"1":');
    const invalidJson = await c.engine.dryRun({ workflow: "demo", runs: [{ params: validParams() }] });
    expect(invalidJson.valid).toBe(false);
    expect(invalidJson.checks.json_format).toBe("failed");
    expect(invalidJson.errors[0]?.code).toBe("INVALID_JSON");

    await writeFile(path.join(c.dir, "demo.json"), JSON.stringify({ nodes: [], links: [] }));
    const ui = await c.engine.dryRun({ workflow: "demo", runs: [{ params: validParams() }] });
    expect(ui.valid).toBe(false);
    expect(ui.errors[0]?.code).toBe("UI_FORMAT_REJECTED");
    expect(counts(c.db)).toEqual([0, 0, 0]);
    expect(c.fake.submitCalls).toBe(0);
  });

  it("manifest 新 default 与 schema 冲突时热加载后 dry-run 失败", async () => {
    const c = ctx!;
    const changed = manifest();
    changed.version = 2;
    changed.params[4]!.default = "not-a-sampler";
    await writeFile(path.join(c.dir, "demo.manifest.json"), JSON.stringify(changed));
    const result = await c.engine.dryRun({ workflow: "demo", runs: [{ params: validParams() }] });
    expect(result.valid).toBe(false);
    expect(result.checks.manifest_mapping).toBe("failed");
    expect(result.errors.some((e) => e.code === "MANIFEST_DEFAULT_INVALID")).toBe(true);
    expect(counts(c.db)).toEqual([0, 0, 0]);
  });

  it("关停时在途刷新失败也继续 tracker 清理，不拒绝 stop", async () => {
    const c = ctx!;
    const original = c.engine.registry.refresh.bind(c.engine.registry);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    c.engine.registry.refresh = async () => {
      await gate;
      return { loaded: [], errors: [], scanFailed: true };
    };
    c.engine.start();
    const stopped = c.engine.stop();
    release();
    await expect(stopped).resolves.toBeUndefined();
    c.engine.registry.refresh = original;
  });

  it("已有 Batch 的状态与三表计数不变，dry-run 不重启调度器", async () => {
    const c = ctx!;
    const handle = await c.engine.runSingle({ workflow: "demo", params: validParams() });
    await c.engine.scheduler.stop();
    const jobBefore = c.engine.store.getJob(handle.batch_id, 0)!.status;
    const countsBefore = counts(c.db);
    const submitBefore = c.fake.submitCalls;
    const result = await c.engine.dryRun({ workflow: "demo", runs: [{ params: validParams() }] });
    expect(result.valid).toBe(true);
    expect(counts(c.db)).toEqual(countsBefore);
    expect(c.engine.store.getJob(handle.batch_id, 0)!.status).toBe(jobBefore);
    expect(c.fake.submitCalls).toBe(submitBefore);
    expect(c.engine.scheduler.isRunning()).toBe(false);
  });
});
