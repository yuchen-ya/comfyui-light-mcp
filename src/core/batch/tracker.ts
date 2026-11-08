import type { ComfyClient } from "../client/index.js";
import type { AssetManager } from "../assets/asset-manager.js";
import type { BatchStore} from "./store.js";
import { type JobRow, type JobError, type JobOutputAsset } from "./store.js";

/**
 * JobTracker：在途 job 的后台跟踪。
 * - WS 事件（按 prompt_id 多路分解）驱动状态推进
 * - history 轮询兜底（每 3s）：WS 丢失/断线也能定终态（P1 S7 已验证该路径可靠）
 * - 墙钟超时：触发即尽力 interrupt + queue delete（docs/003 F5 修正语义）→ timeout 终态
 * - 成功 → /history 收获输出 → AUTO_SAVE 落盘 → outputs_json（本地绝对路径）
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
          const s = entry.status as Record<string, unknown> | undefined;
          const str = String(s?.["status_str"] ?? "");
          const hasOutputs = Object.values(entry.outputs ?? {}).some((o) => Object.keys(o).length > 0);
          if (str === "success" || s?.["completed"] === true || hasOutputs) {
            void this.settleFromHistory(t, entry);
          } else if (str === "error" || str === "interrupted") {
            this.settle(t, str === "error" ? "failed" : "cancelled", {
              code: str === "error" ? "EXECUTION_ERROR" : "INTERRUPTED",
              message: `history 轮询判定终态: ${str}`
            });
          }
        })
        .catch(() => undefined); // ComfyUI 暂不可达时下轮再试
    }, HISTORY_POLL_MS);

    // 墙钟超时
    t.timeoutTimer = setTimeout(() => {
      if (t.settled) return;
      void this.cancelRemote(promptId).catch(() => undefined);
      this.settle(t, "timeout", {
        code: "TIMEOUT",
        message: `执行超过 ${this.deps.defaultTimeoutMs}ms，已尽力向 ComfyUI 发送 interrupt/queue delete`
      });
    }, this.deps.defaultTimeoutMs);

    this.tracked.set(job.id, t);
  }

  /** docs/003 F5：排队态 interrupt 是 no-op，须组合 queue delete 才能取消 */
  private async cancelRemote(promptId: string): Promise<void> {
    try {
      await this.deps.client.http.interrupt(promptId);
    } catch {
      /* 尽力而为 */
    }
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
    let outputs: JobOutputAsset[] = [];
    let saveError: string | null = null;
    if (this.deps.autoSave) {
      try {
        outputs = await this.deps.assets.saveOutputs(t.job.batch_id, t.job.idx, hist);
      } catch (e) {
        saveError = `输出落盘失败: ${e instanceof Error ? e.message : String(e)}`;
      }
    } else {
      // 不落盘时记录引用（kind+filename，供 get_result 按需处理）
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
    const { status: batchStatus, finished } = this.deps.store.recomputeBatchStatus(t.job.batch_id);
    this.deps.store.updateBatchStatus(t.job.batch_id, batchStatus, finished ? new Date().toISOString() : null);
  }
}
