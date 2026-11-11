import type Database from "better-sqlite3";
import type { AppConfig } from "../config.js";
import type { ComfyClient } from "./client/index.js";
import { WorkflowRegistry, registeredWorkflowFingerprint, type LoadReport } from "./workflow/registry.js";
import { BatchStore } from "./batch/store.js";
import { ResultDelivery, type BatchResultIndex } from "./batch/result-delivery.js";
import { JobRunner } from "./batch/runner.js";
import { JobTracker } from "./batch/tracker.js";
import { BatchManager, type BatchView, type RunSpec, computeRequestFingerprint, assertIdempotencyMatch } from "./batch/manager.js";
import { Scheduler } from "./batch/scheduler.js";
import { recoverInFlight, type RecoveryReport } from "./batch/recovery.js";
import { AssetManager } from "./assets/asset-manager.js";
import { validateParams } from "./workflow/mapper.js";
import { ComfyLightError } from "../shared/errors.js";
import { renderBounded } from "../shared/truncate.js";
import { ObjectInfoCache } from "./workflow/object-info.js";
import { calculateDryRun, invalidWorkflowDryRun, type DryRunView } from "./workflow/dry-run.js";

/**
 * Core Engine facade（docs/002 §4.4）：MCP 层唯一入口，纯 TS 不依赖 MCP SDK。
 * Task 004：BatchManager（runs 数组创建/查询）+ Scheduler（双窗口调度）接入；
 * 单运行（params 简写）与批量（runs 数组）共用同一条 submitJob 管线。
 */

export interface RunHandleView {
  batch_id: string;
  index: number;
  status: string;
}

export interface BatchHandleView {
  batch_id: string;
  total: number;
  invalid: number;
  reused: boolean;
  status: string;
}

export interface ResultView {
  batch_id: string;
  index: number;
  workflow: string;
  status: string;
  params_resolved: Record<string, unknown> | null;
  outputs: Array<Record<string, unknown>>;
  error: Record<string, unknown> | null;
}

export class Engine {
  readonly registry: WorkflowRegistry;
  readonly store: BatchStore;
  readonly tracker: JobTracker;
  readonly runner: JobRunner;
  readonly manager: BatchManager;
  readonly scheduler: Scheduler;
  private readonly assets: AssetManager;
  private readonly results: ResultDelivery;
  private readonly objectInfo: ObjectInfoCache;
  private recovery: Promise<RecoveryReport> | null = null;
  private workflowRefresh: Promise<void> | null = null;
  private lastWorkflowRefreshAt = 0;
  private lastReconciledAt = 0;
  private connectionEpoch = -1;

  constructor(
    readonly config: AppConfig,
    private readonly client: ComfyClient,
    db: Database.Database
  ) {
    this.registry = new WorkflowRegistry(config.workflowsDir);
    this.store = new BatchStore(db);
    this.assets = new AssetManager(client, config.outputDir);
    this.results = new ResultDelivery(this.store, this.assets, config.outputDir, this.registry);
    this.tracker = new JobTracker({
      client,
      store: this.store,
      assets: this.assets,
      autoSave: config.autoSaveOutputs,
      defaultTimeoutMs: config.jobTimeoutMs
    });
    this.runner = new JobRunner({ client, store: this.store, tracker: this.tracker });
    this.manager = new BatchManager(this.store);
    this.objectInfo = new ObjectInfoCache({
      fetcher: () => client.http.objectInfo(),
      epoch: () => client.ws.getStats().reconnects ?? 0
    });
    this.scheduler = new Scheduler({
      store: this.store,
      registry: this.registry,
      runner: this.runner,
      maxInFlight: config.maxInFlight,
      maxQueuedJobs: config.maxQueuedJobs,
      isConnected: () => {
        const stats = this.client.ws.getStats();
        return stats.state === "open" && (stats.reconnects ?? 0) === this.connectionEpoch && this.lastReconciledAt !== 0;
      },
      beforeTick: () => this.reconcileConnection()
    });
  }

  /** 启动扫描（目录读取为异步，一次性完成后注册表常驻内存） */
  async loadWorkflowsAsync(): Promise<LoadReport> {
    return this.registry.load();
  }

