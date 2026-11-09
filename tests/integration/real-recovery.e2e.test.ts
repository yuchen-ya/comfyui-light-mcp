import { describe, expect, it } from "vitest";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../../src/config.js";
import { openDb } from "../../src/core/storage/db.js";
import { createComfyClient } from "../../src/core/client/index.js";
import { Engine } from "../../src/core/engine.js";

/**
 * Task 005（P4.1）真实 ComfyUI 恢复/版本保护验收：
 * 1. 3 任务批量执行中"崩溃"（销毁 engine/client，仅 SQLite 存活）
 * 2. 用【被修改过的工作流】重启 → 恢复：在途重挂接/对账，剩余 pending 被
 *    WORKFLOW_VERSION_MISMATCH 暂停，多次 tick 也不被静默用新版本提交
 * 3. 用【还原的工作流】再重启 → 恢复 → paused 自动解除续跑 → 全部完成
 * 4. 全程每个 job 恰好 1 行 attempt（多次重启零重复提交）
 * 5. 同 idempotency_key 不同内容 → IDEMPOTENCY_CONFLICT（真实栈）
 * 前置：COMFYUI_URL 可达；不可达整组跳过。产物在 .analysis/e2e-recovery（gitignored）。
 */

const COMFYUI_URL = process.env["COMFYUI_URL"] ?? "http://127.0.0.1:8188";
const ROOT = path.resolve(".analysis", "e2e-recovery");
const DATA_DIR = path.join(ROOT, "data");
const OUT_DIR = path.join(ROOT, "output");
const WF_ORIG = path.join(ROOT, "wf-original");
const WF_MODIFIED = path.join(ROOT, "wf-modified");

let reachable = false;
try {
  const res = await fetch(`${COMFYUI_URL}/system_stats`, { signal: AbortSignal.timeout(4000) });
  reachable = res.ok;
} catch {
  reachable = false;
}

const runOf = (i: number) => ({
  label: `recov-${i}`,
  params: { prompt: `a small colored cube number ${i} on white background`, steps: 4, width: 512, height: 512, seed: 4250000 + i }
});
const RUNS = [runOf(0), runOf(1), runOf(2)];
const IDEMPOTENCY_KEY = "e2e-recovery-p41";

async function prepareDirs(): Promise<void> {
  await rm(ROOT, { recursive: true, force: true });
  await mkdir(DATA_DIR, { recursive: true });
  // 原始工作流副本 + 修改版（KSampler.denoise 不在 manifest 白名单内，改它只影响图指纹）
  for (const dir of [WF_ORIG, WF_MODIFIED]) {
    await mkdir(dir, { recursive: true });
    await cp("workflows/examples/qwen-image.manifest.json", path.join(dir, "qwen-image.manifest.json"));
  }
  const graphText = await readFile("workflows/examples/qwen-image.json", "utf8");
  const graph = JSON.parse(graphText) as Record<string, { inputs: Record<string, unknown> }>;
  await writeFile(path.join(WF_ORIG, "qwen-image.json"), JSON.stringify(graph, null, 1));
  graph["7"]!.inputs["denoise"] = (graph["7"]!.inputs["denoise"] as number) - 0.01; // 内容漂移
  await writeFile(path.join(WF_MODIFIED, "qwen-image.json"), JSON.stringify(graph, null, 1));
}

function makeEngine(workflowsDir: string): { engine: Engine; db: ReturnType<typeof openDb>; client: ReturnType<typeof createComfyClient> } {
  const config = loadConfig({
    COMFYUI_URL,
    WORKFLOWS_DIR: workflowsDir,
    DATA_DIR: DATA_DIR,
    OUTPUT_DIR: OUT_DIR,
    MAX_IN_FLIGHT: "1",
    MAX_QUEUED_JOBS: "1",
    JOB_TIMEOUT_MS: "300000"
  });
  const db = openDb(path.join(DATA_DIR, "batch.db"));
  const client = createComfyClient({ comfyUiUrl: COMFYUI_URL });
  return { engine: new Engine(config, client, db), db, client };
}

