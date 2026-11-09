import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { loadConfig } from "../src/config.js";
import { createComfyClient } from "../src/core/client/index.js";
import { Engine } from "../src/core/engine.js";
import { openDb } from "../src/core/storage/db.js";
import type { ObjectInfoNode } from "../src/core/client/types.js";

const root = await mkdtemp(path.join(tmpdir(), "task010-perf-"));
const workflows = path.join(root, "workflows");
await mkdir(workflows);
const manifest = {
  name: "perf",
  description: "offline performance fixture",
  version: 1,
  workflowFile: "perf.json",
  params: [
    { name: "prompt", node: "2", input: "text", type: "string", required: true },
    { name: "seed", node: "4", input: "seed", type: "integer", special: "seed", default: 7 },
    { name: "steps", node: "4", input: "steps", type: "integer", min: 1, max: 100, default: 10 }
  ]
};
const graph = {
  "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "model-a.safetensors" } },
  "2": { class_type: "CLIPTextEncode", inputs: { text: "fixture", clip: ["1", 1] } },
  "3": { class_type: "EmptyLatentImage", inputs: { width: 64, height: 64, batch_size: 1 } },
  "4": { class_type: "KSampler", inputs: {
    model: ["1", 0], positive: ["2", 0], negative: ["2", 0], latent_image: ["3", 0],
    seed: 7, steps: 10, cfg: 1, sampler_name: "euler", scheduler: "normal", denoise: 1
  } },
  "5": { class_type: "VAEDecode", inputs: { samples: ["4", 0], vae: ["1", 2] } },
  "6": { class_type: "SaveImage", inputs: { images: ["5", 0], filename_prefix: "perf" } }
};
const schema: Record<string, ObjectInfoNode> = {
  CheckpointLoaderSimple: { input: { required: { ckpt_name: [["model-a.safetensors"], {}] } }, output: ["MODEL", "CLIP", "VAE"], output_node: false },
  CLIPTextEncode: { input: { required: { text: ["STRING", {}], clip: ["CLIP"] } }, output: ["CONDITIONING"], output_node: false },
  EmptyLatentImage: { input: { required: { width: ["INT", { min: 16, max: 4096 }], height: ["INT", { min: 16, max: 4096 }], batch_size: ["INT", { min: 1, max: 64 }] } }, output: ["LATENT"], output_node: false },
  KSampler: { input: { required: {
    model: ["MODEL"], positive: ["CONDITIONING"], negative: ["CONDITIONING"], latent_image: ["LATENT"],
    seed: ["INT", { min: 0, max: 4294967295 }], steps: ["INT", { min: 1, max: 1000 }], cfg: ["FLOAT", { min: 0, max: 100 }],
    sampler_name: [["euler", "ddim"], {}], scheduler: [["normal", "simple"], {}], denoise: ["FLOAT", { min: 0, max: 1 }]
  } }, output: ["LATENT"], output_node: false },
  VAEDecode: { input: { required: { samples: ["LATENT"], vae: ["VAE"] } }, output: ["IMAGE"], output_node: false },
  SaveImage: { input: { required: { images: ["IMAGE"], filename_prefix: ["STRING", {}] } }, output: [], output_node: true }
};
await writeFile(path.join(workflows, "perf.manifest.json"), JSON.stringify(manifest));
await writeFile(path.join(workflows, "perf.json"), JSON.stringify(graph));

const requests: Array<{ method: string; url: string }> = [];
const server = createServer((req, res) => {
  requests.push({ method: req.method ?? "", url: req.url ?? "" });
  if (req.url === "/object_info") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(schema));
  } else {
    res.writeHead(404).end();
  }
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("no local port");
const url = `http://127.0.0.1:${address.port}`;
const db = openDb(":memory:");
const client = createComfyClient({ comfyUiUrl: url });
const engine = new Engine(loadConfig({
  COMFYUI_URL: url,
  WORKFLOWS_DIR: workflows,
  DATA_DIR: path.join(root, "data"),
  OUTPUT_DIR: path.join(root, "output")
}), client, db);

function stats(values: number[]): { samples: number; min_ms: number; median_ms: number; p95_ms: number; max_ms: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const round = (n: number) => Math.round(n * 1000) / 1000;
  return {
    samples: values.length,
    min_ms: round(sorted[0]!),
    median_ms: round(sorted[Math.floor(sorted.length * 0.5)]!),
    p95_ms: round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!),
    max_ms: round(sorted[sorted.length - 1]!)
  };
}

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - start };
}

try {
  const initial = await timed(() => engine.loadWorkflowsAsync());
  if (initial.value.errors.length) throw new Error(JSON.stringify(initial.value.errors));
  const unchanged: number[] = [];
  for (let i = 0; i < 50; i++) unchanged.push((await timed(() => engine.listWorkflows())).ms);

  const changed = await timed(async () => {
    await writeFile(path.join(workflows, "perf.json"), JSON.stringify({ ...graph, "2": { class_type: "CLIPTextEncode", inputs: { text: "changed", clip: ["1", 1] } } }));
    await engine.listWorkflows();
  });
  const first = await timed(() => engine.dryRun({ workflow: "perf", runs: [{ params: { prompt: "one", seed: 7 } }] }));
  if (!first.value.valid) throw new Error(JSON.stringify(first.value.errors));
  const cached: number[] = [];
  for (let i = 0; i < 30; i++) {
    cached.push((await timed(() => engine.dryRun({ workflow: "perf", runs: [{ params: { prompt: "cached", seed: 7 } }] }))).ms);
  }
  const twenty: number[] = [];
  for (let i = 0; i < 20; i++) {
    twenty.push((await timed(() => engine.dryRun({
      workflow: "perf",
      runs: Array.from({ length: 20 }, (_, index) => ({ params: { prompt: `run-${index}`, seed: index } }))
    }))).ms);
  }
  const report = {
    measured_at: new Date().toISOString(),
    environment: { runtime: process.version, platform: process.platform, arch: process.arch, scope: "offline local HTTP fixture; not real ComfyUI" },
    initial_load_ms: Math.round(initial.ms * 1000) / 1000,
    unchanged_list_check: stats(unchanged),
    changed_reload_ms: Math.round(changed.ms * 1000) / 1000,
    first_object_info_dry_run_ms: Math.round(first.ms * 1000) / 1000,
    cached_dry_run: stats(cached),
    twenty_runs_dry_run: stats(twenty),
    requests,
    database_counts: ["batches", "jobs", "job_attempts"].map((table) => ({ table, count: (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n })),
    real_comfyui: { reachable: false, object_info_first_fetch_ms: null, gpu_runs: 0 }
  };
  const output = path.resolve(".analysis", "task010", "performance.json");
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await engine.stop();
  client.stop();
  db.close();
  await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
  await rm(root, { recursive: true, force: true });
}
