/**
 * 真实 ComfyUI 环境冒烟验证脚本（Task 002 · P1 验收）。
 *
 * 验证项（对应 docs/002 §9 Q1/Q2 与任务书第三节）：
 *   S0 健康检查与版本 + WS 连接
 *   S1 /prompt 拒绝路径：error / node_errors 返回结构
 *   S2 模型三件套发现（UNETLoader/CLIPLoader/VAELoader），构造可执行测试图
 *   S3 /prompt 提交成功 + WS 事件全录（prompt_id 关联位置）
 *   S4 客户端指定 prompt_id 是否被接受 + 同 id 重复提交行为
 *   S5 /interrupt 按 prompt_id 中断语义（排队态 vs 执行态）+ /queue delete
 *   S6 /history 输出结构（images/gifs/audio 扫描）
 *   S7 WS 断线后经 /history 恢复判定（含 error 终态判定）
 *   S8 /view 下载与 ComfyUI 本地 output 目录文件 sha256 一致性
 *
 * 用法：
 *   COMFYUI_URL=http://127.0.0.1:8188 npm run smoke
 *   COMFYUI_OUTPUT_DIR=<ComfyUI 的 output 目录> 需显式传入（不默认收集本机路径），用于 S8 一致性对照
 *
 * 结果写入 .analysis/smoke-result.json（gitignored）并打印摘要。
 * 已实测环境：ComfyUI 0.41.0（详见 ComfyUI API contract）。
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createComfyClient, type ComfyClient } from "../src/core/client/index.js";
import { promptIdOf } from "../src/core/client/event-bus.js";
import { queueEntryPromptId } from "../src/core/client/types.js";
import type { HistoryEntry, ObjectInfoNode, WorkflowGraph } from "../src/core/client/types.js";

const COMFYUI_URL = process.env["COMFYUI_URL"] ?? "http://127.0.0.1:8188";
if (process.env["RUN_REAL_COMFYUI_TESTS"] !== "1" || !process.env["COMFYUI_URL"]) {
  throw new Error("Set RUN_REAL_COMFYUI_TESTS=1 and an explicit COMFYUI_URL for an isolated test backend; smoke can submit and interrupt jobs.");
}
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

/** 兼容 0.41（data.prompt_id）与旧版（顶层）两种事件形态的取值 */
function comboValues(node: ObjectInfoNode, key: string): string[] {
  const spec = node.input?.required?.[key] as unknown;
  if (!Array.isArray(spec)) return [];
  // 实测两种 combo 规格（ComfyUI API contract）：旧版 [类型名, 值数组]；0.41 [值数组, 配置对象]
  if (Array.isArray(spec[0])) return spec[0].filter((v): v is string => typeof v === "string");
  if (Array.isArray(spec[1])) return spec[1].filter((v): v is string => typeof v === "string");
  return [];
}

/** Qwen-Image 三件套（unet/clip/vae 分体加载），本机实测可用组合 */
interface ModelTriple {
  unet: string;
  clip: string;
  clipType: string;
  vae: string;
}

/** Qwen-Image 2.1 图：unet+clip+vae 分体加载，SD3 空潜空间 */
function qwenGraph(t: ModelTriple, sampler: string, scheduler: string, opts: {
  width: number; height: number; steps: number; seed: number; prefix: string;
}): WorkflowGraph {
  return {
    "1": { class_type: "UNETLoader", inputs: { unet_name: t.unet, weight_dtype: "default" } },
    "2": { class_type: "CLIPLoader", inputs: { clip_name: t.clip, type: t.clipType } },
    "3": { class_type: "VAELoader", inputs: { vae_name: t.vae } },
    "4": { class_type: "CLIPTextEncode", inputs: { text: "a tiny red cube on white background, minimal", clip: ["2", 0] } },
    "5": { class_type: "CLIPTextEncode", inputs: { text: "blurry, low quality", clip: ["2", 0] } },
    "6": { class_type: "EmptySD3LatentImage", inputs: { width: opts.width, height: opts.height, batch_size: 1 } },
    "7": { class_type: "KSampler", inputs: {
      model: ["1", 0], positive: ["4", 0], negative: ["5", 0], latent_image: ["6", 0],
      seed: opts.seed, steps: opts.steps, cfg: 2.5, sampler_name: sampler, scheduler, denoise: 1.0
    } },
    "8": { class_type: "VAEDecode", inputs: { samples: ["7", 0], vae: ["3", 0] } },
    "9": { class_type: "SaveImage", inputs: { filename_prefix: opts.prefix, images: ["8", 0] } }
  };
}

