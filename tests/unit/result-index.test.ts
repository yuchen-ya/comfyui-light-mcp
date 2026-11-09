import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Engine } from "../../src/core/engine.js";
import { loadConfig } from "../../src/config.js";
import { openDb } from "../../src/core/storage/db.js";
import type { JobOutputAsset, JobRow, JobStatus } from "../../src/core/batch/store.js";
import { makeFakeClient } from "../helpers/fake-client.js";
import { createMcpServer } from "../../src/mcp/server.js";
import * as localFiles from "../../src/core/assets/local-files.js";

let directory: string;
let engine: Engine;
let db: ReturnType<typeof openDb>;
let fake: ReturnType<typeof makeFakeClient>;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "result-index-"));
  db = openDb(":memory:");
  fake = makeFakeClient();
  engine = new Engine(loadConfig({ COMFYUI_URL: "http://fake", WORKFLOWS_DIR: path.join(directory, "workflows"), OUTPUT_DIR: directory, AUTO_SAVE_OUTPUTS: "false" }), fake.client, db);
});

afterEach(async () => {
  vi.restoreAllMocks();
  expect(fake.state.submitCalls).toBe(0);
  expect(engine.store.listJobs("batch", { limit: -1, offset: 0 }).every((job) => job.attempt_no === 1)).toBe(true);
  expect(db.prepare("SELECT COUNT(*) AS n FROM job_attempts").get()).toEqual({ n: engine.store.countJobs("batch") });
  await engine.stop();
  db.close();
  await rm(directory, { recursive: true, force: true });
});

function asset(filename = "中文 图像.png", subfolder = ""): JobOutputAsset {
  return { filename, subfolder, kind: "image", type: "output", local_path: "", bytes: 0 };
}

function batch(statuses: JobStatus[], maxAttempts = 1): void {
  engine.store.createBatch({ id: "batch", workflow: "test", workflow_version: 1, idempotency_key: null,
    status: "running", total: statuses.length, options_json: JSON.stringify({ continue_on_error: true, max_attempts: maxAttempts }),
    created_at: new Date().toISOString(), finished_at: null, manifest_fingerprint: null, graph_fingerprint: null, request_fingerprint: null });
  statuses.forEach((status, idx) => {
    const job: JobRow = { id: `job-${idx}`, batch_id: "batch", idx, label: `标签 ${idx}`, status, attempt_no: 1,
      params_json: JSON.stringify({ prompt: "private prompt" }), resolved_json: JSON.stringify({ seed: idx + 100, prompt: "private prompt" }),
      prompt_id: `prompt-${idx}`, error_json: null, outputs_json: JSON.stringify(status === "succeeded" ? [asset(), asset("中文 图像.png", "second")] : []),
      submitted_at: null, started_at: null, finished_at: null };
    engine.store.createJob(job);
    engine.store.insertAttempt({ id: `attempt-${idx}`, job_id: job.id, attempt_no: 1, prompt_id: job.prompt_id, status });
  });
}

