import type { ComfyClient } from "../client/index.js";
import type { AssetManager } from "../assets/asset-manager.js";
import type { BatchStore } from "./store.js";
import { type JobRow, type JobError, type JobOutputAsset } from "./store.js";

/**
 * JobTracker：在途 job 的后台跟踪。
 * - WS 事件（按 prompt_id 多路分解）驱动状态推进
 * - history 轮询兜底（每 3s）：WS 丢失/断线也能定终态（P1 S7 已验证该路径可靠）
 * - 墙钟超时：queued→POST /queue delete + executing→POST /interrupt 组合取消
 *   （docs/003 F5：interrupt 对排队任务是 no-op，两动作对错误态均为无害 no-op → 竞态安全）
 * - History 终态优先级（Task 004 §二.1）：error/interrupted 判定优先于 outputs 存在性，
 *   error 绝不因存在部分 outputs 被标成 succeeded
 * - 成功 → /history 收获输出 → AUTO_SAVE 落盘（false 时存引用，get_result 按需下载）
 */

const HISTORY_POLL_MS = 3_000;

export interface TrackerDeps {
  client: ComfyClient;
  store: BatchStore;
  assets: AssetManager;
  autoSave: boolean;
  defaultTimeoutMs: number;
}

interface Tracked {
  job: JobRow;
  unsubscribe: () => void;
  pollTimer: NodeJS.Timeout | null;
  timeoutTimer: NodeJS.Timeout | null;
  settled: boolean;
}

/** history.status → 终态判定（优先级：error/interrupted > success/completed > 有输出） */
export function historyVerdict(entry: {
  status?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
}): "success" | "error" | "interrupted" | null {
  const s = entry.status as Record<string, unknown> | undefined;
  const str = String(s?.["status_str"] ?? "");
  if (str === "error") return "error";
  if (str === "interrupted") return "interrupted";
  if (str === "success" || s?.["completed"] === true) return "success";
  const hasOutputs = Object.values(entry.outputs ?? {}).some(
    (o) => o !== null && typeof o === "object" && Object.keys(o as object).length > 0
  );
  if (hasOutputs) return "success"; // 无显式状态但有输出（兼容路径；显式 error 已在上方排除）
  return null;
}

export class JobTracker {
  private readonly tracked = new Map<string, Tracked>(); // key: jobId

  constructor(private readonly deps: TrackerDeps) {}

  isTracked(jobId: string): boolean {
    return this.tracked.has(jobId);
  }

  /** 清理全部跟踪资源（测试/关停用；不改动 job 状态） */
  disposeAll(): void {
    for (const t of [...this.tracked.values()]) {
      t.unsubscribe();
      if (t.pollTimer) clearInterval(t.pollTimer);
      if (t.timeoutTimer) clearTimeout(t.timeoutTimer);
    }
    this.tracked.clear();
  }

  track(job: JobRow): void {
    if (!job.prompt_id || this.tracked.has(job.id)) return;
    const promptId = job.prompt_id;
    const t: Tracked = {
      job,
      unsubscribe: () => {},
      pollTimer: null,
      timeoutTimer: null,
      settled: false
    };

    // WS 事件驱动
    t.unsubscribe = this.deps.client.bus.subscribePrompt(promptId, (e) => {
      if (t.settled) return;
      switch (e.type) {
        case "started":
          this.deps.store.patchJob(job.id, { status: "executing", started_at: new Date().toISOString() });
          break;
        case "executing":
          this.deps.store.patchJob(job.id, { status: "executing" });
          break;
        case "success":
          void this.settleFromHistory(t);
          break;
        case "error":
          this.settle(t, "failed", {
            code: "EXECUTION_ERROR",
            message: e.message.slice(0, 500)
          });
          break;
        case "interrupted":
          this.settle(t, "failed", {
            code: "INTERRUPTED",
            message: "执行被中断（ComfyUI 侧 interrupt）"
          });
          break;
        default:
          break; // progress / executed（executed 的输出统一从 history 收获，避免双源不一致）
      }
    });

    // history 轮询兜底（WS 断线/事件丢失时的第二通道）
    t.pollTimer = setInterval(() => {
      if (t.settled) return;
      void this.deps.client.http
        .getHistory(promptId)
        .then((entry) => {
          if (t.settled || !entry) return;
          const verdict = historyVerdict(entry);
          if (verdict === "success") {
            void this.settleFromHistory(t, entry);
          } else if (verdict === "error") {
            this.settle(t, "failed", {
              code: "EXECUTION_ERROR",
              message: "history 轮询判定终态: error"
            });
          } else if (verdict === "interrupted") {
            this.settle(t, "cancelled", {
              code: "INTERRUPTED",
              message: "history 轮询判定终态: interrupted"
            });
          }
        })
        .catch(() => undefined); // ComfyUI 暂不可达时下轮再试
    }, HISTORY_POLL_MS);

    // 墙钟超时：先组合取消（记录远端结果），取消期间若事件已定终态则以先到者为准
    t.timeoutTimer = setTimeout(() => {
      if (t.settled) return;
      void this.handleTimeout(t, promptId);
    }, this.deps.defaultTimeoutMs);

    this.tracked.set(job.id, t);
  }

