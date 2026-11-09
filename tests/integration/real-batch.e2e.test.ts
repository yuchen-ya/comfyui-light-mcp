import { describe, expect, it } from "vitest";
import { rm, stat, mkdir } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../../src/config.js";
import { openDb } from "../../src/core/storage/db.js";
import { createComfyClient } from "../../src/core/client/index.js";
import { Engine } from "../../src/core/engine.js";

/**
 * Task 004 §八 真实环境批量验收（ComfyUI 0.41.0）：
 * 10 任务批量（7 合法 + 2 非法 combo 值 + 1 manifest 前置拒绝）：
 * - 合法任务正常完成、输出文件真实存在、seed 与任务一一对应
 * - 非法 combo → ComfyUI 拒绝 → failed + 归一化 node_errors（§七真实验证）
 * - manifest 非法 → invalid 独立记录
 * - get_batch 统计准确（unknown 单列）
 * - 同 idempotency_key 重复调用不产生重复提交/生成
 * 前置：COMFYUI_URL 可达；不可达整组跳过。产物写入 .analysis/e2e-batch-*（gitignored）。
 */

const COMFYUI_URL = process.env["COMFYUI_URL"] ?? "http://127.0.0.1:8188";
const E2E_ROOT = path.resolve(".analysis", "e2e-batch");

let reachable = false;
let comfyuiVersion = "";
try {
  const res = await fetch(`${COMFYUI_URL}/system_stats`, { signal: AbortSignal.timeout(4000) });
  if (res.ok) {
    const j = (await res.json()) as { system?: { comfyui_version?: string } };
    reachable = true;
    comfyuiVersion = j.system?.["comfyui_version"] ?? "<unknown>";
  }
} catch {
  reachable = false;
}

/** 7 个合法任务：固定 seed 便于一一对应断言 */
const validRuns = Array.from({ length: 7 }, (_, i) => ({
  label: `ok-${String(i + 1).padStart(2, "0")}`,
  params: {
    prompt: `a single colored sphere number ${i + 1} on white background, minimal`,
    steps: 4,
    width: 512,
    height: 512,
    seed: 4242000 + i // 4242000..4242006
  }
}));

const runs = [
  validRuns[0]!,
  // 非法 combo：manifest 声明 sampler 为普通 string（放行）→ ComfyUI 校验拒绝（node_errors 路径）
  { label: "bad-combo-1", params: { prompt: "x", steps: 4, seed: 1, sampler: "euler_NOT_EXIST" } },
  validRuns[1]!,
  { label: "bad-combo-2", params: { prompt: "x", steps: 4, seed: 2, sampler: "also_bogus_sampler" } },
  validRuns[2]!,
  // manifest 前置拒绝：steps 越界（不会到达 ComfyUI）
  { label: "bad-manifest", params: { prompt: "x", steps: 9999 } },
  validRuns[3]!,
  validRuns[4]!,
  validRuns[5]!,
  validRuns[6]!
];

