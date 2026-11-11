import { describe, expect, it } from "vitest";
import { readFile, rm, stat, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { loadConfig } from "../../src/config.js";
import { openDb } from "../../src/core/storage/db.js";
import { createComfyClient } from "../../src/core/client/index.js";
import { Engine } from "../../src/core/engine.js";

/**
 * 真实 ComfyUI 端到端测试（Task 003 Part B 验收项）。
 * 前置：COMFYUI_URL 可达（默认 http://127.0.0.1:8188）；不可达时整组跳过（离线环境不误报）。
 * 产物写入 .analysis/e2e-*（gitignored）。
 */

const COMFYUI_URL = process.env["COMFYUI_URL"] ?? "http://127.0.0.1:8188";
const E2E_ROOT = path.resolve(".analysis", "e2e");

// 模块加载期探测（describe.skipIf 需要在收集阶段拿到结果）
let reachable = false;
let comfyuiVersion = "";
try {
  if (process.env["RUN_REAL_COMFYUI_TESTS"] !== "1" || !process.env["COMFYUI_URL"]) throw new Error("Real tests require explicit isolated-backend opt-in and URL");
  const res = await fetch(`${COMFYUI_URL}/system_stats`, { signal: AbortSignal.timeout(4000) });
  if (res.ok) {
    const j = (await res.json()) as { system?: { comfyui_version?: string } };
    reachable = true;
    comfyuiVersion = j.system?.["comfyui_version"] ?? "<unknown>";
  }
} catch {
  reachable = false;
}

describe.skipIf(!reachable)("真实 ComfyUI 文生图端到端", () => {
  it(
    "list → run → 轮询 get_result → 本地图片文件 + 模板零修改",
    { timeout: 300_000 },
    async () => {
      const dataDir = path.join(E2E_ROOT, "data");
      const outDir = path.join(E2E_ROOT, "output");
      await rm(dataDir, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
      await mkdir(dataDir, { recursive: true });

      // 模板快照（执行前后必须零字节差异）
      const wfDir = path.resolve("workflows", "examples");
      const tplFiles = ["qwen-image.json", "qwen-image.manifest.json"];
      const hashesBefore: Record<string, string> = {};
      for (const f of tplFiles) {
        hashesBefore[f] = createHash("sha256").update(await readFile(path.join(wfDir, f))).digest("hex");
      }

      const config = loadConfig({
        COMFYUI_URL,
        WORKFLOWS_DIR: path.resolve("workflows"),
        DATA_DIR: dataDir,
        OUTPUT_DIR: outDir,
        JOB_TIMEOUT_MS: "240000"
      });
      const db = openDb(path.join(dataDir, "e2e.db"));
      const client = createComfyClient({ comfyUiUrl: COMFYUI_URL });
      const engine = new Engine(config, client, db);
      const report = await engine.loadWorkflowsAsync();
      expect(report.errors).toEqual([]);
      expect(report.loaded.some((w) => w.name === "qwen-image-demo")).toBe(true);
      await client.start();
      try {
        // list
        const detail = await engine.listWorkflows("qwen-image-demo") as { params: Array<{ name: string }> };
        expect(detail.params?.length).toBe(8); // Task 004 增 sampler（combo 由 ComfyUI 校验）

        // run（固定 seed 保证可断言）
        const handle = await engine.runSingle({
          workflow: "qwen-image-demo",
          params: { prompt: "a glossy blue sphere on white background", steps: 4, width: 512, height: 512, seed: 20261108 },
          label: "e2e"
        });
        expect(handle.batch_id).toBeTruthy();

        // 轮询至终态（Task 004 起统一走调度管线，含 pending 瞬态）
        const deadline = Date.now() + 240_000;
        let view;
        for (;;) {
          view = await engine.getResult(handle.batch_id, 0);
          if (!["pending", "submitting", "queued", "executing"].includes(view.status)) break;
          if (Date.now() > deadline) throw new Error(`轮询超时，最后状态: ${view.status}`);
          await new Promise((r) => setTimeout(r, 1500));
        }
        expect(view.status).toBe("succeeded");
        expect((view.error as unknown)).toBeNull();

        // 输出：本地绝对路径 + ComfyUI 原始文件名 + 可读文件
        const outputs = view.outputs as Array<{ filename: string; local_path: string; kind: string; bytes: number }>;
        expect(outputs.length).toBeGreaterThanOrEqual(1);
        const img = outputs[0]!;
        expect(img.kind).toBe("image");
        expect(img.filename).toMatch(/^qwen-image-demo_\d{5}_.*\.png$/); // ComfyUI 原始命名（前缀_序号_种子）
        expect(path.isAbsolute(img.local_path)).toBe(true);
        const st = await stat(img.local_path);
        expect(st.size).toBeGreaterThan(1000);
        expect(img.bytes).toBe(st.size);

        // resolved 参数（seed 固定值回写，可复现）
        expect((view.params_resolved as { seed: number }).seed).toBe(20261108);

        // 模板零修改
        for (const f of tplFiles) {
          const h = createHash("sha256").update(await readFile(path.join(wfDir, f))).digest("hex");
          expect(h, `模板被修改: ${f}`).toBe(hashesBefore[f]!);
        }

        console.error(`[e2e] ComfyUI ${comfyuiVersion} → ${img.local_path}`);
      } finally {
        await engine.stop();
        client.stop();
        db.close();
      }
    }
  );

  it("非法参数在提交前被拒（真实注册表上校验）", async () => {
    const config = loadConfig({ COMFYUI_URL, WORKFLOWS_DIR: path.resolve("workflows"), DATA_DIR: path.join(E2E_ROOT, "data2"), OUTPUT_DIR: path.join(E2E_ROOT, "output") });
    await mkdir(path.join(E2E_ROOT, "data2"), { recursive: true });
    const db = openDb(":memory:");
    const client = createComfyClient({ comfyUiUrl: COMFYUI_URL });
    const engine = new Engine(config, client, db);
    await engine.loadWorkflowsAsync();
    await expect(
      engine.runSingle({ workflow: "qwen-image-demo", params: { steps: 9999 } as Record<string, unknown> })
    ).rejects.toThrow(/参数校验失败/);
    db.close();
  });
});
