import path from "node:path";
import { loadConfig } from "../../src/config.js";
import { openDb } from "../../src/core/storage/db.js";
import { createComfyClient } from "../../src/core/client/index.js";
import { Engine } from "../../src/core/engine.js";

// Independent process: real POST /prompt, then block at the first cancellation
// boundary AFTER SQLite has persisted intent. The parent force-kills this process.
const [url, dir, scenario] = process.argv.slice(2) as [string, string, string];
const config = { ...loadConfig({ COMFYUI_URL: url, DATA_DIR: dir, OUTPUT_DIR: path.join(dir, "output"),
  WORKFLOWS_DIR: path.resolve("workflows/examples"), AUTO_SAVE_OUTPUTS: "false" }), jobTimeoutMs: 50 };
const db = openDb(path.join(dir, "crash.db"));
const client = createComfyClient({ comfyUiUrl: url });
const engine = new Engine(config, client, db);
let posts = 0;
const submit = client.http.submitPrompt.bind(client.http);
client.http.submitPrompt = async (...args) => { posts++; return submit(...args); };
client.http.deleteQueue = async () => {
  const job = engine.store.inFlightJobs()[0]!;
  const attempt = engine.store.getAttempt(job)!;
  process.send!({ stage: "cancel_intent", batchId: job.batch_id, promptId: job.prompt_id,
    cancelRequestedAt: attempt.cancel_requested_at, deadlineAt: attempt.deadline_at, posts, pid: process.pid });
  await new Promise<void>(() => {});
};
await engine.loadWorkflowsAsync();
await client.start();
await engine.runBatch({ workflow: "qwen-image-demo", maxAttempts: scenario === "interrupted" ? 1 : 2,
  runs: [{ params: { prompt: "a small green cube on a white table", width: 512, height: 512,
    steps: scenario === "interrupted" ? 20 : 4, seed: Date.now() % 0xffff_ffff } }] });
