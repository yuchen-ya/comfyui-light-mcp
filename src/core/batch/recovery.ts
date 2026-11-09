import type { ComfyClient } from "../client/index.js";
import { queueEntryPromptId } from "../client/types.js";
import { harvestOutputRefs, type AssetManager } from "../assets/asset-manager.js";
import type { BatchStore } from "./store.js";
import { type JobRow } from "./store.js";
import { historyVerdict, type JobTracker } from "./tracker.js";
import type { WorkflowRegistry } from "../workflow/registry.js";
import { fingerprintMismatch } from "../workflow/fingerprint.js";

/**
 * 启动恢复（docs/002 §6.2，Task 003 A1 语义 + Task 004 §二.1 终态优先级 + P4.1 加固）：
 * - history 有记录 → 定终态（error/interrupted 优先判定；成功才收获输出+落盘）
 * - /queue 仍在 → 交还 tracker 继续跟踪（不重复提交）
 * - 两处皆无 → **保持 submission_unknown**（不伪装 failed、不自动重提、get_batch 可区分）
 * - 中断终态（P4.1 统一）：history interrupted → cancelled（用户/外部中断）
 * - 工作流版本保护（P4.1）：恢复时校验含 pending job 的 batch 的工作流指纹，
 *   漂移 → 暂停其 pending job（WORKFLOW_VERSION_MISMATCH），不静默用新版本续跑旧 batch
 */

export interface RecoveryReport {
  resolved: number; // 已从 history 定终态
  requeued: number; // 仍在 ComfyUI 队列，重新跟踪
  keptUnknown: number; // 保持 submission_unknown
  requeuedAsExecuting: number;
  /** 工作流指纹漂移而被暂停的 pending job 数（P4.1） */
  pausedOnVersionMismatch: number;
}

export interface RecoveryDeps {
  client: ComfyClient;
  store: BatchStore;
  assets: AssetManager;
  tracker: JobTracker;
  autoSave: boolean;
  /** 工作流注册表（P4.1：pending job 的指纹校验） */
  registry: WorkflowRegistry;
}

export async function recoverInFlight(deps: RecoveryDeps): Promise<RecoveryReport> {
  const report: RecoveryReport = {
    resolved: 0,
    requeued: 0,
    keptUnknown: 0,
    requeuedAsExecuting: 0,
    pausedOnVersionMismatch: 0
  };
  const jobs = deps.store.inFlightJobs();
  for (const job of jobs) {
    try {
      await recoverOne(deps, job, report);
    } catch {
      // 单个恢复失败不阻断其余；该 job 维持原状，下次重启再试
    }
  }
  try {
    report.pausedOnVersionMismatch = pauseDriftedPendingBatches(deps);
  } catch {
    // 指纹校验失败不阻断恢复主体；提交路径（Scheduler）每 tick 还会再校验
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
      // P4.1 统一：中断 = 用户/外部取消 → cancelled（曾误标 failed）
      deps.store.patchJob(job.id, {
        status: "cancelled",
        error_json: JSON.stringify({ code: "INTERRUPTED", message: "崩溃期间被中断（恢复时经 history 判定，用户/外部中断）" }),
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

/**
 * 工作流版本保护（P4.1 §二.2）：含 pending job 的 running batch，逐一比对
 * batch 创建时快照与当前注册工作流的指纹。漂移 → 暂停该 batch 全部 pending job。
 * 返回暂停的 job 数。已提交的在途 job 不受影响（旧图已提交给 ComfyUI，照常跟踪定终态）。
 * 恢复（recoverInFlight）与调度器每 tick（Scheduler）共用本函数——漂移即时可见，
 * 不必等到窗口空出准备提交时才发现。
 */
export function pauseDriftedPendingBatches(deps: {
  store: BatchStore;
  registry: WorkflowRegistry;
}): number {
  let paused = 0;
  for (const batchId of deps.store.batchesWithPendingJobs()) {
    const batch = deps.store.getBatch(batchId);
    if (!batch || batch.status !== "running") continue;
    const wf = deps.registry.get(batch.workflow);
    if (!wf) continue; // 工作流不在注册表：留给提交路径落 WORKFLOW_GONE（不在此伪装版本漂移）
    const mismatch = fingerprintMismatch(
      {
        workflowVersion: batch.workflow_version,
        manifestFingerprint: batch.manifest_fingerprint,
        graphFingerprint: batch.graph_fingerprint
      },
      { version: wf.manifest.version, ...wf.fingerprints }
    );
    if (mismatch) {
      const n = deps.store.pauseBatchPendingJobs(
        batchId,
        `batch 创建后工作流已变化（${mismatch}）。剩余任务已暂停；恢复原工作流内容后自动继续，或另建新 batch。`
      );
      if (n > 0) {
        const { status, finished } = deps.store.recomputeBatchStatus(batchId);
        deps.store.updateBatchStatus(batchId, status, finished ? new Date().toISOString() : null);
      }
      paused += n;
    }
  }
  return paused;
}

function finalizeBatch(deps: RecoveryDeps, batchId: string): void {
  const { status, finished } = deps.store.recomputeBatchStatus(batchId);
  deps.store.updateBatchStatus(batchId, status, finished ? new Date().toISOString() : null);
}
