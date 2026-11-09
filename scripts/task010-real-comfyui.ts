import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { createComfyClient } from "../src/core/client/index.js";
import { ComfyHttp } from "../src/core/client/comfy-http.js";
import { Engine } from "../src/core/engine.js";
import { openDb } from "../src/core/storage/db.js";
import type { WorkflowGraph } from "../src/core/client/types.js";

/**
 * 真实 ComfyUI 隔离验收。默认只读/dry-run，不生成。
 * 仅在明确批准一个内置节点 64x64 冒烟时设置 TASK010_APPROVE_GPU_SMOKE=1。
 * 所有文件、DB 和输出均在新的临时目录，不读取或修改生产工作流/数据库。
 */
const baseUrl = (process.env["COMFYUI_URL"] ?? "http://127.0.0.1:8188").replace(/\/+$/, "");
const approveGpu = process.env["TASK010_APPROVE_GPU_SMOKE"] === "1";
const root = await mkdtemp(path.join(tmpdir(), "task010-real-"));
const workflows = path.join(root, "workflows");
await mkdir(workflows);
const graph = JSON.parse(await readFile(path.resolve("examples", "solid-color.json"), "utf8")) as WorkflowGraph;
const manifest = JSON.parse(await readFile(path.resolve("examples", "solid-color.manifest.json"), "utf8")) as Record<string, unknown>;
await writeFile(path.join(workflows, "solid-color.json"), JSON.stringify(graph));
await writeFile(path.join(workflows, "solid-color.manifest.json"), JSON.stringify(manifest));

const http = new ComfyHttp({ baseUrl });
const health = await http.healthCheck();
const raw = await http.objectInfo();
const required = ["EmptyImage", "SaveImage"];
for (const name of required) {
  if (!raw[name]) throw new Error(`真实环境缺少内置节点 ${name}，无法运行隔离 solid-color 验收`);
}

let postPrompt = 0;
let interrupt = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input);
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  if (method === "POST" && new URL(url).pathname === "/prompt") postPrompt++;
  if (method === "POST" && new URL(url).pathname === "/interrupt") interrupt++;
  return originalFetch(input, init);
};

const db = openDb(path.join(root, "task010.db"));
const client = createComfyClient({ comfyUiUrl: baseUrl });
const engine = new Engine(loadConfig({
  COMFYUI_URL: baseUrl,
  WORKFLOWS_DIR: workflows,
  DATA_DIR: path.join(root, "data"),
  OUTPUT_DIR: path.join(root, "output")
}), client, db);
const report: Record<string, unknown> = {
  measured_at: new Date().toISOString(),
  comfyui_version: health.version,
  isolated_root: true,
  gpu_smoke_approved: approveGpu,
  checks: []
};
const checks = report["checks"] as Array<Record<string, unknown>>;

function counts(): number[] {
  return ["batches", "jobs", "job_attempts"].map((table) =>
    (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n
  );
}

async function hashFiles(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const file of ["solid-color.json", "solid-color.manifest.json"]) {
    out[file] = createHash("sha256").update(await readFile(path.join(workflows, file))).digest("hex");
  }
  return out;
}