async function main(): Promise<void> {
  console.log(`smoke target: ${COMFYUI_URL}`);
  console.log(`output dir:   ${COMFYUI_OUTPUT_DIR || "<未设置，S8 将跳过>"}\n`);

  const client: ComfyClient = createComfyClient({ comfyUiUrl: COMFYUI_URL });
  client.bus.subscribeAny((raw) => {
    allRawEvents.push({ ...raw, _at: nowIso() });
  });

  await record("S0", "健康检查 /system_stats", async () => {
    const h = await client.http.healthCheck(8000);
    return { status: "pass", detail: `comfyui_version=${h.version}`, evidence: h };
  });
  if (!results[0] || results[0].status === "fail") {
    await finish();
    console.error("\nComfyUI 不可达，请先启动后重试（本项目不做自动启动）。");
    process.exitCode = 1;
    return;
  }

  await record("S0b", "WebSocket 连接", async () => {
    await client.start();
    return { status: "pass", detail: `ws open, clientId=${client.clientId}` };
  });

  let triple: ModelTriple | null = null;
  let sampler = "euler";
  let scheduler = "simple";
  await record("S2", "模型三件套发现与 KSampler 取值", async () => {
    const ks = await client.http.objectInfo("KSampler");
    const ksNode = ks["KSampler"] ?? {};
    const samplers = comboValues(ksNode, "sampler_name");
    const schedulers = comboValues(ksNode, "scheduler");
    sampler = samplers[0] ?? "euler";
    scheduler = schedulers[0] ?? "simple";

    const [unetNode, clipNode, vaeNode] = await Promise.all([
      client.http.objectInfo("UNETLoader"),
      client.http.objectInfo("CLIPLoader"),
      client.http.objectInfo("VAELoader")
    ]);
    const unets = comboValues(unetNode["UNETLoader"] ?? {}, "unet_name");
    const clips = comboValues(clipNode["CLIPLoader"] ?? {}, "clip_name");
    const vaes = comboValues(vaeNode["VAELoader"] ?? {}, "vae_name");

    // 优先 Qwen-Image 组合；clip 必须与 unet 的 conditioning 维度匹配（实测 4b=2560 维不匹配 2.1 的 4096 维）
    const qUnet = unets.find((u) => u.includes("qwen_image"));
    const clipPrefs = [/qwen3vl_8b/, /qwen3vl_32b/, /qwen3vl_\d+b/, /qwen/];
    let qClip: string | undefined;
    for (const pref of clipPrefs) {
      qClip = clips.find((c) => pref.test(c));
      if (qClip) break;
    }
    const qVae = vaes.find((v) => v.includes("qwen_image"));
    if (qUnet && qClip && qVae) {
      triple = { unet: qUnet, clip: qClip, clipType: "qwen_image", vae: qVae };
    }
    return {
      status: triple ? "pass" : "na",
      detail: triple
        ? `三件套: unet=${triple.unet}; clip=${triple.clip}(${triple.clipType}); vae=${triple.vae}; sampler=${sampler}/${scheduler}`
        : `未发现可用三件套（unets=${unets.length}, clips=${clips.length}, vaes=${vaes.length}）`,
      evidence: { unets: unets.length, clips: clips.length, vaes: vaes.length, triple }
    };
  });

  await record("S1", "/prompt 拒绝路径与 node_errors 结构", async () => {
    const r = await client.http.submitPrompt(
      { "1": { class_type: "___no_such_node___", inputs: {} } },
      { clientId: client.clientId }
    );
    return {
      status: r.ok ? "fail" : "pass",
      detail: `httpStatus=${r.httpStatus}; errorBody=${j(r.errorBody)}; nodeErrors=${j(r.nodeErrors)}`,
      evidence: { httpStatus: r.httpStatus, errorBody: r.errorBody, nodeErrors: r.nodeErrors }
    };
  });

  const tiny = (): WorkflowGraph | null =>
    triple ? qwenGraph(triple, sampler, scheduler, { width: 512, height: 512, steps: 4, seed: 20261108, prefix: "comfyui-light-mcp-smoke-s3" }) : null;

  // S3: 正常提交 + 等 WS 终态 + history 记录（首次含模型加载，宽限 240s）
  let s3PromptId = "";
  let s3History: HistoryEntry | null = null;
  await record("S3", "/prompt 成功提交 + WS 事件与 prompt_id 关联", async () => {
    const graph = tiny();
    if (!graph) return { status: "na", detail: "无可用模型三件套" };
    const r = await client.http.submitPrompt(graph, { clientId: client.clientId });
    if (!r.ok) return { status: "fail", detail: `提交被拒: ${j(r)}` };
    s3PromptId = r.promptId;
    await waitFor(
      () => eventFor(s3PromptId).some((e) =>
        ["execution_success", "execution_error", "execution_interrupted"].includes(String(e["type"]))
      ),
      240_000,
      "S3 WS 终态事件"
    );
    s3History = await client.http.getHistory(s3PromptId);
    const terminalEvent = eventFor(s3PromptId).find((e) =>
      ["execution_success", "execution_error", "execution_interrupted"].includes(String(e["type"]))
    );
    const statusStr = String((s3History?.status as Record<string, unknown>)?.["status_str"] ?? "<无>");
    const outCount = Object.values(s3History?.outputs ?? {}).flatMap((o) => o.images ?? []).length;
    const ok =
      terminalEvent?.["type"] === "execution_success" && statusStr === "success" && outCount >= 1;
    return {
      status: ok ? "pass" : "fail",
      detail: `终态事件=${terminalEvent?.["type"]}; history status_str=${statusStr}; 图片输出=${outCount}${ok ? "" : "（三者须同时满足：execution_success + success + ≥1 输出）"}`,
      evidence: { promptId: s3PromptId, terminalEvent: terminalEvent?.["type"], statusStr, outCount }
    };
  });

  await record("S3b", "WS 事件字段形状（prompt_id 关联位置）", async () => {
    const evts = allRawEvents.filter((e) => promptIdOf(e as never) === s3PromptId);
    const shape = [...new Set(evts.map((e) => String(e["type"])))].map((t) => {
      const sample = evts.find((e) => e["type"] === t)!;
      const inData = sample["data"] !== undefined && "prompt_id" in (sample["data"] as object);
      return { type: t, promptIdInData: inData, promptIdOnTop: "prompt_id" in sample };
    });
    return {
      status: s3PromptId && evts.length > 0 ? "pass" : "fail",
      detail: `本任务事件类型(${evts.length}条): ${shape.map((s) => s.type).join(", ")}`,
      evidence: shape
    };
  });

  await record("S4", "客户端指定 prompt_id + 同 id 重复提交行为", async () => {
    const graph = tiny();
    if (!graph) return { status: "na", detail: "无可用模型三件套" };
    const myId = randomUUID();
    const r1 = await client.http.submitPrompt(graph, { clientId: client.clientId, promptId: myId });
    const echo = r1.ok ? r1.promptId : "<rejected>";
    const r2 = await client.http.submitPrompt(graph, { clientId: client.clientId, promptId: myId });
    const echo2 = r2.ok ? r2.promptId : "<rejected>";
    const accepted = r1.ok && echo === myId;
    // 等待两次提交全部执行完毕，用 execution_start 计数验证是否重复执行
    await waitFor(
      () => eventFor(myId).filter((e) => e["type"] === "execution_start").length >= 2,
      240_000,
      "同 id 两次执行开始"
    );
    await waitFor(
      () => eventFor(myId).filter((e) => e["type"] === "execution_success").length >= 2,
      240_000,
      "同 id 两次执行成功"
    );
    const starts = eventFor(myId).filter((e) => e["type"] === "execution_start").length;
    const dupBehavior = !r2.ok ? "rejected" : echo2 === myId ? "accepted-same-id" : `new-id-assigned(${echo2})`;
    return {
      status: accepted && starts === 2 ? "pass" : "fail",
      detail: `指定 id 被回显=${accepted}; 重复提交=${dupBehavior}; 实际执行次数=${starts}（=2 表示无执行级去重，history 键覆盖会掩盖）`,
      evidence: { myId, r1Echo: echo, r2Echo: echo2, dupBehavior, executionStartCount: starts }
    };
  });

  await record("S5", "/interrupt 按 prompt_id 语义（排队态/执行态）+ /queue delete", async () => {
    if (!triple) return { status: "na", detail: "无可用模型三件套" };
    const g = (seed: number, tag: string): WorkflowGraph =>
      qwenGraph(triple!, sampler, scheduler, { width: 1024, height: 1024, steps: 40, seed, prefix: `comfyui-light-mcp-smoke-s5${tag}` });
    const ra = await client.http.submitPrompt(g(111, "a"), { clientId: client.clientId });
    const rb = await client.http.submitPrompt(g(222, "b"), { clientId: client.clientId });
    if (!ra.ok || !rb.ok) return { status: "fail", detail: `长任务提交失败: ${j(ra)}, ${j(rb)}` };
    const a = ra.promptId;
    const b = rb.promptId;

    // 前置断言：A 正在执行、B 仍在排队
    await waitFor(() => eventFor(a).some((e) => e["type"] === "executing"), 120_000, "A 开始执行");
    const q0 = await client.http.getQueue();
    const bQueuedBefore = q0.queue_pending.some((it) => queueEntryPromptId(it) === b);

    // 1) 中断"排队中"的 B（按 prompt_id）
    await client.http.interrupt(b);
    await sleep(2000);
    const q1 = await client.http.getQueue();
    const bRemovedFromQueue = ![...q1.queue_pending, ...q1.queue_running].some((it) => queueEntryPromptId(it) === b);
    const interruptedForB = eventFor(b).some((e) => e["type"] === "execution_interrupted");
    // 不误伤断言：此刻 A 必须仍未收到 interrupted（继续执行中）
    const aNotHurt = !eventFor(a).some((e) => e["type"] === "execution_interrupted");
    const aStillRunning =
      eventFor(a).some((e) => e["type"] === "progress" || e["type"] === "progress_state" || e["type"] === "executing") && aNotHurt;

    // 2) 真实语义（ComfyUI API contract F5 修正）：interrupt 对排队任务是 no-op——B 应仍在队列；
    //    取消排队任务的正确方式是 POST /queue {delete:[b]}，此处验证之
    let queueDeleteWorked: boolean | null = null;
    const queuedInterruptIsNoop = !bRemovedFromQueue; // B 仍在队列 = interrupt(排队) 为 no-op
    if (queuedInterruptIsNoop) {
      const resp = await fetch(`${COMFYUI_URL}/queue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ delete: [b] })
      });
      await sleep(800);
      const q2 = await client.http.getQueue();
      queueDeleteWorked = resp.ok && ![...q2.queue_pending, ...q2.queue_running].some((it) => queueEntryPromptId(it) === b);
    }

    // 3) 中断"执行中"的 A（按 prompt_id）——必须真正收到 interrupted 事件
    await client.http.interrupt(a);
    await waitFor(() => eventFor(a).some((e) => e["type"] === "execution_interrupted"), 20_000, "A 的 interrupted 事件");
    const aInterrupted = eventFor(a).some((e) => e["type"] === "execution_interrupted");
    const histA = await client.http.getHistory(a);
    const histATerminal = String((histA?.status as Record<string, unknown>)?.["status_str"] ?? "<无>");

    // 清理：确保队列清空（防止遗留长任务）
    await fetch(`${COMFYUI_URL}/queue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ delete: [a, b] })
    }).catch(() => undefined);

    const ok =
      bQueuedBefore && queuedInterruptIsNoop && queueDeleteWorked === true &&
      aNotHurt && aStillRunning && aInterrupted;
    return {
      status: ok ? "pass" : "fail",
      detail: `前置(B在队列)=${bQueuedBefore}; interrupt(排队B)=no-op（B仍在队列=${queuedInterruptIsNoop}，无事件=${interruptedForB}，不误伤A=${aNotHurt && aStillRunning}）; /queue delete B=${queueDeleteWorked}; interrupt(执行A): interrupted=${aInterrupted}, history终态=${histATerminal}`,
      evidence: { a, b, bQueuedBefore, queuedInterruptIsNoop, interruptedForB, aNotHurt, aStillRunning, queueDeleteWorked, aInterrupted, historyATerminal: histATerminal }
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
    const recent = (await fetch(`${COMFYUI_URL}/history?max_items=100`).then((r) => r.json())) as Record<
      string,
      HistoryEntry
    >;
    const kindsSeen = new Set<string>();
    for (const e of Object.values(recent)) {
      for (const out of Object.values(e.outputs ?? {})) {
        for (const k of Object.keys(out)) {
          const arr = (out as Record<string, unknown>)[k];
          if (Array.isArray(arr) && arr.length > 0) kindsSeen.add(k);
        }
      }
    }
    return {
      status: "pass",
      detail: `S3 输出节点结构=${j(perNode)}; 最近${Object.keys(recent).length}条历史出现的输出类型=${[...kindsSeen].join(", ") || "<无>"}`,
      evidence: { perNode, kindsSeen: [...kindsSeen] }
    };
  });

  await record("S7", "WS 断线后经 /history 恢复判定", async () => {
    const graph = tiny();
    if (!graph) return { status: "na", detail: "无可用模型三件套" };
    const r = await client.http.submitPrompt(graph, { clientId: client.clientId });
    if (!r.ok) return { status: "fail", detail: "提交失败" };
    client.ws.stop(); // 立即断开 WS（事件丢失场景）
    let hist: HistoryEntry | null = null;
    let outcome = "未判定";
    const deadline = Date.now() + 240_000;
    while (Date.now() < deadline) {
      hist = await client.http.getHistory(r.promptId);
      if (hist?.status) {
        const s = hist.status as Record<string, unknown>;
        const str = String(s["status_str"] ?? "");
        const outputs = Object.values(hist.outputs ?? {}).some((o) => Object.keys(o).length > 0);
        if (str === "success" || s["completed"] === true || outputs) {
          outcome = outputs ? "完成且有输出" : `终态=${str}`;
          break;
        }
        if (str === "error" || str === "interrupted") {
          outcome = `终态=${str}（可判定，无需 WS）`;
          break;
        }
      }
      await sleep(1000);
    }
    return {
      status: outcome !== "未判定" ? "pass" : "fail",
      detail: `WS 断开后仅靠 GET /history 判定: ${outcome}`,
      evidence: { promptId: r.promptId, outcome, status: hist?.status ?? null, outputs: hist ? Object.keys(hist.outputs ?? {}) : null }
    };
  });

  await record("S8", "/view 下载与本地 output 目录文件一致性", async () => {
    if (!COMFYUI_OUTPUT_DIR) {
      return { status: "na", detail: "未设置 COMFYUI_OUTPUT_DIR，跳过本地对照（不影响其余验证）" };
    }
    const entry = s3History ?? (s3PromptId ? await client.http.getHistory(s3PromptId) : null);
    const img =
      entry && Object.values(entry.outputs ?? {}).flatMap((o) => o.images ?? [])[0];
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
  return allRawEvents.filter((e) => promptIdOf(e as never) === promptId);
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
    wsEventSample: allRawEvents.slice(0, 500)
  };
  await mkdir(path.dirname(RESULT_FILE), { recursive: true });
  await writeFile(RESULT_FILE, JSON.stringify(summary, null, 2), "utf8");
  console.log(`\n结果: pass=${summary.pass} fail=${summary.fail} na=${summary.na}`);
  console.log(`明细: ${RESULT_FILE}`);
  if (summary.fail > 0) process.exitCode = 1; // 有 fail 必须非零退出（禁止无条件 pass）
}

void main().catch((err) => {
  console.error("smoke 脚本异常退出:", err);
  void finish();
  process.exitCode = 1;
});
