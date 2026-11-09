import type { BatchStore } from "./store.js";
import type { JobRunner } from "./runner.js";
import type { WorkflowRegistry } from "../workflow/registry.js";
import { fingerprintMismatch } from "../workflow/fingerprint.js";
import { pauseDriftedPendingBatches } from "./recovery.js";

/**
 * Scheduler（Task 004 §四 + P4.1 加固）：双窗口调度器。
 * - MAX_IN_FLIGHT：全局在途上限（submitting/submission_unknown/queued/executing——unknown 占额，
 *   因为它可能仍在远端执行；这也是"宁可保留 unknown 也不重复生成"的窗口层落实）
 * - MAX_QUEUED_JOBS：ComfyUI 排队态（queued）上限，须 ≤ MAX_IN_FLIGHT
 * - 每个 tick：⓪ 工作流指纹对账（漂移 → 暂停该 batch 剩余 pending；恢复一致 → 解除暂停续跑）
 *              ① 重试重置（failed/timeout 且次数未用尽 → pending）
 *              ② continue_on_error=false 级联放弃（仅【终态】失败——重试未用尽先重试，P4.1 §二.5）
 *              ③ 在窗口内按（batch 创建时间, index）顺序提交 pending job（提交前再校验一次指纹；
 *                重试未决的 batch 其余 pending 暂缓——heldPendingBatches）
 * - 防重复提交：ticking 互斥 + store.claimForSubmit 条件占位（`WHERE status='pending'`）双保险
 */

const DEFAULT_TICK_MS = 500;

