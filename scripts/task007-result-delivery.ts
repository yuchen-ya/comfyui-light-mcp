/** Local-only Task007 replay. Never connects to ComfyUI or submits generation. */
import { copyFile, mkdir, readFile, writeFile, appendFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp/server.js";
import { Engine } from "../src/core/engine.js";
import { openDb } from "../src/core/storage/db.js";
import { loadConfig } from "../src/config.js";
import type { JobOutputAsset } from "../src/core/batch/store.js";
import { jailedJoin, safeFileName } from "../src/core/assets/path-jail.js";
import { makeFakeClient } from "../tests/helpers/fake-client.js";

const [command, first, second] = process.argv.slice(2);
if (!first || !["prepare", "serve", "verify"].includes(command ?? "")) {
  throw new Error("Usage: tsx scripts/task007-result-delivery.ts prepare SOURCE_DB DESTINATION | serve DESTINATION | verify DESTINATION");
}

if (command === "prepare") {
  if (!second) throw new Error("Destination required");
  const source = path.resolve(first);
  const destination = path.resolve(second);
  await mkdir(destination, { recursive: true });
  // Copy WAL as well as DB without opening or altering original benchmark material.
  await copyFile(source, path.join(destination, "source.db"));
  try { await copyFile(`${source}-wal`, path.join(destination, "source.db-wal")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const snapshot = openDb(path.join(destination, "source.db"));
  const batch = snapshot.prepare("SELECT id, total FROM batches WHERE total = 20 AND status = 'completed'").get() as { id: string; total: number };
  if (!batch) throw new Error("Expected an existing completed 20-job batch");
  for (const arm of ["old", "new"]) {
    const armDir = path.join(destination, arm);
    await mkdir(armDir, { recursive: true });
    await snapshot.backup(path.join(armDir, "replay.db"));
    const db = openDb(path.join(armDir, "replay.db"));
    const rows = db.prepare("SELECT id, idx, outputs_json FROM jobs WHERE batch_id = ? ORDER BY idx").all(batch.id) as Array<{ id: string; idx: number; outputs_json: string }>;
    for (const row of rows) {
      const outputs = JSON.parse(row.outputs_json) as JobOutputAsset[];
      for (const output of outputs) {
        const original = jailedJoin(path.resolve(path.dirname(source), "../outputs"), batch.id, String(row.idx), safeFileName(path.basename(output.local_path)));
        if (path.resolve(output.local_path) !== original) throw new Error("Unexpected source asset layout");
        const target = jailedJoin(path.join(armDir, "outputs"), batch.id, String(row.idx), safeFileName(path.basename(output.local_path)));
        await mkdir(path.dirname(target), { recursive: true });
        await copyFile(original, target);
        output.local_path = target;
      }
      db.prepare("UPDATE jobs SET outputs_json = ? WHERE id = ?").run(JSON.stringify(outputs), row.id);
    }
    db.close();
  }
  snapshot.close();
  // Frozen legacy interface, sharing the current compatible Engine implementation.
  const legacyServer = execFileSync("git", ["show", "6ca3b2a:src/mcp/server.ts"], { encoding: "utf8", windowsHide: true });
  const legacyInstructions = execFileSync("git", ["show", "6ca3b2a:src/mcp/instructions.ts"], { encoding: "utf8", windowsHide: true });
  const sourcePrefix = pathToFileURL(path.resolve("src") + path.sep).href;
  await writeFile(path.join(destination, "legacy-server.ts"), legacyServer.replaceAll('from "../', `from "${sourcePrefix}`));
  await writeFile(path.join(destination, "instructions.ts"), legacyInstructions);
  await writeFile(path.join(destination, "replay.json"), JSON.stringify({ batch_id: batch.id, total: batch.total }));
  console.log(JSON.stringify({ prepared: true, total: batch.total }));
} else if (command === "serve") {
  const directory = path.resolve(first);
  const replay = JSON.parse(await readFile(path.join(directory, "replay.json"), "utf8"));
  const legacy = await import(pathToFileURL(path.join(directory, "legacy-server.ts")).href);
  const arms = new Map();
  for (const arm of ["old", "new"]) {
    const db = openDb(path.join(directory, arm, "replay.db"));
    const fake = makeFakeClient();
    // Any unexpected backend operation is counted and rejected locally, before network IO.
    let backendCalls = 0;
    for (const method of ["submitPrompt", "downloadOutput", "getHistory", "getQueue"] as const) {
      Object.assign(fake.client.http, { [method]: async () => { backendCalls++; throw new Error("Backend disabled during result replay"); } });
    }
    const engine = new Engine(loadConfig({ COMFYUI_URL: "http://disabled.invalid", OUTPUT_DIR: path.join(directory, arm, "outputs") }), fake.client, db);
    const server = arm === "old" ? legacy.createMcpServer(engine) : createMcpServer(engine);
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "task007-replay", version: "1" });
    await client.connect(clientTransport);
    const tools = await client.listTools();
    arms.set(arm, { db, engine, server, client, tools, backendCalls: () => backendCalls, calls: [] });
  }
  const service = http.createServer(async (req, res) => {
    const [arm, route] = (req.url ?? "").slice(1).split("/");
    const selected = arms.get(arm);
    const send = (status: number, value: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (req.method === "GET" && route === "tools" && selected) return send(200, selected.tools);
    if (req.method === "GET" && route === "contract" && selected) return send(200, { instructions: selected.client.getInstructions(), batch_id: replay.batch_id, total: replay.total });
    if (req.method === "GET" && arm === "status") return send(200, Object.fromEntries([...arms].map(([name, item]) => [name, { calls: item.calls, backend_calls: item.backendCalls() }])));
    if (req.method === "POST" && arm === "stop") {
      const summary = Object.fromEntries([...arms].map(([name, item]) => [name, { calls: item.calls, backend_calls: item.backendCalls() }]));
      await writeFile(path.join(directory, "calls-summary.json"), JSON.stringify(summary, null, 2));
      for (const item of arms.values()) { await item.client.close(); await item.server.close(); await item.engine.stop(); item.db.close(); }
      send(200, summary);
      service.close();
      return;
    }
    if (req.method !== "POST" || route !== "call" || !selected) return send(404, { error: "Unknown route" });
    const parts = [];
    for await (const part of req) parts.push(part);
    const request = JSON.parse(Buffer.concat(parts).toString("utf8"));
    if (!["get_result", "get_batch", "list_workflows"].includes(request.name)) return send(400, { error: "Result retrieval only" });
    selected.calls.push(request.name);
    const result = await selected.client.callTool(request);
    await appendFile(path.join(directory, arm!, "calls.jsonl"), JSON.stringify({ request, result }) + "\n");
    send(200, result);
  });
  service.listen(0, "127.0.0.1", async () => {
    const address = service.address() as { port: number };
    await writeFile(path.join(directory, "bridge.json"), JSON.stringify({ port: address.port }));
    console.log(JSON.stringify({ ready: true, port: address.port, batch_id: replay.batch_id }));
  });
} else {
  const directory = path.resolve(first);
  const replay = JSON.parse(await readFile(path.join(directory, "replay.json"), "utf8"));
  const sourceSnapshot = openDb(path.join(directory, "source.db"));
  const attemptsBefore = (sourceSnapshot.prepare("SELECT COUNT(*) AS n FROM job_attempts").get() as { n: number }).n;
  sourceSnapshot.close();
  const counts = [];
  for (const arm of ["old", "new"]) {
    const db = openDb(path.join(directory, arm, "replay.db"));
    counts.push({ arm, jobs: db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE batch_id = ?").get(replay.batch_id),
      attempts: db.prepare("SELECT COUNT(*) AS n FROM job_attempts").get() });
    db.close();
  }
  const indexed = (await readFile(path.join(directory, "new", "outputs", replay.batch_id, "results.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const legacy = (await readFile(path.join(directory, "old", "agent-index.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  if (indexed.length !== 20 || indexed.some((row, idx) => row.index !== idx || row.seed !== 100001 + idx || row.outputs.length !== 1)) throw new Error("Unexpected replay results");
  if (legacy.length !== 20 || legacy.some((row, idx) => row.index !== idx || row.params_resolved.seed !== indexed[idx].seed || row.outputs.length !== 1)) throw new Error("Legacy/index results differ");
  for (const row of [...indexed, ...legacy]) {
    for (const output of row.outputs) {
      if (!(await stat(output.local_path)).isFile()) throw new Error("Missing output");
    }
  }
  if (counts.some((row) => (row.attempts as { n: number }).n !== attemptsBefore)) throw new Error("Attempt count changed");
  const verification = { verified: true, indexed_jobs: indexed.length, outputs: indexed.reduce((sum, row) => sum + row.outputs.length, 0), attempts_before: attemptsBefore, counts };
  await writeFile(path.join(directory, "verification.json"), JSON.stringify(verification, null, 2));
  console.log(JSON.stringify(verification));
}
