/**
 * 真实 ComfyUI 环境冒烟验证脚本（Task 002 · P1 验收）。
 *
 * 验证项（对应 docs/002 §9 Q1/Q2 与任务书第三节）：
 *   S0 健康检查与版本
 *   S1 /prompt 拒绝路径：node_errors 返回结构
 *   S2 /object_info 关键节点取值（构造测试图）
 *   S3 /prompt 提交成功路径 + WS 事件全录（与 prompt_id 的关联方式）
 *   S4 客户端指定 prompt_id 是否被接受 + 同 id 重复提交行为
 *   S5 /interrupt 按 prompt_id 中断语义（排队态 vs 执行态）+ /queue delete
 *   S6 /history 输出结构（images/gifs/audio 扫描）
 *   S7 WS 断线后经 /history 恢复判定
 *   S8 /view 下载与 ComfyUI 本地 output 目录文件一致性
 *
 * 用法：
 *   COMFYUI_URL=http://127.0.0.1:8188 npm run smoke
 *   COMFYUI_OUTPUT_DIR=<ComfyUI 的 output 目录> 需显式传入（不默认收集本机路径），用于 S8 一致性对照
 *
 * 结果写入 .analysis/smoke-result.json（gitignored）并打印摘要。
 * 本脚本只做验证打点，不实现业务逻辑；全部结论以实际运行为准。
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createComfyClient, type ComfyClient } from "../src/core/client/index.js";
import type { HistoryEntry, ObjectInfoNode, WorkflowGraph } from "../src/core/client/types.js";

const COMFYUI_URL = process.env["COMFYUI_URL"] ?? "http://127.0.0.1:8188";
const COMFYUI_OUTPUT_DIR = process.env["COMFYUI_OUTPUT_DIR"] ?? "";
const RESULT_FILE = path.resolve(".analysis", "smoke-result.json");

interface Check {
  id: string;
  name: string;
  status: "pass" | "fail" | "na";
  detail: string;
  evidence?: unknown;
}
const results: Check[] = [];
const allRawEvents: Array<Record<string, unknown>> = [];

function nowIso(): string {
  return new Date().toISOString();
}

function clip(s: string, n = 400): string {
  return s.length <= n ? s : "..." + s.slice(s.length - n);
}

function j(value: unknown): string {
  try {
    return clip(JSON.stringify(value));
  } catch {
    return "<unserializable>";
  }
}

async function record(id: string, name: string, fn: () => Promise<Omit<Check, "id" | "name">>): Promise<void> {
  try {
    const r = await fn();
    results.push({ id, name, ...r });
    console.log(`[${r.status.toUpperCase()}] ${id} ${name} — ${clip(r.detail, 160)}`);
  } catch (err) {
    const detail = err instanceof Error ? `${err.message}` : String(err);
    results.push({ id, name, status: "fail", detail });
    console.log(`[FAIL] ${id} ${name} — ${clip(detail, 160)}`);
  }
}

async function waitFor(pred: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时(${timeoutMs}ms): ${what}`);
    await sleep(250);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function comboValues(node: ObjectInfoNode, key: string): string[] {
  const spec = node.input?.required?.[key] as unknown;
  if (Array.isArray(spec) && Array.isArray(spec[1])) return spec[1] as string[];
  return [];
}

/** 构造最小可执行图（带 SaveImage 输出） */
function tinyGraph(ckpt: string, sampler: string, scheduler: string, seed: number, prefix: string): WorkflowGraph {
  return {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: ckpt } },
    "2": { class_type: "EmptyLatentImage", inputs: { width: 64, height: 64, batch_size: 1 } },
    "3": { class_type: "CLIPTextEncode", inputs: { text: "smoke test", clip: ["1", 1] } },
    "4": { class_type: "KSampler", inputs: {
      model: ["1", 0], positive: ["3", 0], negative: ["3", 0], latent_image: ["2", 0],
      seed, steps: 3, cfg: 1.0, sampler_name: sampler, scheduler, denoise: 1.0
    } },
    "5": { class_type: "VAEDecode", inputs: { samples: ["4", 0], vae: ["1", 2] } },
    "6": { class_type: "SaveImage", inputs: { filename_prefix: prefix, images: ["5", 0] } }
  };
}

