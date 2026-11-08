import type Database from "better-sqlite3";
import type { AppConfig } from "../config.js";
import type { ComfyClient } from "./client/index.js";
import { WorkflowRegistry, type LoadReport } from "./workflow/registry.js";
import { BatchStore } from "./batch/store.js";
import { JobRunner } from "./batch/runner.js";
import { JobTracker } from "./batch/tracker.js";
import { recoverInFlight, type RecoveryReport } from "./batch/recovery.js";
import { AssetManager } from "./assets/asset-manager.js";
import { validateParams } from "./workflow/mapper.js";
import { ComfyLightError } from "../shared/errors.js";
import { renderBounded } from "../shared/truncate.js";

/**
 * Core Engine facade（docs/002 §4.4）：MCP 层唯一入口，纯 TS 不依赖 MCP SDK。
 * P2：单运行（runSingle）；P3 批量在同一管线上扩展（runs 数组 → 循环 submitSingle + 调度窗口）。
 */

export interface RunHandleView {
  batch_id: string;
  index: number;
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
  }

  /** 启动扫描（目录读取为异步，一次性完成后注册表常驻内存） */
  async loadWorkflowsAsync(): Promise<LoadReport> {
    return this.registry.load();
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

  /** run_workflow（P2 单运行）。参数错误抛 ParamsValidationError（先于连通性检查）；ComfyUI 不可达抛 ComfyLightError */
  async runSingle(req: { workflow: string; params: Record<string, unknown>; label?: string }): Promise<RunHandleView> {
    const wf = this.registry.get(req.workflow);
    if (!wf) {
      throw new ComfyLightError(
        "NOT_FOUND",
        `工作流 "${req.workflow}" 未注册。可用: ${this.registry.list().map((w) => w.name).join(", ") || "<无>"}。先用 list_workflows 查看。`
      );
    }
    // 参数校验先于连通性检查：参数错误与 ComfyUI 在线与否无关（错误自愈优先）
    validateParams(wf.manifest, req.params);
    if (this.client.ws.getStats().state !== "open") {
      throw new ComfyLightError("COMFY_UNREACHABLE", "ComfyUI WebSocket 未连接（服务可能未启动）。本工具不自动启动 ComfyUI，请先启动后重试。");
    }
    const handle = await this.runner.submitSingle(wf, req.params, req.label);
    return { batch_id: handle.batchId, index: handle.index, status: handle.status };
  }

  /** get_result：单 job 详情（供轮询；outputs 为本地绝对路径） */
  getResult(batchId: string, index: number): ResultView {
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

  /** 启动恢复（A1 语义在 recovery.ts 落实） */
  async recover(): Promise<RecoveryReport> {
    return recoverInFlight({
      client: this.client,
      store: this.store,
      assets: this.assets,
      tracker: this.tracker,
      autoSave: this.config.autoSaveOutputs
    });
  }
}