  /** 启动调度；每次连接先恢复对账，周期定时器 unref。 */
  start(): void {
    this.tracker.resume();
    this.scheduler.ensureStarted();
    void this.refreshForExecution().catch(() => { /* 下一次调用/周期刷新会重试 */ });
    this.lastWorkflowRefreshAt = Date.now();
  }

  /** 关停：停止提交，等待已开始的结果收集，再释放跟踪资源。关闭 DB 前须 await。 */
  async stop(): Promise<void> {
    await this.scheduler.stop();
    await this.workflowRefresh?.catch(() => { /* 刷新失败不阻断 tracker 与 DB 关停 */ });
    await this.tracker.stop();
    this.lastReconciledAt = 0;
  }

  /** list_workflows：摘要 / 指定名详情；调用前按文件指纹热加载。 */
  async listWorkflows(name?: string): Promise<Record<string, unknown>> {
    const report = await this.registry.refresh();
    if (name === undefined) {
      return {
        workflows: this.registry.list(),
        load_errors: report.errors,
        refresh: report.scanFailed ? "failed" : "ok",
        hint: "传 workflow=<name> 获取该工作流完整参数说明"
      };
    }
    if (report.scanFailed) {
      throw new ComfyLightError("WORKFLOW_INVALID", "无法确认工作流文件的最新状态，请修复目录读取错误后重试");
    }
    const state = this.registry.statusOf(name);
    if (state?.status === "invalid") {
      const previous = this.registry.getLastValid(name);
      return {
        name,
        status: "invalid",
        workflow_error: state.error,
        last_valid_version: previous?.manifest.version ?? null,
        message: "当前文件无效；修复并成功热加载前不能执行，系统不会回退到旧版本"
      };
    }
    const detail = this.registry.paramDetail(name);
    if (!detail) {
      const available = this.registry.list().filter((w) => w.status === "ready").map((w) => w.name).join(", ") || "<无>";
      const reason = state?.status === "deleted" ? "已删除" : "未注册";
      return { error: { code: "NOT_FOUND", message: `工作流 "${name}" ${reason}。可用: ${available}` } };
    }
    const w = this.registry.get(name)!;
    return {
      name,
      status: "ready",
      description: w.manifest.description,
      version: w.manifest.version,
      workflow_fingerprint: registeredWorkflowFingerprint(w),
      last_loaded_at: state?.loadedAt ?? w.loadedAt ?? null,
      params: detail
    };
  }

  /** dry_run：仅热加载、GET object_info 与纯计算；不触碰 DB、调度器或提交端点。 */
  async dryRun(req: { workflow: string; runs: RunSpec[] }): Promise<DryRunView> {
    if (req.runs.length < 1 || req.runs.length > 200) {
      throw new ComfyLightError("INVALID_RUNS", "dry-run runs 数量须为 1–200");
    }
    const report = await this.registry.refresh();
    if (report.scanFailed) {
      return invalidWorkflowDryRun(req.workflow, req.runs.length, {
        code: "WORKFLOW_SCAN_FAILED",
        message: "无法确认工作流文件最新状态；本次仅预检，未使用旧缓存版本"
      });
    }
    const state = this.registry.statusOf(req.workflow);
    if (state?.status === "invalid") {
      return invalidWorkflowDryRun(req.workflow, req.runs.length, state.error ?? { message: "未知工作流加载错误" });
    }
    const wf = this.resolveWorkflow(req.workflow);
    const objectInfo = await this.objectInfo.get();
    return calculateDryRun(wf, req.runs, objectInfo);
  }