async function records(indexPath: string) {
  return (await readFile(indexPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
}

describe("batch result delivery (no generation)", () => {
  it("100 jobs keep index/label/seed and every duplicate-named output; unchanged queries do not rewrite", async () => {
    batch(Array.from({ length: 100 }, () => "succeeded"));
    const first = await engine.getResultIndex("batch");
    expect(first).toMatchObject({ complete: true, total: 100, succeeded: 100, failed: 0, unresolved: 0, unavailable_outputs: 0 });
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(2048);
    const lines = await records(first.index_path);
    for (const [idx, line] of lines.entries()) {
      expect(line).toMatchObject({ index: idx, label: `标签 ${idx}`, status: "succeeded", seed: 100 + idx, error: null });
      expect(line.outputs).toHaveLength(2);
      expect(line.outputs.map((output: { local_path: string }) => path.basename(output.local_path))).toEqual(["中文 图像.png", "中文 图像-2.png"]);
      for (const output of line.outputs) {
        expect(output).toMatchObject({ kind: "image", availability: "available", bytes: 16 });
        expect(path.isAbsolute(output.local_path)).toBe(true);
      }
    }
    expect(await readFile(first.index_path, "utf8")).not.toContain("private prompt");
    const before = await stat(first.index_path);
    expect(await engine.getResultIndex("batch")).toEqual(first);
    expect((await stat(first.index_path)).mtimeMs).toBe(before.mtimeMs);
    expect(fake.state.downloadCalls).toBe(200);
  });

  it("mixed states keep failures, invalid, unknown and paused distinct, then replace a running snapshot", async () => {
    batch(["succeeded", "failed", "invalid", "submission_unknown", "paused", "executing", "timeout", "cancelled"]);
    engine.store.patchJob("job-2", { error_json: JSON.stringify({ code: "INVALID_PARAMS", message: "bad params", node_errors: "private" }) });
    const first = await engine.getResultIndex("batch");
    expect(first).toMatchObject({ complete: false, total: 8, succeeded: 1, failed: 3, invalid: 1, unresolved: 3 });
    const lines = await records(first.index_path);
    expect(lines.map((line) => line.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(lines[2].error).toEqual({ code: "INVALID_PARAMS", message: "bad params" });
    expect(lines[3].error.code).toBe("SUBMISSION_UNKNOWN");
    expect(lines[4].error.code).toBe("PAUSED");
    for (const idx of [3, 4, 5]) engine.store.patchJob(`job-${idx}`, { status: "cancelled" });
    const final = await engine.getResultIndex("batch");
    expect(final).toMatchObject({ complete: true, status: "partial", unresolved: 0, failed: 6, invalid: 1 });
    expect((await records(final.index_path)).some((line) => ["paused", "submission_unknown", "executing"].includes(line.status))).toBe(false);
  });

  it("retry-eligible failures are unresolved even before scheduler resets them", async () => {
    batch(["failed"], 2);
    db.prepare("UPDATE job_attempts SET terminal_confirmed = 1").run();
    const result = await engine.getResultIndex("batch");
    expect(result).toMatchObject({ complete: false, unresolved: 1, failed: 0 });
    expect((await records(result.index_path))[0]).toMatchObject({ status: "failed", retry_pending: true });
  });

  it("concurrent batch and single queries download each output once and atomically publish one complete index", async () => {
    batch(["succeeded"]);
    const pending = Array.from({ length: 10 }, () => engine.getResultIndex("batch"));
    const single = engine.getResult("batch", 0);
    const results = await Promise.all(pending);
    await single;
    expect(results.every((result) => result.index_path === results[0]!.index_path)).toBe(true);
    expect(fake.state.downloadCalls).toBe(2);
    expect(await readdir(path.join(directory, "batch"))).toEqual(["0", "results.jsonl"]);
    expect(await records(results[0]!.index_path)).toHaveLength(1);
  });

  it("different download preferences serialize their writes without duplicate downloads", async () => {
    batch(["succeeded"]);
    const [snapshot, downloaded] = await Promise.all([
      engine.getResultIndex("batch", { download: false }), engine.getResultIndex("batch")
    ]);
    expect(snapshot.unavailable_outputs).toBe(2);
    expect(downloaded.unavailable_outputs).toBe(0);
    expect(fake.state.downloadCalls).toBe(2);
    expect((await records(downloaded.index_path))[0].outputs.every((output: { availability: string }) => output.availability === "available")).toBe(true);
  });

  it("single queries restore deleted files once without downloading retained files", async () => {
    batch(["succeeded"]);
    const initial = await engine.getResult("batch", 0);
    expect(fake.state.downloadCalls).toBe(2);
    const deletedPath = initial.outputs[0]!["local_path"] as string;
    const retainedPath = initial.outputs[1]!["local_path"] as string;
    await rm(deletedPath);

    expect(await engine.getResult("batch", 0, { download: false })).toEqual(initial);
    expect(fake.state.downloadCalls).toBe(2);
    await expect(stat(deletedPath)).rejects.toMatchObject({ code: "ENOENT" });

    const restored = await Promise.all(Array.from({ length: 10 }, () => engine.getResult("batch", 0)));
    for (const result of restored) expect(result).toEqual(initial);
    expect(await readFile(deletedPath, "utf8")).toBe("fake-image-bytes");
    expect(await readFile(retainedPath, "utf8")).toBe("fake-image-bytes");
    expect(fake.state.downloadCalls).toBe(3);
  });

  it("single queries propagate a deleted output's download failure and can retry it", async () => {
    batch(["succeeded"]);
    const initial = await engine.getResult("batch", 0);
    const deletedPath = initial.outputs[0]!["local_path"] as string;
    await rm(deletedPath);
    const failure = new Error("network");
    vi.spyOn(fake.client.http, "downloadOutput").mockRejectedValueOnce(failure);

    await expect(engine.getResult("batch", 0)).rejects.toBe(failure);
    expect(fake.state.downloadCalls).toBe(2);
    expect(await engine.getResult("batch", 0)).toEqual(initial);
    expect(fake.state.downloadCalls).toBe(3);
    expect(await readFile(deletedPath, "utf8")).toBe("fake-image-bytes");
  });

  it("uses manifest seed parameter names without exposing other resolved parameters", async () => {
    batch(["succeeded"]);
    const workflows = path.join(directory, "workflows");
    await mkdir(workflows);
    await writeFile(path.join(workflows, "test.json"), JSON.stringify({ "1": { class_type: "Sampler", inputs: { seed: 1, noise_seed: 2 } } }));
    await writeFile(path.join(workflows, "test.manifest.json"), JSON.stringify({ name: "test", description: "test", version: 1, workflowFile: "test.json",
      params: [
        { name: "noise", node: "1", input: "seed", type: "integer", special: "seed", default: -1 },
        { name: "variation", node: "1", input: "noise_seed", type: "integer", special: "seed", default: -1 }
      ] }));
    expect((await engine.loadWorkflowsAsync()).errors).toEqual([]);
    const fingerprints = engine.registry.get("test")!.fingerprints;
    db.prepare("UPDATE batches SET manifest_fingerprint = ?, graph_fingerprint = ?").run(fingerprints.manifestFingerprint, fingerprints.graphFingerprint);
    engine.store.patchJob("job-0", { resolved_json: JSON.stringify({ noise: 42, variation: 73, prompt: "private prompt" }) });
    const index = await engine.getResultIndex("batch");
    expect((await records(index.index_path))[0]).toMatchObject({ seed: null, seeds: { noise: 42, variation: 73 } });
    expect(await readFile(index.index_path, "utf8")).not.toContain("private prompt");
  });

  it("a tracker settlement during collection appears on the next snapshot with its outputs", async () => {
    batch(["executing"]);
    const original = localFiles.readLocalText;
    vi.spyOn(localFiles, "readLocalText").mockImplementationOnce(async (...args) => {
      engine.store.patchJob("job-0", { status: "succeeded", outputs_json: JSON.stringify([asset()]) });
      return original(...args);
    });
    const snapshot = await engine.getResultIndex("batch");
    expect(snapshot).toMatchObject({ complete: false, unresolved: 1 });
    expect((await records(snapshot.index_path))[0]).toMatchObject({ status: "executing", outputs: [] });
    const final = await engine.getResultIndex("batch");
    expect(final).toMatchObject({ complete: true, unresolved: 0, succeeded: 1 });
    expect((await records(final.index_path))[0].outputs).toHaveLength(1);
  });

  it("discovery for an unresolved job never overwrites newer tracker output references", async () => {
    batch(["executing"]);
    engine.store.patchJob("job-0", { outputs_json: JSON.stringify([asset()]) });
    const folder = path.join(directory, "batch", "0");
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, asset().filename), "existing");
    const newer = JSON.stringify([asset("new-result.png")]);
    const fileSize = localFiles.localFileSize;
    vi.spyOn(localFiles, "localFileSize").mockImplementationOnce(async (...args) => {
      const size = await fileSize(...args);
      engine.store.patchJob("job-0", { outputs_json: newer });
      return size;
    });
    expect((await engine.getResultIndex("batch")).complete).toBe(false);
    expect(engine.store.getJob("batch", 0)!.outputs_json).toBe(newer);
  });

  it("partial download failure is explicit; retry keeps successful files and restores deleted files", async () => {
    batch(["succeeded"]);
    const download = fake.client.http.downloadOutput.bind(fake.client.http);
    vi.spyOn(fake.client.http, "downloadOutput").mockImplementationOnce(download).mockRejectedValueOnce(new Error("network"));
    const first = await engine.getResultIndex("batch");
    expect(first).toMatchObject({ complete: true, unavailable_outputs: 1 });
    const lines = await records(first.index_path);
    expect(lines[0].outputs[1]).toMatchObject({ local_path: null, bytes: null, availability: "download_failed", error: { code: "DOWNLOAD_FAILED" } });
    const final = await engine.getResultIndex("batch");
    expect(final.unavailable_outputs).toBe(0);
    expect(fake.state.downloadCalls).toBe(2); // rejected spy did not enter fake implementation
    const local = (await records(final.index_path))[0].outputs[0].local_path;
    await rm(local);
    const missing = await engine.getResultIndex("batch", { download: false });
    expect(missing.unavailable_outputs).toBe(1);
    expect((await records(missing.index_path))[0].outputs[0]).toMatchObject({ local_path: null, availability: "not_downloaded" });
    expect((await engine.getResultIndex("batch")).unavailable_outputs).toBe(0);
    expect(fake.state.downloadCalls).toBe(3);
  });

  it("failed index replacement preserves the previous parseable snapshot and can be retried", async () => {
    batch(["executing"]);
    const initial = await engine.getResultIndex("batch");
    engine.store.patchJob("job-0", { status: "cancelled" });
    const write = localFiles.atomicWrite;
    vi.spyOn(localFiles, "atomicWrite").mockRejectedValueOnce(new Error("disk full"));
    await expect(engine.getResultIndex("batch")).rejects.toThrow("disk full");
    expect((await records(initial.index_path))[0].status).toBe("executing");
    vi.mocked(localFiles.atomicWrite).mockImplementation(write);
    expect((await engine.getResultIndex("batch")).complete).toBe(true);
    expect((await records(initial.index_path))[0].status).toBe("cancelled");
  });

  it("a real rename failure removes its temporary file and permits a later atomic write", async () => {
    const target = path.join(directory, "blocked.jsonl");
    await mkdir(target);
    await expect(localFiles.atomicWrite(directory, target, "{\"index\":0}\n")).rejects.toThrow();
    expect(await readdir(directory)).toEqual(["blocked.jsonl"]);
    await rm(target, { recursive: true });
    await localFiles.atomicWrite(directory, target, "{\"index\":0}\n");
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual({ index: 0 });
  });

  it("does not read foreign stored paths, traversal filenames or directory junctions", async () => {
    batch(["succeeded"]);
    const foreign = path.join(directory, "foreign.txt");
    await writeFile(foreign, "private");
    engine.store.patchJob("job-0", { outputs_json: JSON.stringify([{ ...asset(), local_path: foreign }, asset("../escape.png"), asset("valid.png")]) });
    const first = await engine.getResultIndex("batch");
    expect(first.unavailable_outputs).toBe(2);
    expect((await records(first.index_path))[0].outputs.slice(0, 2).every((output: { local_path: unknown }) => output.local_path === null)).toBe(true);
    expect((await records(first.index_path))[0].outputs[2].availability).toBe("available");
    expect(fake.state.downloadCalls).toBe(1);
    const external = await mkdtemp(path.join(tmpdir(), "index-external-"));
    try {
      await mkdir(path.join(directory, "batch"), { recursive: true });
      await rm(path.join(directory, "batch", "0"), { recursive: true, force: true });
      await symlink(external, path.join(directory, "batch", "0"), "junction");
      engine.store.patchJob("job-0", { outputs_json: JSON.stringify([asset()]) });
      expect((await engine.getResultIndex("batch")).unavailable_outputs).toBe(1);
      expect(await readdir(external)).toEqual([]);
    } finally {
      await rm(path.join(directory, "batch", "0"), { force: true });
      await rm(external, { recursive: true, force: true });
    }
  });

  it("MCP keeps four tools, default single result/errors and valid bounded batch JSON", async () => {
    batch(["succeeded"]);
    const server = createMcpServer(engine);
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "index-test", version: "1" });
    await client.connect(clientTransport);
    try {
      expect((await client.listTools()).tools).toHaveLength(4);
      const call = async (args: Record<string, unknown>) => client.callTool({ name: "get_result", arguments: args });
      const single = await call({ batch_id: "batch" });
      expect(JSON.parse((single.content as Array<{ text: string }>)[0]!.text)).toMatchObject({ index: 0, params_resolved: { seed: 100 }, status: "succeeded" });
      const index = await call({ batch_id: "batch", mode: "index" });
      const text = (index.content as Array<{ text: string }>)[0]!.text;
      expect(Buffer.byteLength(text)).toBeLessThan(2048);
      expect(JSON.parse(text)).toMatchObject({ total: 1, complete: true });
      for (const args of [{ batch_id: "batch", index: 5 }, { batch_id: "missing" }, { batch_id: "missing", mode: "index" }]) {
        const bad = await call(args);
        expect(bad.isError).toBe(true);
        expect(JSON.stringify(bad)).toContain("NOT_FOUND");
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
});