export interface SchedulerDeps {
  store: BatchStore;
  registry: WorkflowRegistry;
  runner: JobRunner;
  maxInFlight: number;
  maxQueuedJobs: number;
  tickMs?: number;
}

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private readonly tickMs: number;

  constructor(private readonly deps: SchedulerDeps) {
    this.tickMs = deps.tickMs ?? DEFAULT_TICK_MS;
  }

  /** 启动周期调度（幂等）；unref 保证不独占事件循环（MCP stdio 传输会保活主进程） */
  ensureStarted(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  isRunning(): boolean {
    return this.timer !== null;
  }

  /**
   * 单次调度推进。并发调用安全：进行中的 tick 未结束时，后续调用直接返回
   * （不排队——下一周期会重新对账，无需补拍）。
   * 周期定时器路径的异常被吞掉（下一拍重对账），避免 setInterval 回调未捕获异常杀死进程。
   */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      this.reconcileWorkflowDrift();
      this.processRetries();
      this.abortOnErrorPolicy();
      // 提交循环：每次提交后重新计数（提交结果即刻反映到窗口）；
      // 每轮重查 stop 策略——本 tick 内刚失败的任务可立即拦下同 batch 的后续提交
      for (let guard = 0; guard < 10_000; guard++) {
        const { inFlight, queued } = this.deps.store.windowCounts();
        if (inFlight >= this.deps.maxInFlight) break;
        if (queued >= this.deps.maxQueuedJobs) break;
        this.abortOnErrorPolicy();
        // continue_on_error=false 的 batch 存在重试未决失败 → 其余 pending 暂缓（等重试定局）
        const held = this.deps.store.heldPendingBatches();
        const next = this.deps.store.nextPendingJob(held);
        if (!next) break;
        const wf = this.deps.registry.get(next.workflow);
        if (!wf) {
          // batch 创建后工作流被移除/失效：落 invalid（部分容错，不阻断其他 batch）
          this.deps.store.patchJob(next.job.id, {
            status: "invalid",
            error_json: JSON.stringify({
              code: "WORKFLOW_GONE",
              message: `工作流 "${next.workflow}" 已不在注册表中（batch 创建后目录变更？）`
            }),
            finished_at: new Date().toISOString()
          });
          this.finalizeBatch(next.job.batch_id);
          continue;
        }
        // 工作流版本保护（P4.1 §二.2）：提交前比对 batch 创建时的指纹快照
        const mismatch = fingerprintMismatch(
          {
            workflowVersion: next.batch.workflowVersion,
            manifestFingerprint: next.batch.manifestFingerprint,
            graphFingerprint: next.batch.graphFingerprint
          },
          { version: wf.manifest.version, ...wf.fingerprints }
        );
        if (mismatch) {
          // 暂停该 batch 全部剩余 pending（不提交、不换新版本静默续跑、不影响其他 batch）
          const n = this.deps.store.pauseBatchPendingJobs(
            next.job.batch_id,
            `batch 创建后工作流已变化（${mismatch}）。剩余任务已暂停；恢复原工作流内容后自动继续，或另建新 batch。`
          );
          if (n > 0) this.finalizeBatch(next.job.batch_id);
          continue;
        }
        const handle = await this.deps.runner.submitJob(wf, next.job);
        if (handle === null) continue; // 占位失败：该 job 已被其他路径处理，继续看下一个
      }
    } catch {
      // 单次对账失败不致命：吞掉后下一拍重新对账（提交幂等由条件占位保证）。
      // 也保护周期定时器路径——setInterval 回调的未捕获异常会杀死整个进程。
    } finally {
      this.ticking = false;
    }
  }

  /** 失败重试：attempt_no < max_attempts 的 failed/timeout → pending（新 prompt_id 在占位时生成） */
  private processRetries(): void {
    for (const job of this.deps.store.retryEligibleJobs()) {
      this.deps.store.resetForRetry(job.id);
    }
  }

  /**
   * continue_on_error=false：batch 出现【终态】失败（invalid，或 failed/timeout 且重试已用尽）
   * → 剩余 pending 全部 cancelled。重试未用尽的失败先重试（P4.1 §二.5 组合语义）。
   */
  private abortOnErrorPolicy(): void {
    for (const batchId of this.deps.store.batchesNeedingAbort()) {
      const n = this.deps.store.abortPendingJobs(
        batchId,
        "batch 内已有失败任务且 continue_on_error=false，剩余任务被放弃"
      );
      if (n > 0) this.finalizeBatch(batchId);
    }
  }

  /**
   * 工作流版本保护（P4.1 §二.2）：
   * - 漂移：含 pending 的 running batch 指纹与当前注册工作流不一致 → 暂停其 pending
   *   （即时可见，不等到窗口空出准备提交时；与恢复共用 pauseDriftedPendingBatches）。
   * - 还原：paused 的 batch 指纹恢复一致（用户还原了工作流内容）→ 自动解除暂停续跑。
   */
  private reconcileWorkflowDrift(): void {
    try {
      pauseDriftedPendingBatches({ store: this.deps.store, registry: this.deps.registry });
    } catch {
      // 单次对账失败不致命：下一拍重试；提交前还有逐 job 兜底校验
    }
    this.resumePausedJobs();
  }

  /** 指纹恢复一致时 paused → pending（仍漂移或工作流不在注册表 → 保持 paused） */
  private resumePausedJobs(): void {
    for (const batchId of this.deps.store.pausedBatches()) {
      const batch = this.deps.store.getBatch(batchId);
      if (!batch) continue;
      const wf = this.deps.registry.get(batch.workflow);
      if (!wf) continue;
      const mismatch = fingerprintMismatch(
        {
          workflowVersion: batch.workflow_version,
          manifestFingerprint: batch.manifest_fingerprint,
          graphFingerprint: batch.graph_fingerprint
        },
        { version: wf.manifest.version, ...wf.fingerprints }
      );
      if (mismatch) continue;
      const n = this.deps.store.resumeBatchPausedJobs(batchId);
      if (n > 0) this.finalizeBatch(batchId);
    }
  }

  private finalizeBatch(batchId: string): void {
    const { status, finished } = this.deps.store.recomputeBatchStatus(batchId);
    this.deps.store.updateBatchStatus(batchId, status, finished ? new Date().toISOString() : null);
  }
}
