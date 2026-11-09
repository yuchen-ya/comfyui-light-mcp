// Run only against an explicitly isolated ComfyUI instance. Never a production backend.
/* global fetch, AbortSignal */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";

const [packageArgument, runArgument, comfyUrl] = process.argv.slice(2);
assert(packageArgument && runArgument && comfyUrl, "Usage: node scripts/verify-install.mjs <installed-package-dir> <new-run-dir> <isolated-comfy-url>");
const packageDir = path.resolve(packageArgument);
const runDir = path.resolve(runArgument);
const metadata = JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8"));
const Database = createRequire(path.join(packageDir, "package.json"))("better-sqlite3");
const probe = new Database(":memory:");
assert.equal(probe.prepare("SELECT 1 AS value").get().value, 1);
probe.close();

// Refuse an existing run directory so this harness never reuses a user's data.
await mkdir(runDir);
await cp(path.join(packageDir, "examples"), path.join(runDir, "workflows"), { recursive: true });
const config = (await readFile(path.join(packageDir, "config.env.example"), "utf8"))
  .replace(/^COMFYUI_URL=.*$/m, `COMFYUI_URL=${comfyUrl}`)
  .replace(/^WORKFLOWS_DIR=.*$/m, "WORKFLOWS_DIR=./workflows")
  .replace(/^AUTO_SAVE_OUTPUTS=.*$/m, "AUTO_SAVE_OUTPUTS=false");
await writeFile(path.join(runDir, "config.env"), config);
const configKeys = new Set(["COMFYUI_URL", "WORKFLOWS_DIR", "DATA_DIR", "OUTPUT_DIR", "AUTO_SAVE_OUTPUTS", "MAX_IN_FLIGHT", "MAX_QUEUED_JOBS", "JOB_TIMEOUT_MS"]);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !configKeys.has(key.toUpperCase())));