  /**
   * run_workflow（单 params 简写，P2 兼容）：参数错误抛 ParamsValidationError（先于连通性检查）；
   * 提交走统一调度管线（受双窗口约束，首个 tick 同步执行以保持"立即提交"体验）。
   * 幂等命中先行（含请求指纹比对——同键不同内容 → IDEMPOTENCY_CONFLICT，离线可判）。
   */
  async runSingle(req: {
    workflow: string;
    params: Record<string, unknown>;
    label?: string;
    idempotencyKey?: string;
    continueOnError?: boolean;
    maxAttempts?: number;
  }): Promise<RunHandleView> {
    await this.refreshForExecution();
    const wf = this.resolveWorkflow(req.workflow);
    if (req.idempotencyKey) {
      const existing = this.store.getBatchByIdempotencyKey(req.idempotencyKey);
      if (existing) {
        assertIdempotencyMatch(existing, computeRequestFingerprint(wf, {
          runs: [{ label: req.label, params: req.params }],
          continueOnError: req.continueOnError,
          maxAttempts: req.maxAttempts
        }));
        const job = this.store.getJob(existing.id, 0);
        return { batch_id: existing.id, index: 0, status: job?.status ?? "pending" };
      }
    }
    // Match existing keys before validating new work, just like runBatch.
    // Parameter errors still take precedence over backend connectivity errors.
    validateParams(wf.manifest, req.params);
    this.assertConnected();
    const created = this.manager.createBatch(wf, {
      runs: [{ label: req.label, params: req.params }],
      idempotencyKey: req.idempotencyKey,
      continueOnError: req.continueOnError,
      maxAttempts: req.maxAttempts
    });
    if (!created.reused) {
      this.start();
      await this.scheduler.tick(); // 立即推进一拍（不等首个周期）
    }
    const job = this.store.getJob(created.batchId, 0);
    return { batch_id: created.batchId, index: 0, status: job?.status ?? "pending" };
  }

  /**
   * run_workflow（runs 数组，批量）：结构性错误抛 ComfyLightError；
   * 单 run 参数错误 → invalid job（部分容错），合法任务照常执行。
   * 幂等命中先行（只读语义，不受连通性影响；同键不同内容 → IDEMPOTENCY_CONFLICT）。
   */
  async runBatch(req: {
    workflow: string;
    runs: RunSpec[];
    idempotencyKey?: string;
    continueOnError?: boolean;
    maxAttempts?: number;
  }): Promise<BatchHandleView> {
    await this.refreshForExecution();
    const wf = this.resolveWorkflow(req.workflow);
    if (req.idempotencyKey) {
      const existing = this.store.getBatchByIdempotencyKey(req.idempotencyKey);
      if (existing) {
        assertIdempotencyMatch(existing, computeRequestFingerprint(wf, req));
        return { batch_id: existing.id, total: existing.total, invalid: this.manager.getBatchView(existing.id, { limit: 1 }).stats.invalid, reused: true, status: existing.status };
      }
    }
    this.assertConnected();
    const created = this.manager.createBatch(wf, {
      runs: req.runs,
      idempotencyKey: req.idempotencyKey,
      continueOnError: req.continueOnError,
      maxAttempts: req.maxAttempts
    });
    if (!created.reused) {
      this.start();
      await this.scheduler.tick(); // 立即推进一拍
    }
    const batch = this.store.getBatch(created.batchId)!;
    return { batch_id: created.batchId, total: created.total, invalid: created.invalid, reused: created.reused, status: batch.status };
  }

  /** get_batch：汇总 + 分页 */
  getBatch(batchId: string, opts: { limit?: number; offset?: number; status?: string } = {}): BatchView {
    return this.manager.getBatchView(batchId, opts);
  }

  /**
   * get_result：单 job 详情（outputs 为本地绝对路径）。
   * download=true（默认）：AUTO_SAVE_OUTPUTS=false 时按需下载缺失的输出并持久化（幂等）。
   */
  async getResult(batchId: string, index: number, opts: { download?: boolean } = {}): Promise<ResultView> {
    const batch = this.store.getBatch(batchId);
    if (!batch) {
      throw new ComfyLightError("NOT_FOUND", `batch "${renderBounded(batchId, 40)}" 不存在`);
    }
    const job = this.store.getJob(batchId, index);
    if (!job) {
      throw new ComfyLightError("NOT_FOUND", `batch 内不存在 index=${index} 的 job（共 ${batch.total} 个）`);
    }
    let outputs: Array<Record<string, unknown>> = [];
    if (job.outputs_json) {
      try {
        outputs = JSON.parse(job.outputs_json) as Array<Record<string, unknown>>;
      } catch {
        outputs = [];
      }
    }
    // 收集器检查真实文件，补下载尚未落盘或已被删除的输出。
    if (opts.download !== false && job.status === "succeeded") {
      const collected = await this.results.collect(job, true);
      if (collected.failure) throw collected.failure;
      outputs = collected.assets as unknown as Array<Record<string, unknown>>;
    }
    let error = null;
    if (job.error_json) {
      try {
        error = JSON.parse(job.error_json) as Record<string, unknown>;
      } catch {
        error = { code: "PARSE_ERROR", message: renderBounded(job.error_json, 200) };
      }
    }
    let resolved = null;
    if (job.resolved_json) {
      try {
        resolved = JSON.parse(job.resolved_json) as Record<string, unknown>;
      } catch {
        resolved = null;
      }
    }
    return {
      batch_id: batchId,
      index,
      workflow: batch.workflow,
      status: job.status,
      params_resolved: resolved,
      outputs,
      error
    };
  }

