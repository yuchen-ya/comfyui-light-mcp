import { randomUUID } from "node:crypto";
import type { ComfyClient } from "../client/index.js";
import type { RegisteredWorkflow } from "../workflow/registry.js";
import { applyParams, validateParams } from "../workflow/mapper.js";
import { ComfyLightError } from "../../shared/errors.js";
import type { BatchStore} from "./store.js";
import { type JobRow, type JobError } from "./store.js";
import type { JobTracker } from "./tracker.js";

/**
 * JobRunner：单 job 提交管线（P2 单运行；P3 批量循环复用同一路径，无独立单任务流程）。
 *
 * A1 关键顺序（崩溃恢复语义）：
 *   ① 校验参数 → ② 生图（模板副本）→ ③ 生成 prompt_id
 *   → ④ 持久化 batch/job/attempt（status=submitting，prompt_id 已落库）   ← 先落库
 *   → ⑤ POST /prompt                                                       ← 后提交
 *   崩溃于 ⑤ 前后：恢复时凭已持久化的 prompt_id 查证 /history 与 /queue；
 *   两处皆无 → 保持 submission_unknown（绝不自动重提，绝不伪装 failed）。
 */

export interface SubmitHandle {
  batchId: string;
  index: number;
  status: JobRow["status"];
}

export interface RunnerDeps {
  client: ComfyClient;
  store: BatchStore;
  tracker: JobTracker;
}

export class JobRunner {
  constructor(private readonly deps: RunnerDeps) {}

  /**
   * 提交单个运行。参数非法抛 ParamsValidationError（P2 由工具层转为错误响应；
   * P3 批量路径在外层捕获并落 invalid job——部分容错在那层实现）。
   * 提交被 ComfyUI 拒绝（node 校验等）→ job=failed，返回 handle（不抛）。
   * 网络失败 → job=submission_unknown，返回 handle（不抛，不重提）。
   */
  async submitSingle(wf: RegisteredWorkflow, params: Record<string, unknown>, label?: string): Promise<SubmitHandle> {
    validateParams(wf.manifest, params);
    const { graph, resolved } = applyParams(wf.graph, wf.manifest, params);

    const batchId = randomUUID();
    const jobId = randomUUID();
    const promptId = randomUUID(); // 客户端指定 prompt_id（0.41 实测支持，docs/003 F2）
    const now = new Date().toISOString();

    // ④ 提交前持久化（prompt_id 落库后才有资格提交）
    this.deps.store.createBatch({
      id: batchId,
      workflow: wf.manifest.name,
      workflow_version: wf.manifest.version,
      idempotency_key: null,
      status: "running",
      total: 1,
      options_json: JSON.stringify({}),
      created_at: now,
      finished_at: null
    });
    this.deps.store.createJob({
      id: jobId,
      batch_id: batchId,
      idx: 0,
      label: label ?? null,
      params_json: JSON.stringify(params),
      resolved_json: JSON.stringify(resolved),
      status: "submitting",
      attempt_no: 1,
      prompt_id: promptId,
      error_json: null,
      outputs_json: null,
      submitted_at: now,
      started_at: null,
      finished_at: null
    });
    this.deps.store.insertAttempt({
      id: randomUUID(),
      job_id: jobId,
      attempt_no: 1,
      prompt_id: promptId,
      status: "submitting",
      submitted_at: now
    });

    // ⑤ 提交
    let accepted;
    try {
      accepted = await this.deps.client.http.submitPrompt(graph, {
        clientId: this.deps.client.clientId,
        promptId
      });
    } catch (err) {
      // 网络/超时：提交结果未知 → submission_unknown（保持，不重提）
      const message = err instanceof ComfyLightError ? err.message : String(err);
      this.deps.store.patchJob(jobId, {
        status: "submission_unknown",
        error_json: JSON.stringify({
          code: "SUBMISSION_UNKNOWN",
          message: `提交结果未知（已持久化 prompt_id=${promptId}，不会自动重提）。原因: ${message}`
        } satisfies JobError)
      });
      this.finishBatch(batchId);
      return { batchId, index: 0, status: "submission_unknown" };
    }

    if (!accepted.ok) {
      const err: JobError = {
        code: "COMFY_REJECTED",
        message: `ComfyUI 拒绝提交（HTTP ${accepted.httpStatus}）。可用 run_workflow 前置 dry-run 检查参数。`,
        node_errors: accepted.nodeErrors ?? accepted.errorBody
      };
      this.deps.store.patchJob(jobId, {
        status: "failed",
        error_json: JSON.stringify(err),
        finished_at: new Date().toISOString()
      });
      this.finishBatch(batchId);
      return { batchId, index: 0, status: "failed" };
    }

    // 服务端回显校验：若 ComfyUI 忽略客户端 id 而自派新 id，以回显为准并回写（保语义正确）
    const effectivePromptId = accepted.promptId || promptId;
    this.deps.store.patchJob(jobId, { status: "queued", prompt_id: effectivePromptId });
    const job = this.deps.store.getJobById(jobId)!;
    this.deps.tracker.track(job);
    return { batchId, index: 0, status: "queued" };
  }

  private finishBatch(batchId: string): void {
    const { status, finished } = this.deps.store.recomputeBatchStatus(batchId);
    this.deps.store.updateBatchStatus(batchId, status, finished ? new Date().toISOString() : null);
  }
}