function launch() {
  const child = spawn(process.execPath, ["--env-file=config.env", path.join(packageDir, "dist/index.js")], {
    cwd: runDir, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"]
  });
  let stderr = "";
  let buffer = "";
  let sequence = 0;
  const pending = new Map();
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      for (const request of pending.values()) request.reject(new Error(`MCP exited: ${code}/${signal}`));
      resolve({ code, signal });
    });
  });
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  child.stdout.setEncoding("utf8").on("data", chunk => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const message = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      if (message.id === undefined) continue;
      const request = pending.get(message.id);
      assert(request, "Unexpected JSON-RPC response");
      pending.delete(message.id);
      if (message.error) request.reject(new Error(JSON.stringify(message.error)));
      else request.resolve(message.result);
    }
  });
  const send = message => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}`)); }, 20_000);
    pending.set(id, {
      resolve: value => { clearTimeout(timer); resolve(value); },
      reject: error => { clearTimeout(timer); reject(error); }
    });
    send({ id, method, params });
  });
  return {
    async initialize() {
      const reply = await rpc("initialize", {
        protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "task008-install-check", version: "1" }
      });
      assert.equal(reply.serverInfo.version, metadata.version);
      send({ method: "notifications/initialized" });
      return reply;
    },
    rpc,
    async call(name, args) {
      const result = await rpc("tools/call", { name, arguments: args });
      assert(!result.isError, JSON.stringify(result));
      return JSON.parse(result.content[0].text);
    },
    async close() {
      child.stdin.end();
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => { child.kill(); reject(new Error("MCP failed to exit after stdin EOF")); }, 10_000);
      });
      try {
        assert.deepEqual(await Promise.race([exited, timeout]), { code: 0, signal: null });
      } finally {
        clearTimeout(timer);
        await writeFile(path.join(runDir, `stderr-${child.pid}.log`), stderr);
      }
      assert(stderr.includes("comfyui=connected"), "MCP did not connect to isolated ComfyUI");
    }
  };
}

const backend = await fetch(`${comfyUrl}/system_stats`, { signal: AbortSignal.timeout(5000) }).then(async response => {
  assert(response.ok);
  return response.json();
});
const session = launch();
let single;
let batch;
let index;
try {
  await session.initialize();
  const { tools } = await session.rpc("tools/list", {});
  assert.deepEqual(tools.map(tool => tool.name).sort(), ["get_batch", "get_result", "list_workflows", "run_workflow"]);
  const workflows = await session.call("list_workflows", {});
  assert.deepEqual(workflows.workflows.map(workflow => workflow.name), ["solid-color"]);
  const waitForBatch = async id => {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const view = await session.call("get_batch", { batch_id: id });
      if (["completed", "partial"].includes(view.status)) return view;
      assert(Date.now() < deadline && view.status === "running", JSON.stringify(view));
      await delay(200);
    }
  };
  single = await session.call("run_workflow", { workflow: "solid-color", params: { color: 255 }, idempotency_key: "install-single" });
  assert.equal((await waitForBatch(single.batch_id)).stats.succeeded, 1);
  const result = await session.call("get_result", { batch_id: single.batch_id });
  assert.equal(result.status, "succeeded");
  assert.equal(result.params_resolved.color, 255);
  assert((await stat(result.outputs[0].local_path)).size > 0);
  batch = await session.call("run_workflow", {
    workflow: "solid-color", idempotency_key: "install-batch", runs: [
      { label: "green", params: { color: 65280 } },
      { label: "red", params: { color: 16711680 } },
      { label: "invalid", params: { color: -1 } }
    ]
  });
  const view = await waitForBatch(batch.batch_id);
  assert.equal(view.stats.succeeded, 2);
  assert.equal(view.stats.invalid, 1);
  index = await session.call("get_result", { batch_id: batch.batch_id, mode: "index" });
  assert.equal(index.complete, true);
  assert.equal(index.total, 3);
  assert.equal(index.unavailable_outputs, 0);
  const rows = (await readFile(index.index_path, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(rows.map(row => row.label), ["green", "red", "invalid"]);
  for (const row of rows.filter(row => row.status === "succeeded")) {
    assert.equal(row.outputs.length, 1);
    assert.equal(row.outputs[0].availability, "available");
    assert.equal((await stat(row.outputs[0].local_path)).size, row.outputs[0].bytes);
  }
} finally {
  await session.close();
}

const reopened = launch();
try {
  await reopened.initialize();
  assert.equal((await reopened.call("get_result", { batch_id: single.batch_id })).status, "succeeded");
  assert.equal((await reopened.call("get_batch", { batch_id: batch.batch_id })).stats.succeeded, 2);
  const again = await reopened.call("get_result", { batch_id: batch.batch_id, mode: "index" });
  assert.equal(again.updated_at, index.updated_at);
  assert.equal(again.index_path, index.index_path);
} finally {
  await reopened.close();
}
const db = new Database(path.join(runDir, "data/comfyui-light.db"), { readonly: true });
try {
  assert.equal(db.pragma("user_version", { simple: true }), 5);
  assert.deepEqual(db.pragma("integrity_check"), [{ integrity_check: "ok" }]);
  assert.deepEqual(db.pragma("foreign_key_check"), []);
  assert.equal(db.prepare("SELECT count(*) AS n FROM batches").get().n, 2);
  assert.equal(db.prepare("SELECT count(*) AS n FROM jobs").get().n, 4);
  assert.equal(db.prepare("SELECT count(*) AS n FROM job_attempts").get().n, 3);
  await db.backup(path.join(runDir, "backup.db"));
} finally {
  db.close();
}
const backup = new Database(path.join(runDir, "backup.db"), { readonly: true });
try {
  assert.equal(backup.prepare("SELECT count(*) AS n FROM job_attempts").get().n, 3);
} finally {
  backup.close();
}
const report = {
  package_version: metadata.version, node: process.version, platform: process.platform, arch: process.arch,
  comfyui_version: backend.system.comfyui_version, native_sqlite: "passed", stdio_tools: 4,
  single_succeeded: 1, batch_succeeded: 2, batch_invalid: 1, jsonl_rows: 3,
  persisted_batches: 2, persisted_jobs: 4, attempts_before_and_after_restart: 3,
  integrity_check: "ok", foreign_key_check: "ok", online_backup: "passed", eof_exit: "0 on both starts"
};
await writeFile(path.join(runDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
