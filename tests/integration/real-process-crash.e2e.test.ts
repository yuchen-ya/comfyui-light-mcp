import { describe, expect, it } from "vitest";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../../src/config.js";
import { openDb } from "../../src/core/storage/db.js";
import { createComfyClient } from "../../src/core/client/index.js";
import { queueEntryPromptId } from "../../src/core/client/types.js";
import { Engine } from "../../src/core/engine.js";

const url = process.env["COMFYUI_URL"] ?? "http://127.0.0.1:8188";
let reachable = false;
try { reachable = (await fetch(`${url}/system_stats`, { signal: AbortSignal.timeout(4000) })).ok; }
catch { /* Offline test runs explicitly skip real GPU scenarios. */ }

interface CrashPoint {
  stage: string;
  batchId: string;
  promptId: string;
  cancelRequestedAt: string;
  deadlineAt: string;
  posts: number;
  pid: number;
}

async function eventually(predicate: () => Promise<boolean>, timeoutMs = 180_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("Real crash recovery did not converge before deadline");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

describe.skipIf(!reachable)("real ComfyUI independent process forced termination", () => {
  it.each(["success", "interrupted"])("intent persisted -> SIGKILL -> automatic recovery: %s", { timeout: 240_000 }, async (scenario) => {
    const dir = await mkdtemp(path.join(tmpdir(), "comfy-crash-"));
    const worker = fork(path.resolve("tests/helpers/crash-worker.ts"), [url, dir, scenario], {
      execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true
    });
    let stderr = "";
    worker.stderr!.on("data", (data) => { stderr = (stderr + String(data)).slice(-2000); });
    let engine: Engine | undefined;
    let db: ReturnType<typeof openDb> | undefined;
    const client = createComfyClient({ comfyUiUrl: url });
    try {
      const point = await new Promise<CrashPoint>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Worker failed to reach crash point: ${stderr}`)), 30_000);
        worker.on("message", (message) => {
          const point = message as CrashPoint;
          if (point.stage === "cancel_intent") { clearTimeout(timer); resolve(point); }
        });
        worker.once("error", (error) => { clearTimeout(timer); reject(error); });
        worker.once("exit", () => { clearTimeout(timer); reject(new Error(`Worker exited before crash point: ${stderr}`)); });
      });
      expect(point.pid).not.toBe(process.pid);
      expect(point.cancelRequestedAt).toBeTruthy();
      expect(point.deadlineAt).toBeTruthy();
      expect(point.posts).toBe(1);
      const exited = once(worker, "exit");
      expect(worker.kill("SIGKILL")).toBe(true); // Windows uses TerminateProcess.
      await exited;

      let posts = point.posts;
      const submit = client.http.submitPrompt.bind(client.http);
      client.http.submitPrompt = async (...args) => { posts++; return submit(...args); };
      await client.start();
      if (scenario === "interrupted") {
        await eventually(async () => (await client.http.getQueue()).queue_running.some((entry) => queueEntryPromptId(entry) === point.promptId));
        await client.http.interrupt(point.promptId);
      }
      db = openDb(path.join(dir, "crash.db"));
      engine = new Engine(loadConfig({ COMFYUI_URL: url, WORKFLOWS_DIR: path.resolve("workflows/examples"),
        DATA_DIR: dir, OUTPUT_DIR: path.join(dir, "output"), AUTO_SAVE_OUTPUTS: "false" }), client, db);
      await engine.loadWorkflowsAsync();
      const job = engine.store.getJob(point.batchId, 0)!;
      expect(engine.store.getAttempt(job)!.cancel_requested_at).toBe(point.cancelRequestedAt);
      expect(engine.store.getAttempt(job)!.deadline_at).toBe(point.deadlineAt);
      engine.start(); // Product assembly recovers automatically; no test call to recover().
      const expected = scenario === "success" ? "succeeded" : "timeout";
      await eventually(async () => engine!.store.getJob(point.batchId, 0)!.status === expected);
      expect(posts).toBe(1);
      const attempts = engine.store.getAttempts(job.id);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]!.status).toBe(expected);
      expect(attempts[0]!.terminal_confirmed).toBe(1);
      expect(engine.store.getBatch(point.batchId)!.status).toBe(scenario === "success" ? "completed" : "failed");
      const history = await client.http.getHistory(point.promptId);
      expect(history).not.toBeNull();
      if (scenario === "interrupted") {
        expect(history!.status!.status_str).toBe("error");
        expect(history!.status!.messages).toEqual(expect.arrayContaining([expect.arrayContaining(["execution_interrupted"])]));
        expect(engine.store.getJob(point.batchId, 0)!.error_json).toContain("TIMEOUT");
      }
      console.log(JSON.stringify({ scenario, forced_process_termination: true, post_count: posts,
        job: expected, attempt: attempts[0]!.status, batch: engine.store.getBatch(point.batchId)!.status,
        history_status: history!.status!.status_str }));
    } finally {
      if (worker.exitCode === null && worker.signalCode === null) {
        const exited = once(worker, "exit");
        worker.kill("SIGKILL");
        await exited;
      }
      await engine?.stop();
      client.stop();
      db?.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
