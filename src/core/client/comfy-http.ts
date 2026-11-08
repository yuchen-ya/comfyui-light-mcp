import { ComfyLightError, toComfyUnreachable } from "../../shared/errors.js";
import { clipTail } from "../../shared/truncate.js";
import type {
  HistoryEntry,
  NodeErrors,
  ObjectInfoNode,
  OutputRef,
  QueueInfo,
  SubmitResult,
  SystemStats,
  WorkflowGraph
} from "./types.js";

/**
 * ComfyUI HTTP 客户端（原生 fetch，无 axios）。
 * 端点清单参考 MetaBrain-Labs/ComfyUI-MCP-Server-TypeScript (MIT) commit 765c713 的 src/api/api.ts 改编。
 * 所有响应结构以真实环境验证为准（docs/003）。
 */

export interface ComfyHttpOptions {
  baseUrl: string; // 如 http://127.0.0.1:8188
  fetchImpl?: typeof fetch;
  timeoutMs?: number; // 单请求默认超时
}

export class ComfyHttp {
  private readonly base: string;
  private readonly doFetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: ComfyHttpOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, "");
    this.doFetch = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    init?: { body?: string; timeoutMs?: number }
  ): Promise<Response> {
    const url = `${this.base}${path}`;
    let res: Response;
    try {
      res = await this.doFetch(url, {
        method,
        headers: init?.body !== undefined ? { "Content-Type": "application/json" } : undefined,
        body: init?.body,
        signal: AbortSignal.timeout(init?.timeoutMs ?? this.timeoutMs)
      });
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new ComfyLightError("TIMEOUT", `请求超时: ${method} ${url}`, { method, path });
      }
      throw toComfyUnreachable(err, url);
    }
    return res;
  }

  /** GET /system_stats —— 健康检查与版本探测 */
  async systemStats(timeoutMs?: number): Promise<SystemStats> {
    const res = await this.request("GET", "/system_stats", { timeoutMs });
    await this.assertOk(res, "/system_stats");
    return (await res.json()) as SystemStats;
  }

  /** 健康检查：返回 ComfyUI 版本；不可达时抛 ComfyLightError(COMFY_UNREACHABLE) */
  async healthCheck(timeoutMs = 5_000): Promise<{ ok: true; version: string }> {
    const stats = await this.systemStats(timeoutMs);
    return { ok: true, version: String(stats.system?.["comfyui_version"] ?? "<unknown>") };
  }

  /**
   * POST /prompt 提交工作流图。
   * opts.promptId —— 客户端指定 prompt_id（幂等关键，是否被接受以真实验证为准）。
   * ComfyUI 拒绝（400）不抛异常而是返回 ok:false，由 job 层决定语义；
   * 网络/5xx 抛 ComfyLightError。
   */
  async submitPrompt(
    graph: WorkflowGraph,
    opts?: { clientId?: string; promptId?: string }
  ): Promise<SubmitResult> {
    const body: Record<string, unknown> = { prompt: graph };
    if (opts?.clientId) body["client_id"] = opts.clientId;
    if (opts?.promptId) body["prompt_id"] = opts.promptId;
    const res = await this.request("POST", "/prompt", {
      body: JSON.stringify(body),
      timeoutMs: 60_000
    });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      /* 非 JSON 响应按空对象处理，错误信息走原始文本 */
    }
    if (res.status === 200) {
      return {
        ok: true,
        promptId: String(json["prompt_id"] ?? ""),
        number: Number(json["number"] ?? -1),
        nodeErrors: (json["node_errors"] ?? {}) as NodeErrors
      };
    }
    return {
      ok: false,
      httpStatus: res.status,
      errorBody: json["error"] ?? clipTail(text, 500),
      nodeErrors: (json["node_errors"] as NodeErrors | undefined) ?? null
    };
  }

  /** GET /history/{promptId} —— 无记录返回 null（不存在或已被清理） */
  async getHistory(promptId: string): Promise<HistoryEntry | null> {
    const res = await this.request("GET", `/history/${encodeURIComponent(promptId)}`);
    await this.assertOk(res, `/history/{id}`);
    const json = (await res.json()) as Record<string, HistoryEntry>;
    const entry = json[promptId];
    return entry ?? null;
  }

  /** GET /queue —— ComfyUI 队列快照（恢复与取消用） */
  async getQueue(): Promise<QueueInfo> {
    const res = await this.request("GET", "/queue");
    await this.assertOk(res, "/queue");
    return (await res.json()) as QueueInfo;
  }

  /**
   * POST /interrupt —— 中断执行。
   * docs/003 F5（已验证）：interrupt{prompt_id} 对排队任务是 no-op、不影响其他任务；
   * 取消排队任务必须走 POST /queue {delete:[id]}（deleteQueue）。
   * 不传 promptId = 中断当前执行项（ComfyUI 传统语义）。
   */
  async interrupt(promptId?: string): Promise<void> {
    const body = promptId ? JSON.stringify({ prompt_id: promptId }) : "{}";
    const res = await this.request("POST", "/interrupt", { body });
    await this.assertOk(res, "/interrupt");
  }

  /** POST /queue {delete:[...]} —— 从 ComfyUI 队列移除排队项（对不在队的 id 是无害 no-op） */
  async deleteQueue(promptIds: string[]): Promise<void> {
    const res = await this.request("POST", "/queue", { body: JSON.stringify({ delete: promptIds }) });
    await this.assertOk(res, "/queue delete");
  }

  /** GET /view —— 下载输出文件，返回原始 Response（流式，由调用方落盘） */
  async downloadOutput(ref: OutputRef): Promise<Response> {
    const qs = new URLSearchParams({
      filename: ref.filename,
      subfolder: ref.subfolder,
      type: ref.type
    });
    const res = await this.request("GET", `/view?${qs.toString()}`, { timeoutMs: 120_000 });
    if (!res.ok) {
      throw new ComfyLightError("COMFY_HTTP_ERROR", `/view 下载失败: HTTP ${res.status}`, {
        status: res.status,
        ref
      });
    }
    return res;
  }

  /** GET /object_info[/{node}] —— 冒烟脚本构造测试图用；MCP 工具层不暴露 */
  async objectInfo(nodeName?: string): Promise<Record<string, ObjectInfoNode>> {
    const path = nodeName ? `/object_info/${encodeURIComponent(nodeName)}` : "/object_info";
    const res = await this.request("GET", path, { timeoutMs: 60_000 });
    await this.assertOk(res, path);
    return (await res.json()) as Record<string, ObjectInfoNode>;
  }

  private async assertOk(res: Response, path: string): Promise<void> {
    if (res.ok) return;
    const text = clipTail(await res.text(), 500);
    throw new ComfyLightError(
      "COMFY_HTTP_ERROR",
      `ComfyUI 返回 HTTP ${res.status}: ${path}。响应尾部: ${text}`,
      { status: res.status, path }
    );
  }
}
