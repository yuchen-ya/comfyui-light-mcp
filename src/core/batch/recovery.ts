import type { ComfyClient } from "../client/index.js";
import { queueEntryPromptId } from "../client/types.js";
import { harvestOutputRefs, type AssetManager } from "../assets/asset-manager.js";
import type { BatchStore } from "./store.js";
import { type JobRow } from "./store.js";
import { historyVerdict, type JobTracker } from "./tracker.js";

/**
 * 启动恢复（docs/002 §6.2，Task 003 A1 语义 + Task 004 §二.1 终态优先级）：
 * - history 有记录 → 定终态（error/interrupted 优先判定；成功才收获输出+落盘）
 * - /queue 仍在 → 交还 tracker 继续跟踪（不重复提交）
 * - 两处皆无 → **保持 submission_unknown**（不伪装 failed、不自动重提、get_batch 可区分）
 */

export interface RecoveryReport {
  resolved: number; // 已从 history 定终态
  requeued: number; // 仍在 ComfyUI 队列，重新跟踪
  keptUnknown: number; // 保持 submission_unknown
  requeuedAsExecuting: number;
}

export interface RecoveryDeps {
  client: ComfyClient;
  store: BatchStore;
  assets: AssetManager;
  tracker: JobTracker;
  autoSave: boolean;
}

export async function recoverInFlight(deps: RecoveryDeps): Promise<RecoveryReport> {
  const report: RecoveryReport = { resolved: 0, requeued: 0, keptUnknown: 0, requeuedAsExecuting: 0 };
  const jobs = deps.store.inFlightJobs();
  for (const job of jobs) {
    try {
      await recoverOne(deps, job, report);
    } catch {
      // 单个恢复失败不阻断其余；该 job 维持原状，下次重启再试
    }
  }
  return report;
}

async function recoverOne(deps: RecoveryDeps, job: JobRow, report: RecoveryReport): Promise<void> {
  if (!job.prompt_id) {
    // 提交前崩溃（理论上不会发生：runner 在提交前已落 prompt_id）——保守置 unknown
    deps.store.patchJob(job.id, { status: "submission_unknown" });
    report.keptUnknown++;
    return;
  }
  const hist = await deps.client.http.getHistory(job.prompt_id).catch(() => null);
  if (hist) {
    // 终态优先级（Task 004 §二.1）：error/interrupted 先判，error 不得因部分 outputs 判 succeeded
    const verdict = historyVerdict(hist);
    if (verdict === "error") {
      deps.store.patchJob(job.id, {
        status: "failed",
        error_json: JSON.stringify({ code: "EXECUTION_ERROR", message: "崩溃期间执行失败（恢复时经 history 判定）" }),
        finished_at: new Date().toISOString()
      });
    } else if (verdict === "interrupted") {
      deps.store.patchJob(job.id, {
        status: "failed",
        error_json: JSON.stringify({ code: "INTERRUPTED", message: "崩溃期间被中断（恢复时经 history 判定）" }),
        finished_at: new Date().toISOString()
      });
    } else if (verdict === "success") {
      let outputs;
      if (deps.autoSave) {
        outputs = await deps.assets.saveOutputs(job.batch_id, job.idx, hist).catch((e) => {
          throw new Error(`恢复落盘失败: ${e instanceof Error ? e.message : String(e)}`);
        });
      } else {
        // 与 tracker 一致：不落盘时记录引用（get_result 按需下载）
        outputs = harvestOutputRefs(hist).map((r) => ({ ...r, local_path: "", bytes: 0 }));
      }
      deps.store.patchJob(job.id, {
        status: "succeeded",
        outputs_json: JSON.stringify(outputs ?? []),
        finished_at: new Date().toISOString()
      });
    } else {
      // history 有记录但未完成（罕见）：留在队列判定分支处理
      await requeueOrUnknown(deps, job, report);
      return;
    }
    finalizeBatch(deps, job.batch_id);
    report.resolved++;
    return;
  }
  await requeueOrUnknown(deps, job, report);
}

async function requeueOrUnknown(deps: RecoveryDeps, job: JobRow, report: RecoveryReport): Promise<void> {
  const queue = await deps.client.http.getQueue().catch(() => null);
  if (queue) {
    const items = [...queue.queue_running, ...queue.queue_pending];
    const found = items.find((it) => queueEntryPromptId(it) === job.prompt_id);
    if (found) {
      const executing = queue.queue_running.some((it) => queueEntryPromptId(it) === job.prompt_id);
      deps.store.patchJob(job.id, { status: executing ? "executing" : "queued" });
      const fresh = deps.store.getJobById(job.id)!;
      deps.tracker.track(fresh);
      if (executing) report.requeuedAsExecuting++;
      else report.requeued++;
      return;
    }
  }
  // history 与 queue 均无：保持 submission_unknown（A1 语义核心）
  deps.store.patchJob(job.id, {
    status: "submission_unknown",
    error_json: JSON.stringify({
      code: "SUBMISSION_UNKNOWN",
      message: `崩溃恢复：history 与 queue 均未找到 prompt_id=${job.prompt_id}。保持未知状态，不自动重提（避免重复执行）。`
    })
  });
  report.keptUnknown++;
  finalizeBatch(deps, job.batch_id);
}

function finalizeBatch(deps: RecoveryDeps, batchId: string): void {
  const { status, finished } = deps.store.recomputeBatchStatus(batchId);
  deps.store.updateBatchStatus(batchId, status, finished ? new Date().toISOString() : null);
}