/** 长（足够慢）图，用于中断测试 */
function longGraph(ckpt: string, sampler: string, scheduler: string, seed: number, prefix: string): WorkflowGraph {
  return {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: ckpt } },
    "2": { class_type: "EmptyLatentImage", inputs: { width: 1024, height: 1024, batch_size: 2 } },
    "3": { class_type: "CLIPTextEncode", inputs: { text: "interrupt smoke", clip: ["1", 1] } },
    "4": { class_type: "KSampler", inputs: {
      model: ["1", 0], positive: ["3", 0], negative: ["3", 0], latent_image: ["2", 0],
      seed, steps: 100, cfg: 7.0, sampler_name: sampler, scheduler, denoise: 1.0
    } },
    "5": { class_type: "VAEDecode", inputs: { samples: ["4", 0], vae: ["1", 2] } },
    "6": { class_type: "SaveImage", inputs: { filename_prefix: prefix, images: ["5", 0] } }
  };
}

async function main(): Promise<void> {
  console.log(`smoke target: ${COMFYUI_URL}`);
  console.log(`output dir:   ${COMFYUI_OUTPUT_DIR}\n`);

  const client: ComfyClient = createComfyClient({ comfyUiUrl: COMFYUI_URL });
  client.bus.subscribeAny((raw) => {
    allRawEvents.push({ ...raw, _at: nowIso() });
  });

  await record("S0", "健康检查 /system_stats", async () => {
    const h = await client.http.healthCheck(8000);
    return { status: "pass", detail: `comfyui_version=${h.version}`, evidence: h };
  });
  if (!results[0] || results[0].status === "fail") {
    await finish(); // ComfyUI 未启动，直接结束
    console.error("\nComfyUI 不可达，请先启动后重试（本项目不做自动启动）。");
    process.exitCode = 1;
    return;
  }

  // WS 事件全录在 client.bus.subscribeAny 中
  await record("S0b", "WebSocket 连接", async () => {
    await client.start();
    return { status: "pass", detail: `ws open, clientId=${client.clientId}` };
  });

  let ckpt = "";
  let sampler = "euler";
  let scheduler = "normal";
  await record("S2", "/object_info 构造测试图所需节点", async () => {
    const loaders = await client.http.objectInfo("CheckpointLoaderSimple");
    const loader = loaders["CheckpointLoaderSimple"];
    const ckpts = comboValues(loader ?? {}, "ckpt_name");
    const ks = await client.http.objectInfo("KSampler");
    const ksNode = ks["KSampler"] ?? {};
    const samplers = comboValues(ksNode, "sampler_name");
    const schedulers = comboValues(ksNode, "scheduler");
    ckpt = ckpts[0] ?? "";
    sampler = samplers[0] ?? "euler";
    scheduler = schedulers[0] ?? "normal";
    if (!ckpt) return { status: "na", detail: "环境无 checkpoint，后续依赖图的步骤记 na" };
    return {
      status: "pass",
      detail: `ckpt=${ckpt}（共${ckpts.length}个）; sampler=${sampler}; scheduler=${scheduler}`,
      evidence: { ckptCount: ckpts.length, samplers: samplers.length, schedulers: schedulers.length }
    };
  });

  await record("S1", "/prompt 拒绝路径与 node_errors 结构", async () => {
    const r = await client.http.submitPrompt({ "1": { class_type: "___no_such_node___", inputs: {} } }, { clientId: client.clientId });
    return {
      status: r.ok ? "fail" : "pass",
      detail: `httpStatus=${r.httpStatus}; errorBody=${j(r.errorBody)}; nodeErrors=${j(r.nodeErrors)}`,
      evidence: { httpStatus: r.httpStatus, errorBody: r.errorBody, nodeErrors: r.nodeErrors }
    };
  });

  // S3: 正常提交 + 等 WS 完成 + history 记录
  let s3PromptId = "";
  let s3History: HistoryEntry | null = null;
  await record("S3", "/prompt 成功提交 + WS 事件与 prompt_id 关联", async () => {
    if (!ckpt) return { status: "na", detail: "无 checkpoint" };
    const graph = tinyGraph(ckpt, sampler, scheduler, 20261108, "comfyui-light-mcp-smoke-s3");
    const r = await client.http.submitPrompt(graph, { clientId: client.clientId });
    if (!r.ok) return { status: "fail", detail: `提交被拒: ${j(r)}` };
    s3PromptId = r.promptId;
    await waitFor(
      () => eventFor(s3PromptId).some((e) => ["execution_success", "execution_error", "execution_interrupted"].includes(String(e["type"]))),
      60_000,
      "S3 WS 终态事件"
    );
    s3History = await client.http.getHistory(s3PromptId);
    return { status: "pass", detail: `promptId=${s3PromptId}; history=${s3History ? "有记录" : "无记录"}` };
  });

  await record("S3b", "WS 事件字段形状（prompt_id 关联方式）", async () => {
    const evts = allRawEvents.filter((e) => e["prompt_id"] === s3PromptId || e["type"] === "status");
    const shape = [...new Set(evts.map((e) => String(e["type"])))].map((t) => {
      const sample = evts.find((e) => e["type"] === t)!;
      return { type: t, hasPromptId: "prompt_id" in sample, topKeys: Object.keys(sample).filter((k) => !k.startsWith("_")) };
    });
    return {
      status: s3PromptId && evts.some((e) => e["prompt_id"] === s3PromptId) ? "pass" : "fail",
      detail: `本任务事件类型: ${shape.map((s) => s.type).join(", ")}`,
      evidence: shape
    };
  });

  await record("S4", "客户端指定 prompt_id + 同 id 重复提交", async () => {
    if (!ckpt) return { status: "na", detail: "无 checkpoint" };
    const graph = tinyGraph(ckpt, sampler, scheduler, 999001, "comfyui-light-mcp-smoke-s4");
    const myId = randomUUID();
    const r1 = await client.http.submitPrompt(graph, { clientId: client.clientId, promptId: myId });
    const echo = r1.ok ? r1.promptId : "<rejected>";
    const r2 = await client.http.submitPrompt(graph, { clientId: client.clientId, promptId: myId });
    const echo2 = r2.ok ? r2.promptId : "<rejected>";
    const accepted = r1.ok && echo === myId;
    const dupBehavior = !r2.ok ? "rejected" : echo2 === myId ? "accepted-same-id" : `new-id-assigned(${echo2})`;
    return {
      status: accepted ? "pass" : "fail",
      detail: `指定 id 被回显=${accepted}; 重复提交行为=${dupBehavior}`,
      evidence: { myId, r1, r2PromptId: echo2, dupBehavior }
    };
  });

  await record("S5", "/interrupt 按 prompt_id 语义（排队态/执行态）+ /queue delete", async () => {
    if (!ckpt) return { status: "na", detail: "无 checkpoint" };
    const ga = longGraph(ckpt, sampler, scheduler, 111, "comfyui-light-mcp-smoke-s5a");
    const gb = longGraph(ckpt, sampler, scheduler, 222, "comfyui-light-mcp-smoke-s5b");
    const ra = await client.http.submitPrompt(ga, { clientId: client.clientId });
    const rb = await client.http.submitPrompt(gb, { clientId: client.clientId });
    if (!ra.ok || !rb.ok) return { status: "fail", detail: `长任务提交失败: ${j(ra)}, ${j(rb)}` };
    const a = ra.promptId;
    const b = rb.promptId;
    await sleep(2000); // 等 A 进入 executing、B 留在 queue_pending

    // 1) 中断"排队中"的 B（按 prompt_id）
    await client.http.interrupt(b);
    await sleep(1500);
    const interruptedForB = eventFor(b).some((e) => e["type"] === "execution_interrupted");
    const interruptedForA = eventFor(a).some((e) => e["type"] === "execution_interrupted");
    const q1 = await client.http.getQueue();
    const bStillQueued = [...q1.queue_pending, ...q1.queue_running].some((it) => it[2] === b);

    // 2) 若 B 仍在队列，尝试 POST /queue {delete:[b]}
    let queueDeleteWorked: boolean | null = null;
    if (bStillQueued) {
      const resp = await fetch(`${COMFYUI_URL}/queue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ delete: [b] })
      });
      await sleep(800);
      const q2 = await client.http.getQueue();
      queueDeleteWorked = ![...q2.queue_pending, ...q2.queue_running].some((it) => it[2] === b) && resp.ok;
    }

    // 3) 中断"执行中"的 A（按 prompt_id）
    await client.http.interrupt(a);
    await waitFor(() => eventFor(a).some((e) => e["type"] === "execution_interrupted"), 20_000, "A 的 interrupted 事件");
    const histA = await client.http.getHistory(a);

    // 清理：确保队列清空（防止遗留长任务）
    await fetch(`${COMFYUI_URL}/queue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ delete: [a, b] })
    }).catch(() => undefined);

    return {
      status: "pass",
      detail: `interrupt(排队B): B收到interrupted=${interruptedForB}, A被误伤=${interruptedForA}, B仍在队列=${bStillQueued}; /queue delete B=${queueDeleteWorked}; interrupt(执行A): interrupted事件=已收到`,
      evidence: { a, b, interruptedForB, interruptedForA, bStillQueued, queueDeleteWorked, historyAStatus: histA?.status ?? null }
    };
  });

  await record("S6", "/history 输出结构（images/gifs/audio）", async () => {
    const entry = s3History ?? (s3PromptId ? await client.http.getHistory(s3PromptId) : null);
    if (!entry) return { status: "fail", detail: "S3 无 history 记录" };
    const perNode: Record<string, string[]> = {};
    for (const [nodeId, out] of Object.entries(entry.outputs ?? {})) {
      perNode[nodeId] = Object.keys(out);
      for (const kind of Object.keys(out)) {
        const arr = (out as Record<string, unknown>)[kind];
        if (Array.isArray(arr) && arr.length > 0) {
          perNode[`${nodeId}:${kind}`] = Object.keys(arr[0] as object);
        }
      }
    }
    // 扫最近 100 条历史，统计出现过的输出类型
    const recent = (await fetch(`${COMFYUI_URL}/history?max_items=100`).then((r) => r.json())) as Record<
      string,
      HistoryEntry
    >;
    const kindsSeen = new Set<string>();
    for (const e of Object.values(recent)) {
      for (const out of Object.values(e.outputs ?? {})) {
        for (const k of Object.keys(out)) if (Array.isArray((out as Record<string, unknown>)[k]) && ((out as Record<string, unknown>)[k] as unknown[]).length > 0) kindsSeen.add(k);
      }
    }
    return {
      status: "pass",
      detail: `S3 输出节点结构=${j(perNode)}; 最近${Object.keys(recent).length}条历史出现的输出类型=${[...kindsSeen].join(", ") || "<无>"}`,
      evidence: { perNode, kindsSeen: [...kindsSeen] }
    };
  });

  await record("S7", "WS 断线后经 /history 恢复判定", async () => {
    if (!ckpt) return { status: "na", detail: "无 checkpoint" };
    const graph = tinyGraph(ckpt, sampler, scheduler, 777, "comfyui-light-mcp-smoke-s7");
    const r = await client.http.submitPrompt(graph, { clientId: client.clientId });
    if (!r.ok) return { status: "fail", detail: "提交失败" };
    client.ws.stop(); // 立即断开 WS（事件丢失场景）
    let hist: HistoryEntry | null = null;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      hist = await client.http.getHistory(r.promptId);
      const outputs = hist ? Object.values(hist.outputs ?? {}).some((o) => Object.keys(o).length > 0) : false;
      const statusDone = hist?.status
        ? (() => {
            const s = hist.status as Record<string, unknown>;
            return Boolean(s["completed"]) || String(s["status_str"] ?? "") === "success" || outputs;
          })()
        : false;
      if (outputs || statusDone) break;
      await sleep(1000);
    }
    const ok = Boolean(hist && Object.values(hist.outputs ?? {}).some((o) => Object.keys(o).length > 0));
    return {
      status: ok ? "pass" : "fail",
      detail: `WS 断开后仅靠 GET /history/${clip(r.promptId, 8)} 判定完成=${ok}`,
      evidence: { promptId: r.promptId, outputs: hist ? Object.keys(hist.outputs ?? {}) : null, status: hist?.status }
    };
  });

  await record("S8", "/view 下载与本地 output 目录文件一致性", async () => {
    if (!COMFYUI_OUTPUT_DIR) {
      return { status: "na", detail: "未设置 COMFYUI_OUTPUT_DIR，跳过本地对照（不影响其余验证）" };
    }
    const entry = s3History ?? (s3PromptId ? await client.http.getHistory(s3PromptId) : null);
    const img = entry && Object.values(entry.outputs ?? {}).flatMap((o) => o.images ?? [])[0];
    if (!img) return { status: "na", detail: "S3 无图片输出可对照" };
    const res = await client.http.downloadOutput({ filename: img.filename, subfolder: img.subfolder, type: img.type });
    const buf = Buffer.from(await res.arrayBuffer());
    const dlHash = createHash("sha256").update(buf).digest("hex");
    const localPath = path.join(COMFYUI_OUTPUT_DIR, img.subfolder, img.filename);
    let localHash: string | null = null;
    try {
      const { readFile } = await import("node:fs/promises");
      localHash = createHash("sha256").update(await readFile(localPath)).digest("hex");
    } catch {
      localHash = null;
    }
    return {
      status: localHash && localHash === dlHash ? "pass" : localHash ? "fail" : "na",
      detail: `bytes=${buf.length}; sha256一致=${localHash === dlHash}; 本地文件=${localHash ? "存在" : "未找到"}`,
      evidence: { filename: img.filename, subfolder: img.subfolder, dlHash, localHashMatch: localHash === dlHash }
    };
  });

  client.stop();
  await finish();
}

function eventFor(promptId: string): Array<Record<string, unknown>> {
  return allRawEvents.filter((e) => e["prompt_id"] === promptId);
}

async function finish(): Promise<void> {
  const summary = {
    target: COMFYUI_URL,
    ranAt: nowIso(),
    comfyuiVersion: results.find((r) => r.id === "S0")?.evidence,
    pass: results.filter((r) => r.status === "pass").length,
    fail: results.filter((r) => r.status === "fail").length,
    na: results.filter((r) => r.status === "na").length,
    checks: results,
    wsEventSample: allRawEvents.slice(0, 200)
  };
  await mkdir(path.dirname(RESULT_FILE), { recursive: true });
  await writeFile(RESULT_FILE, JSON.stringify(summary, null, 2), "utf8");
  console.log(`\n结果: pass=${summary.pass} fail=${summary.fail} na=${summary.na}`);
  console.log(`明细: ${RESULT_FILE}`);
}

void main().catch((err) => {
  console.error("smoke 脚本异常退出:", err);
  void finish();
  process.exitCode = 1;
});