describe.skipIf(!reachable)("真实 ComfyUI：恢复 + 工作流版本保护 + 幂等冲突", () => {
  it(
    "崩溃重启（工作流漂移→暂停→还原→续跑），多次重启零重复提交",
    { timeout: 600_000 },
    async () => {
      await prepareDirs();

      // ── 第一段：提交 3 任务，等第 1 个完成后"崩溃"（仅 SQLite 存活） ──
      let ctx = makeEngine(WF_ORIG);
      const report1 = await ctx.engine.loadWorkflowsAsync();
      expect(report1.errors).toEqual([]);
      await ctx.client.start();
      const handle = await ctx.engine.runBatch({ workflow: "qwen-image-demo", runs: RUNS, idempotencyKey: IDEMPOTENCY_KEY });
      expect(handle.reused).toBe(false);
      const waitStatus = async (pred: (stats: Record<string, number>) => boolean, ms: number): Promise<void> => {
        const deadline = Date.now() + ms;
        for (;;) {
          const view = ctx.engine.getBatch(handle.batch_id);
          if (pred(view.stats as unknown as Record<string, number>)) return;
          if (Date.now() > deadline) throw new Error(`等待超时，stats: ${JSON.stringify(view.stats)}`);
          await new Promise((r) => setTimeout(r, 1000));
        }
      };
      await waitStatus((s) => s["succeeded"]! >= 1 && s["running"]! + s["queued"]! >= 1, 300_000); // job0 完成 + job1 已在途
      await ctx.engine.stop();
      ctx.client.stop();
      ctx.db.close(); // 崩溃：进程内对象全部销毁

      // ── 第二段：被修改的工作流重启 → 恢复：在途对账 + pending 暂停 ──
      ctx = makeEngine(WF_MODIFIED);
      const report2 = await ctx.engine.loadWorkflowsAsync();
      expect(report2.errors).toEqual([]);
      await ctx.client.start();
      const rec2 = await ctx.engine.recover();
      ctx.engine.start(); // 调度器开跑：若版本保护失效，pending 会被（错误地）提交
      expect(rec2.pausedOnVersionMismatch).toBeGreaterThanOrEqual(1); // 至少 job2 被暂停
      await new Promise((r) => setTimeout(r, 4000)); // 多个 tick 走过
      const viewPaused = ctx.engine.getBatch(handle.batch_id);
      const paused = viewPaused.jobs.filter((j) => j.status === "paused");
      expect(paused.length).toBeGreaterThanOrEqual(1);
      expect(paused.every((j) => j.error?.code === "WORKFLOW_VERSION_MISMATCH")).toBe(true);
      // 暂停的 job 从未被提交（无 prompt_id、无 attempt）——没有静默用新版本续跑
      for (const j of paused) {
        const result = await ctx.engine.getResult(handle.batch_id, j.index);
        expect(result.params_resolved).toBeNull();
      }
      // job1（崩溃时在途）：重挂接后由真实事件/轮询自然定终态（不重提）；
      // 终态或暂停二者其一到位即收敛（崩溃点与 tick 时序不放大断言粒度）
      await waitStatus(
        (s) => s["succeeded"]! + s["failed"]! + s["paused"]! >= 3 && s["running"]! + s["queued"]! === 0,
        300_000
      );
      await ctx.engine.stop();
      ctx.client.stop();
      ctx.db.close();

      // ── 第三段：还原的工作流再重启 → paused 解除续跑 → 全部完成 ──
      ctx = makeEngine(WF_ORIG);
      const report3 = await ctx.engine.loadWorkflowsAsync();
      expect(report3.errors).toEqual([]);
      await ctx.client.start();
      const rec3 = await ctx.engine.recover();
      expect(rec3.pausedOnVersionMismatch).toBe(0); // 指纹一致，不再新暂停
      ctx.engine.start();
      await waitStatus((s) => s["succeeded"]! + s["failed"]! >= 3, 300_000);
      const finalView = ctx.engine.getBatch(handle.batch_id);
      expect(finalView.status).toBe("completed"); // 3/3 成功（真实 512px 生成）
      expect(finalView.stats).toMatchObject({ total: 3, succeeded: 3, failed: 0, paused: 0, unknown: 0 });

      // ── 多次重启零重复提交：每个 job 恰好 1 行 attempt ──
      for (let i = 0; i < 3; i++) {
        const job = ctx.engine.store.getJob(handle.batch_id, i)!;
        const attempts = ctx.engine.store.getAttempts(job.id);
        expect(attempts, `job${i}`).toHaveLength(1);
        expect(attempts[0]!.status).toBe("succeeded");
      }
      const promptIds = new Set<string>();
      for (let i = 0; i < 3; i++) promptIds.add(ctx.engine.store.getJob(handle.batch_id, i)!.prompt_id!);
      expect(promptIds.size).toBe(3);

      // ── 幂等冲突（真实栈）：同键不同内容 → IDEMPOTENCY_CONFLICT ──
      await expect(
        ctx.engine.runBatch({ workflow: "qwen-image-demo", runs: [RUNS[0]!, { ...runOf(9) }], idempotencyKey: IDEMPOTENCY_KEY })
      ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
      // 同键同内容 → 仍然复用
      const reused = await ctx.engine.runBatch({ workflow: "qwen-image-demo", runs: RUNS, idempotencyKey: IDEMPOTENCY_KEY });
      expect(reused.reused).toBe(true);
      expect(reused.batch_id).toBe(handle.batch_id);
      expect(ctx.engine.store.countJobs(handle.batch_id)).toBe(3); // 无新增

      await ctx.engine.stop();
      ctx.client.stop();
      ctx.db.close();
    }
  );
});