describe.skipIf(!reachable)(`真实 ComfyUI 批量执行（${runs.length} 任务）`, () => {
  it(
    "10 任务批量：统计准确 / 非法独立记录 / seed 对应 / 文件存在 / 幂等不重复",
    { timeout: 1_800_000 },
    async () => {
      const dataDir = path.join(E2E_ROOT, "data");
      const outDir = path.join(E2E_ROOT, "output");
      await rm(dataDir, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
      await mkdir(dataDir, { recursive: true });

      const config = loadConfig({
        COMFYUI_URL,
        WORKFLOWS_DIR: path.resolve("workflows"),
        DATA_DIR: dataDir,
        OUTPUT_DIR: outDir,
        MAX_IN_FLIGHT: "1",
        MAX_QUEUED_JOBS: "1",
        JOB_TIMEOUT_MS: "300000"
      });
      const db = openDb(path.join(dataDir, "batch.db"));
      const client = createComfyClient({ comfyUiUrl: COMFYUI_URL });
      const engine = new Engine(config, client, db);
      const report = await engine.loadWorkflowsAsync();
      expect(report.errors).toEqual([]);
      await client.start();
      try {
        engine.start();
        const handle = await engine.runBatch({
          workflow: "qwen-image-demo",
          runs,
          idempotencyKey: "e2e-batch-10"
        });
        expect(handle.total).toBe(10);
        expect(handle.invalid).toBe(1); // manifest 前置拒绝 1 个
        expect(handle.reused).toBe(false);

        // 轮询 batch 至收敛（默认串行 1/1，7 次真实生成）
        const deadline = Date.now() + 1_700_000;
        let view = engine.getBatch(handle.batch_id);
        while (view.status === "running") {
          if (Date.now() > deadline) throw new Error(`批量轮询超时，stats: ${JSON.stringify(view.stats)}`);
          await new Promise((r) => setTimeout(r, 3000));
          view = engine.getBatch(handle.batch_id);
        }

        // —— 统计准确（unknown 单列，绝不混入 failed）——
        expect(view.status).toBe("partial"); // 7 成功 + 2 ComfyUI 拒绝 + 1 invalid
        expect(view.stats).toEqual({
          total: 10,
          succeeded: 7,
          failed: 2,
          running: 0,
          queued: 0,
          pending: 0,
          invalid: 1,
          unknown: 0,
          paused: 0
        });

        // —— 非法 combo → failed + 归一化 node_errors（§七真实结构）——
        for (const idx of [1, 3]) {
          const result = await engine.getResult(handle.batch_id, idx);
          expect(result.status).toBe("failed");
          const err = result.error as {
            code: string;
            node_errors?: Array<{ node: string; input: string; type: string; received_value: string }>;
          };
          expect(err.code).toBe("COMFY_REJECTED");
          expect(err.node_errors).toEqual([
            expect.objectContaining({
              node: "7",
              input: "sampler_name",
              type: "value_not_in_list",
              received_value: runs[idx]!.params["sampler"]
            })
          ]);
        }

        // —— manifest 非法 → invalid 独立记录（未到达 ComfyUI；位于 idx 5）——
        const invalidResult = await engine.getResult(handle.batch_id, 5);
        expect(invalidResult.status).toBe("invalid");
        expect((invalidResult.error as { code: string }).code).toBe("INVALID_PARAMS");

        // —— 合法任务：seed 对应 + 输出文件真实存在 + 本地绝对路径 ——
        for (let i = 0; i < 7; i++) {
          const idx = [0, 2, 4, 6, 7, 8, 9][i]!;
          const result = await engine.getResult(handle.batch_id, idx);
          expect(result.status, `idx=${idx}`).toBe("succeeded");
          expect((result.params_resolved as { seed: number }).seed).toBe(4242000 + i); // seed 与任务一一对应
          const outputs = result.outputs as Array<{ kind: string; local_path: string; bytes: number; filename: string }>;
          expect(outputs.length).toBeGreaterThanOrEqual(1);
          expect(outputs[0]!.kind).toBe("image");
          expect(path.isAbsolute(outputs[0]!.local_path)).toBe(true);
          const st = await stat(outputs[0]!.local_path);
          expect(st.size).toBe(outputs[0]!.bytes);
          expect(st.size).toBeGreaterThan(1000);
          expect(outputs[0]!.filename).toMatch(/^qwen-image-demo_\d{5}_.*\.png$/); // ComfyUI 原始文件名
        }

        // —— 幂等：同 key 重复调用 → 同一 batch、无新增 job、无重复生成 ——
        const again = await engine.runBatch({
          workflow: "qwen-image-demo",
          runs,
          idempotencyKey: "e2e-batch-10"
        });
        expect(again.reused).toBe(true);
        expect(again.batch_id).toBe(handle.batch_id);
        expect(again.total).toBe(10);
        expect(engine.store.countJobs(handle.batch_id)).toBe(10); // 未新增任何 job
        expect(engine.getBatch(handle.batch_id).stats.succeeded).toBe(7); // 无重复生成

        // —— 分页与状态过滤（真实数据上）——
        const failedPage = engine.getBatch(handle.batch_id, { status: "failed" });
        expect(failedPage.jobs.map((j) => j.index)).toEqual([1, 3]);
        const page = engine.getBatch(handle.batch_id, { limit: 4, offset: 8 });
        expect(page.jobs.map((j) => j.index)).toEqual([8, 9]);
        expect(page.next_offset).toBeNull();

        console.error(`[e2e-batch] ComfyUI ${comfyuiVersion} → 7 张图片至 ${outDir}（串行双窗口 1/1）`);
      } finally {
        await engine.stop();
        client.stop();
        db.close();
      }
    }
  );
});
