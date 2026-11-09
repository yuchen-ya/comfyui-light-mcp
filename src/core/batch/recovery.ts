import type { ComfyClient } from "../client/index.js";
import { type AssetManager } from "../assets/asset-manager.js";
import type { BatchStore } from "./store.js";
import { type JobTracker } from "./tracker.js";
import type { WorkflowRegistry } from "../workflow/registry.js";
import { fingerprintMismatch } from "../workflow/fingerprint.js";

/**
 * 启动恢复（docs/002 §6.2，Task 003 A1 语义 + Task 004 §二.1 终态优先级 + P4.1 加固）：
 * - history 有记录 → 定终态（error/interrupted 优先判定；成功才收获输出+落盘）
 * - /queue 仍在 → 交还 tracker 继续跟踪（不重复提交）
 * - 两处皆无 → **保持 submission_unknown**（不伪装 failed、不自动重提、get_batch 可区分）
 * - 中断终态（P4.1 统一）：history messages.execution_interrupted → 按持久化取消意图区分 timeout/cancelled
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
  deps.store.repairLegacyInvalidBatches();
  const report: RecoveryReport = {
    resolved: 0,
    requeued: 0,
    keptUnknown: 0,
    requeuedAsExecuting: 0,
    pausedOnVersionMismatch: 0
  };
  for (const job of deps.store.inFlightJobs()) {
    if (!job.prompt_id) {
      deps.store.patchJob(job.id, { status: "submission_unknown" });
      report.keptUnknown++;
      continue;
    }
    deps.tracker.track(job);
    await deps.tracker.reconcile(job.id);
    const current = deps.store.getJobById(job.id)!;
    if (["succeeded", "failed", "cancelled", "timeout"].includes(current.status)) report.resolved++;
    else if (current.status === "executing") report.requeuedAsExecuting++;
    else if (current.status === "queued") report.requeued++;
    else report.keptUnknown++;
  }
  report.pausedOnVersionMismatch = pauseDriftedPendingBatches(deps);
  return report;
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
    const state = deps.registry.statusOf?.(batch.workflow);
    if (state?.status === "invalid") {
      const n = deps.store.pauseBatchPendingJobs(
        batchId,
        `WORKFLOW_INVALID: 当前工作流文件无效（${state.error?.message ?? "未知加载错误"}）。剩余任务已暂停；修复并恢复原版本后自动继续，或另建新 batch。`,
        "WORKFLOW_INVALID"
      );
      if (n > 0) {
        const { status, finished } = deps.store.recomputeBatchStatus(batchId);
        deps.store.updateBatchStatus(batchId, status, finished ? new Date().toISOString() : null);
      }
      paused += n;
      continue;
    }
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