  private async handleTimeout(t: Tracked, promptId: string): Promise<void> {
    const remote = await this.cancelRemote(promptId);
    if (t.settled) return; // 竞态：取消进行中 job 已由事件定终态（如恰好成功），保持原判定
    this.settle(t, "timeout", {
      code: "TIMEOUT",
      message: `执行超过 ${this.deps.defaultTimeoutMs}ms，已向 ComfyUI 发送组合取消（queue delete + interrupt）`,
      remote_cancel: remote
    });
  }

  /**
   * 组合取消（docs/003 F5 语义）：queue delete 移除排队项；interrupt 终止执行项。
   * 任务可能恰在两动作之间由 queued 转 executing，故两者都发——
   * 各自对"错误状态"是已验证的无害 no-op（interrupt 不伤排队任务，delete 不影响执行中任务）。
   */
  private async cancelRemote(promptId: string): Promise<{ queue_delete: string; interrupt: string }> {
    const out = { queue_delete: "skipped", interrupt: "skipped" };
    try {
      await this.deps.client.http.deleteQueue([promptId]);
      out.queue_delete = "ok";
    } catch (e) {
      out.queue_delete = `error: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200);
    }
    try {
      await this.deps.client.http.interrupt(promptId);
      out.interrupt = "ok";
    } catch (e) {
      out.interrupt = `error: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200);
    }
    return out;
  }

  private async settleFromHistory(t: Tracked, entry?: Awaited<ReturnType<ComfyClient["http"]["getHistory"]>>): Promise<void> {
    if (t.settled) return;
    const promptId = t.job.prompt_id!;
    const hist = entry ?? (await this.deps.client.http.getHistory(promptId).catch(() => null));
    if (!hist) {
      // 拿不到 history（理论罕见）：置 failed 并说明
      this.settle(t, "failed", { code: "NO_HISTORY", message: "execution_success 后无法读取 history" });
      return;
    }
    // 终态优先级守卫：execution_success 事件到达但 history 实际记录 error/interrupted
    //（理论上不应发生，防御性保证 error 不被误判为成功）
    const verdict = historyVerdict(hist);
    if (verdict === "error") {
      this.settle(t, "failed", { code: "EXECUTION_ERROR", message: "execution_success 后 history 记录为 error" });
      return;
    }
    if (verdict === "interrupted") {
      this.settle(t, "cancelled", { code: "INTERRUPTED", message: "execution_success 后 history 记录为 interrupted" });
      return;
    }
    let outputs: JobOutputAsset[] = [];
    let saveError: string | null = null;
    if (this.deps.autoSave) {
      try {
        outputs = await this.deps.assets.saveOutputs(t.job.batch_id, t.job.idx, hist);
      } catch (e) {
        saveError = `输出落盘失败: ${e instanceof Error ? e.message : String(e)}`;
      }
    } else {
      // 不落盘时记录引用（kind+filename，供 get_result 按需下载）
      const { harvestOutputRefs } = await import("../assets/asset-manager.js");
      outputs = harvestOutputRefs(hist).map((r) => ({ ...r, local_path: "", bytes: 0 }));
    }
    this.settle(t, "succeeded", saveError ? { code: "SAVE_ERROR", message: saveError } : undefined, outputs);
  }

  private settle(
    t: Tracked,
    status: JobRow["status"],
    error?: JobError,
    outputs?: JobOutputAsset[]
  ): void {
    if (t.settled) return;
    t.settled = true;
    t.unsubscribe();
    if (t.pollTimer) clearInterval(t.pollTimer);
    if (t.timeoutTimer) clearTimeout(t.timeoutTimer);
    this.tracked.delete(t.job.id);
    this.deps.store.patchJob(t.job.id, {
      status,
      error_json: error ? JSON.stringify(error) : t.job.error_json,
      outputs_json: outputs ? JSON.stringify(outputs) : undefined,
      finished_at: new Date().toISOString()
    });
    // attempt 终态回写（t.job 快照的 attempt_no 即本次跟踪的尝试）
    this.deps.store.patchAttemptStatus(t.job.id, t.job.attempt_no, status, new Date().toISOString());
    const { status: batchStatus, finished } = this.deps.store.recomputeBatchStatus(t.job.batch_id);
    this.deps.store.updateBatchStatus(t.job.batch_id, batchStatus, finished ? new Date().toISOString() : null);
  }
}
