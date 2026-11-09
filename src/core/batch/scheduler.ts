import type { BatchStore } from "./store.js";
import type { JobRunner } from "./runner.js";
import type { WorkflowRegistry } from "../workflow/registry.js";

/**
 * Scheduler（Task 004 §四 + Task 005 加固）：双窗口调度器。
 * - MAX_IN_FLIGHT：全局在途上限（submitting/submission_unknown/queued/executing——unknown 占额，
 *   因为它可能仍在远端执行；这也是"宁可保留 unknown 也不重复生成"的窗口层落实）
 * - MAX_QUEUED_JOBS：ComfyUI 排队态（queued）上限，须 ≤ MAX_IN_FLIGHT
 * - 每个 tick：① 重试重置（failed/timeout 且次数未用尽 → pending）
 *              ② continue_on_error=false 级联放弃（仅终态失败触发，先重试后级联）
 *              ③ 工作流版本指纹校验（变更 → 旧 batch 的 pending 拒绝执行）
 *              ④ 在窗口内按（batch 创建序, index）顺序提交 pending job（连接可用时）
 * - 防重复提交：ticking 互斥 + store.claimForSubmit 条件占位（`WHERE status='pending'`）双保险
 * - 连接门控（Task 005 §三）：isConnected() 为 false 时暂停提交——pending 原地等待，
 *   绝不在断连期间把提交打成 submission_unknown（重连后自动续跑）
 */

const DEFAULT_TICK_MS = 500;

export interface SchedulerDeps {
  store: BatchStore;
  registry: WorkflowRegistry;
  runner: JobRunner;
  maxInFlight: number;
  maxQueuedJobs: number;
  tickMs?: number;
  /** 提交前连接检查（缺省视为始终可用）；WS 断开时 pending 保持待提交 */
  isConnected?: () => boolean;
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
      this.processRetries();
      this.abortOnErrorPolicy();
      this.verifyWorkflowVersions();
      // 连接门控：ComfyUI 不可达时暂停提交（pending 原地等待，重连后自动续跑）——
      // 避免断连期间提交被打成 submission_unknown 并永久占用在途额度
      if (this.deps.isConnected && !this.deps.isConnected()) return;
      // 提交循环：每次提交后重新计数（提交结果即刻反映到窗口）；
      // 每轮重查 stop 策略——本 tick 内刚失败的任务可立即拦下同 batch 的后续提交
      for (let guard = 0; guard < 10_000; guard++) {
        const { inFlight, queued } = this.deps.store.windowCounts();
        if (inFlight >= this.deps.maxInFlight) break;
        if (queued >= this.deps.maxQueuedJobs) break;
        this.abortOnErrorPolicy();
        const next = this.deps.store.nextPendingJob();
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

  /** continue_on_error=false：batch 出现终态失败（failed/timeout/invalid）→ 剩余 pending 全部 cancelled */
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
   * 工作流版本指纹校验（Task 005 §二.2）：batch 创建后工作流内容变更 →
   * 旧 batch 的 pending job 拒绝执行（cancelled + WORKFLOW_VERSION_MISMATCH），
   * 绝不静默用新版本继续旧 batch；不影响其他 batch；在途 job 不受影响（已按旧版提交，照常对账）。
   */
  private verifyWorkflowVersions(): void {
    for (const snap of this.deps.store.pendingBatchSnapshots()) {
      if (!snap.manifest_fp || !snap.graph_fp) continue; // 旧数据（v3 前创建）：跳过校验
      const wf = this.deps.registry.get(snap.workflow);
      if (!wf) continue; // 工作流消失走提交循环的 WORKFLOW_GONE 路径
      if (wf.fingerprint.manifest === snap.manifest_fp && wf.fingerprint.graph === snap.graph_fp) continue;
      const n = this.deps.store.abortPendingJobs(
        snap.id,
        `工作流 "${snap.workflow}" 自 batch 创建后已变更（manifest ${snap.manifest_fp.slice(0, 8)}→${wf.fingerprint.manifest.slice(0, 8)}，graph ${snap.graph_fp.slice(0, 8)}→${wf.fingerprint.graph.slice(0, 8)}）。拒绝用新版本执行旧 batch 的剩余任务；请用当前工作流重新提交。`,
        "WORKFLOW_VERSION_MISMATCH"
      );
      if (n > 0) this.finalizeBatch(snap.id);
    }
  }

  private finalizeBatch(batchId: string): void {
    const { status, finished } = this.deps.store.recomputeBatchStatus(batchId);
    this.deps.store.updateBatchStatus(batchId, status, finished ? new Date().toISOString() : null);
  }
}