  /** Batch delivery snapshot; does not start/retry generation. */
  getResultIndex(batchId: string, opts: { download?: boolean } = {}): Promise<BatchResultIndex> {
    return this.results.index(batchId, opts.download !== false);
  }

  /** 启动恢复（A1 语义 + P4.1 加固在 recovery.ts 落实；恢复后 pending job 由 Scheduler 自然续跑） */
  async recover(): Promise<RecoveryReport> {
    this.recovery ??= recoverInFlight({
      client: this.client,
      store: this.store,
      assets: this.assets,
      tracker: this.tracker,
      autoSave: this.config.autoSaveOutputs,
      registry: this.registry
    }).finally(() => { this.recovery = null; });
    return this.recovery;
  }

  private async reconcileConnection(): Promise<void> {
    // 周期刷新独立于 tick 的关键路径：不把真实 fs I/O 塞进 tick 的互斥窗口。
    // 若刷新尚未完成，本拍保持原内存代际；run/list/dry-run 入口仍会 await 最新刷新。
    if (Date.now() - this.lastWorkflowRefreshAt >= 3000) {
      this.lastWorkflowRefreshAt = Date.now();
      void this.refreshForExecution().catch(() => { /* 下一周期重试 */ });
    }
    const stats = this.client.ws.getStats();
    if (stats.state !== "open") {
      this.lastReconciledAt = 0;
      return;
    }
    // Bound unknown reconciliation to one pass per three seconds; reconnects
    // bypass the interval. Scheduler serializes this before every submit loop.
    const epoch = stats.reconnects ?? 0;
    if (this.lastReconciledAt && epoch === this.connectionEpoch && Date.now() - this.lastReconciledAt < 3000) return;
    await this.recover();
    this.connectionEpoch = epoch;
    this.lastReconciledAt = Date.now();
  }

  private refreshForExecution(): Promise<void> {
    this.workflowRefresh ??= this.registry.refresh().then((report) => {
      if (report.scanFailed) {
        throw new ComfyLightError("WORKFLOW_INVALID", "无法确认工作流文件的最新状态，本操作已停止；不会使用缓存旧版本");
      }
    }).finally(() => {
      this.workflowRefresh = null;
    });
    return this.workflowRefresh;
  }

  private resolveWorkflow(name: string) {
    const state = this.registry.statusOf(name);
    if (state?.status === "invalid") {
      throw new ComfyLightError(
        "WORKFLOW_INVALID",
        `工作流 "${name}" 当前文件无效: ${state.error?.message ?? "未知加载错误"}。请修复文件；不会静默执行旧版本`
      );
    }
    const wf = this.registry.get(name);
    if (!wf) {
      const available = this.registry.list().filter((w) => w.status === "ready").map((w) => w.name).join(", ") || "<无>";
      const reason = state?.status === "deleted" ? "已删除" : "未注册";
      throw new ComfyLightError(
        "NOT_FOUND",
        `工作流 "${name}" ${reason}。可用: ${available}。先用 list_workflows 查看。`
      );
    }
    return wf;
  }

  private assertConnected(): void {
    if (this.client.ws.getStats().state !== "open") {
      throw new ComfyLightError("COMFY_UNREACHABLE", "ComfyUI WebSocket 未连接（服务可能未启动）。本工具不自动启动 ComfyUI，请先启动后重试。");
    }
  }
}