try {
  const load = await engine.loadWorkflowsAsync();
  if (load.errors.length) throw new Error(JSON.stringify(load.errors));
  const beforeHashes = await hashFiles();
  const beforeCounts = counts();
  const valid = await engine.dryRun({ workflow: "solid-color", runs: [{ params: { color: 255, width: 64, height: 64 } }] });
  checks.push({ name: "valid_dry_run", valid: valid.valid, checks: valid.checks, source: valid.validation_sources.node_schema.source });
  if (!valid.valid) throw new Error(JSON.stringify(valid.errors));

  const badComboGraph = structuredClone(graph);
  badComboGraph["1"]!.class_type = "NotARegisteredNode";
  await writeFile(path.join(workflows, "solid-color.json"), JSON.stringify(badComboGraph));
  const invalid = await engine.dryRun({ workflow: "solid-color", runs: [{ params: {} }] });
  checks.push({ name: "invalid_node_dry_run", valid: invalid.valid, errors: invalid.errors });
  if (invalid.valid) throw new Error("非法节点未被 dry-run 拒绝");

  const modelGraph = structuredClone(graph);
  modelGraph["3"] = { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "task010-definitely-missing.safetensors" } };
  modelGraph["4"] = { class_type: "KSampler", inputs: {
    model: ["3", 0], positive: ["3", 1], negative: ["3", 1], latent_image: ["1", 0],
    seed: 1, steps: 1, cfg: 1, sampler_name: "task010-invalid-combo", scheduler: "normal", denoise: 1
  } };
  modelGraph["5"] = { class_type: "VAEDecode", inputs: { samples: ["4", 0], vae: ["3", 2] } };
  modelGraph["2"]!.inputs["images"] = ["5", 0];
  await writeFile(path.join(workflows, "solid-color.json"), JSON.stringify(modelGraph));
  const modelResult = await engine.dryRun({ workflow: "solid-color", runs: [{ params: {} }] });
  checks.push({
    name: "invalid_combo_and_missing_model",
    valid: modelResult.valid,
    errors: modelResult.errors.filter((e) => e.code === "INVALID_COMBO_VALUE" || e.code === "MODEL_MISSING")
  });
  if (modelResult.valid || !modelResult.errors.some((e) => e.code === "INVALID_COMBO_VALUE") || !modelResult.errors.some((e) => e.code === "MODEL_MISSING")) {
    throw new Error("真实 object_info 未识别非法 combo 或缺失模型");
  }

  await writeFile(path.join(workflows, "solid-color.json"), JSON.stringify(graph));
  const listed = await engine.listWorkflows("solid-color");
  checks.push({ name: "hot_reload_without_restart", status: listed["status"], version: listed["version"] });
  const reloaded = await engine.dryRun({ workflow: "solid-color", runs: [{ params: {} }] });
  if (!reloaded.valid) throw new Error(JSON.stringify(reloaded.errors));
  if (postPrompt !== 0 || interrupt !== 0) throw new Error("dry-run 产生了禁止的 POST");
  if (JSON.stringify(counts()) !== JSON.stringify(beforeCounts)) throw new Error("dry-run 写入了状态表");
  if (JSON.stringify(await hashFiles()) !== JSON.stringify(beforeHashes)) throw new Error("dry-run 修改了工作流文件");
  checks.push({ name: "dry_run_zero_side_effects", post_prompt: postPrompt, interrupt, database_counts: counts() });

  if (approveGpu) {
    const handle = await engine.runBatch({
      workflow: "solid-color",
      runs: [{ params: { color: 255, width: 64, height: 64 } }, { params: { color: 0, width: 64, height: 64 } }]
    });
    const oldFingerprint = engine.store.getBatch(handle.batch_id)!.graph_fingerprint;
    const changedGraph = structuredClone(graph);
    changedGraph["2"]!.inputs["filename_prefix"] = "task010-v2";
    await writeFile(path.join(workflows, "solid-color.json"), JSON.stringify(changedGraph));
    await writeFile(path.join(workflows, "solid-color.manifest.json"), JSON.stringify({ ...manifest, version: 2 }));
    await engine.listWorkflows();
    await engine.scheduler.tick();
    const protectedJob = engine.store.getJob(handle.batch_id, 1)!;
    if (protectedJob.status !== "paused") throw new Error(`旧 Batch 未暂停: ${protectedJob.status}`);
    checks.push({ name: "old_batch_version_protection", status: protectedJob.status, error: protectedJob.error_json });

    const deadline = Date.now() + 60_000;
    let result;
    for (;;) {
      result = await engine.getResult(handle.batch_id, 0);
      if (!["pending", "submitting", "queued", "executing"].includes(result.status)) break;
      if (Date.now() > deadline) throw new Error(`冒烟超时，状态 ${result.status}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (result.status !== "succeeded") throw new Error(JSON.stringify(result.error));
    if (engine.store.getBatch(handle.batch_id)!.graph_fingerprint !== oldFingerprint) throw new Error("旧 Batch 指纹被修改");
    checks.push({ name: "approved_single_gpu_smoke", status: result.status, output_count: result.outputs.length, submitted_jobs: 1 });
  } else {
    checks.push({ name: "approved_single_gpu_smoke", status: "not_run_no_explicit_approval" });
  }
  const output = path.resolve(".analysis", "task010", "real-comfyui.json");
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  globalThis.fetch = originalFetch;
  await engine.stop();
  client.stop();
  db.close();
  await rm(root, { recursive: true, force: true });
}
