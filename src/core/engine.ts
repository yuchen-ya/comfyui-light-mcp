import type Database from "better-sqlite3";
import type { AppConfig } from "../config.js";
import type { ComfyClient } from "./client/index.js";
import { WorkflowRegistry, type LoadReport } from "./workflow/registry.js";
import { BatchStore, type JobOutputAsset } from "./batch/store.js";
import { JobRunner } from "./batch/runner.js";
import { JobTracker } from "./batch/tracker.js";
import { BatchManager, type BatchView, type RunSpec, computeRequestFingerprint, assertIdempotencyMatch } from "./batch/manager.js";
import { Scheduler } from "./batch/scheduler.js";
import { recoverInFlight, type RecoveryReport } from "./batch/recovery.js";
import { AssetManager } from "./assets/asset-manager.js";
import { validateParams } from "./workflow/mapper.js";
import { ComfyLightError } from "../shared/errors.js";
import { renderBounded } from "../shared/truncate.js";

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

  constructor(
    readonly config: AppConfig,
    private readonly client: ComfyClient,
    db: Database.Database
  ) {
    this.registry = new WorkflowRegistry(config.workflowsDir);
    this.store = new BatchStore(db);
    this.assets = new AssetManager(client, config.outputDir);
    this.tracker = new JobTracker({
      client,
      store: this.store,
      assets: this.assets,
      autoSave: config.autoSaveOutputs,
      defaultTimeoutMs: config.jobTimeoutMs
    });
    this.runner = new JobRunner({ client, store: this.store, tracker: this.tracker });
    this.manager = new BatchManager(this.store);
    this.scheduler = new Scheduler({
      store: this.store,
      registry: this.registry,
      runner: this.runner,
      maxInFlight: config.maxInFlight,
      maxQueuedJobs: config.maxQueuedJobs
    });
  }

  /** 启动扫描（目录读取为异步，一次性完成后注册表常驻内存） */
  async loadWorkflowsAsync(): Promise<LoadReport> {
    return this.registry.load();
  }

  /** 启动调度（恢复完成后调用；周期定时器 unref，不阻塞进程退出） */
  start(): void {
    this.scheduler.ensureStarted();
  }

  /** 关停：调度停摆 + 释放全部跟踪资源（不改动 job 状态） */
  stop(): void {
    this.scheduler.stop();
    this.tracker.disposeAll();
  }

  /** list_workflows：摘要 / 指定名详情 */
  listWorkflows(name?: string): Record<string, unknown> {
    if (name === undefined) {
      const list = this.registry.list();
      return { workflows: list, hint: "传 workflow=<name> 获取该工作流完整参数说明" };
    }
    const detail = this.registry.paramDetail(name);
    if (!detail) {
      return { error: { code: "NOT_FOUND", message: `工作流 "${name}" 未注册。可用: ${this.registry.list().map((w) => w.name).join(", ") || "<无>"}` } };
    }
    const w = this.registry.get(name)!;
    return { name, description: w.manifest.description, version: w.manifest.version, params: detail };
  }

  /**
   * run_workflow（单 params 简写，P2 兼容）：参数错误抛 ParamsValidationError（先于连通性检查）；
   * 提交走统一调度管线（受双窗口约束，首个 tick 同步执行以保持"立即提交"体验）。
   * 幂等命中先行（含请求指纹比对——同键不同内容 → IDEMPOTENCY_CONFLICT，离线可判）。
   */
  async runSingle(req: { workflow: string; params: Record<string, unknown>; label?: string; idempotencyKey?: string }): Promise<RunHandleView> {
    const wf = this.resolveWorkflow(req.workflow);
    // 参数校验先于连通性检查：参数错误与 ComfyUI 在线与否无关（错误自愈优先）
    validateParams(wf.manifest, req.params);
    if (req.idempotencyKey) {
      const existing = this.store.getBatchByIdempotencyKey(req.idempotencyKey);
      if (existing) {
        assertIdempotencyMatch(existing, computeRequestFingerprint(wf, { runs: [{ label: req.label, params: req.params }] }));
        const job = this.store.getJob(existing.id, 0);
        return { batch_id: existing.id, index: 0, status: job?.status ?? "pending" };
      }
    }
    this.assertConnected();
    const created = this.manager.createBatch(wf, {
      runs: [{ label: req.label, params: req.params }],
      idempotencyKey: req.idempotencyKey
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
    // 按需下载（AUTO_SAVE_OUTPUTS=false 或恢复时未落盘）：仅 succeeded 且存在未下载引用
    if (opts.download !== false && job.status === "succeeded") {
      const missing = outputs.filter(
        (o) => typeof o["local_path"] === "string" && (o["local_path"] as string) === ""
      ) as Array<Pick<JobOutputAsset, "kind" | "filename" | "subfolder" | "type">>;
      if (missing.length > 0) {
        const downloaded = await this.assets.downloadRefs(batchId, index, missing);
        const byRef = new Map(downloaded.map((d) => [`${d.filename}|${d.subfolder}`, d]));
        outputs = outputs.map((o) => {
          const lp = o["local_path"];
          if (typeof lp === "string" && lp !== "") return o;
          const hit = byRef.get(`${String(o["filename"])}|${String(o["subfolder"] ?? "")}`);
          return hit ? (hit as unknown as Record<string, unknown>) : o;
        });
        this.store.patchJob(job.id, { outputs_json: JSON.stringify(outputs) });
      }
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

  /** 启动恢复（A1 语义 + P4.1 加固在 recovery.ts 落实；恢复后 pending job 由 Scheduler 自然续跑） */
  async recover(): Promise<RecoveryReport> {
    return recoverInFlight({
      client: this.client,
      store: this.store,
      assets: this.assets,
      tracker: this.tracker,
      autoSave: this.config.autoSaveOutputs,
      registry: this.registry
    });
  }

  private resolveWorkflow(name: string) {
    const wf = this.registry.get(name);
    if (!wf) {
      throw new ComfyLightError(
        "NOT_FOUND",
        `工作流 "${name}" 未注册。可用: ${this.registry.list().map((w) => w.name).join(", ") || "<无>"}。先用 list_workflows 查看。`
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
