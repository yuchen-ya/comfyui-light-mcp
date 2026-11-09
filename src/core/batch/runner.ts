import { randomUUID } from "node:crypto";
import type { ComfyClient } from "../client/index.js";
import type { RegisteredWorkflow } from "../workflow/registry.js";
import { applyParams, validateParams, type ParamIssue } from "../workflow/mapper.js";
import { ComfyLightError } from "../../shared/errors.js";
import type { BatchStore } from "./store.js";
import { type JobRow, type JobError } from "./store.js";
import type { JobTracker } from "./tracker.js";

/**
 * JobRunner：job 提交管线（submitJob 为唯一提交路径；P2 的 submitSingle 是它的单运行便捷封装）。
 *
 * A1 关键顺序（崩溃恢复语义，Task 004 不变）：
 *   ① 校验参数 → ② 生图（模板副本）→ ③ 生成 prompt_id
 *   → ④ 事务落库（job.status=submitting + prompt_id + attempt 行）   ← 先落库（claimForSubmit）
 *   → ⑤ POST /prompt                                                 ← 后提交
 *   崩溃于 ⑤ 前后：恢复时凭已持久化的 prompt_id 查证 /history 与 /queue；
 *   两处皆无 → 保持 submission_unknown（绝不自动重提，绝不伪装 failed）。
 *
 * 防重复提交：claimForSubmit 以 `WHERE status='pending'` 条件占位——
 * 多个 scheduler tick 并发到达时，只有一个能占位成功，其余拿到 null 直接退出。
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

/** node_errors 归一化条目（形状按真实 0.41 样本验证，docs/005 §七） */
export interface NormalizedNodeError {
  node: string;
  class_type?: string;
  input?: string;
  type: string;
  message: string;
  received_value?: unknown;
}

/**
 * ComfyUI node_errors 归一化：
 * 原始形状（0.41 实测）{
 *   "7": { errors: [{ type, message, details, extra_info: { input_name, received_value } }],
 *          dependent_outputs, class_type } }
 * → 紧凑数组 [{node, class_type, input, type, message, received_value}]（有界、可读、含定位）
 */
export function normalizeNodeErrors(nodeErrors: unknown): NormalizedNodeError[] {
  if (!nodeErrors || typeof nodeErrors !== "object" || Array.isArray(nodeErrors)) return [];
  const out: NormalizedNodeError[] = [];
  for (const [nodeId, v] of Object.entries(nodeErrors as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const n = v as { class_type?: unknown; errors?: unknown };
    const errors = Array.isArray(n.errors) ? n.errors : [];
    for (const e of errors) {
      if (!e || typeof e !== "object") continue;
      const er = e as Record<string, unknown>;
      const extra = (er["extra_info"] ?? null) as Record<string, unknown> | null;
      out.push({
        node: nodeId,
        class_type: typeof n.class_type === "string" ? n.class_type : undefined,
        input: extra && typeof extra["input_name"] === "string" ? extra["input_name"] : undefined,
        type: String(er["type"] ?? "unknown"),
        message: String(er["details"] ?? er["message"] ?? "").slice(0, 300),
        received_value: extra ? extra["received_value"] : undefined
      });
    }
  }
  return out;
}

export class JobRunner {
  constructor(private readonly deps: RunnerDeps) {}

  /**
   * 提交一个已存在的 pending job（Batch Manager / Scheduler 路径；也是 submitSingle 的内核）。
   * - registry 在 batch 创建后可能变化 → 提交前重新校验，失败落 invalid（部分容错，不抛）
   * - ComfyUI 拒绝 → failed 终态（不抛）
   * - 网络失败 → submission_unknown（不抛、不重提）
   * - 占位失败（已被并发路径处理/状态已变）→ 返回 null
   */
  async submitJob(wf: RegisteredWorkflow, job: JobRow): Promise<SubmitHandle | null> {
    let params: Record<string, unknown>;
    try {
      params = JSON.parse(job.params_json) as Record<string, unknown>;
    } catch {
      this.markInvalid(job, "params_json 无法解析（内部数据损坏）", []);
      return { batchId: job.batch_id, index: job.idx, status: "invalid" };
    }
    try {
      validateParams(wf.manifest, params);
    } catch (e) {
      const issues = e instanceof Error && "issues" in e ? (e as { issues: ParamIssue[] }).issues : [];
      // 提交时才发现参数非法（batch 创建与提交之间 manifest 变更等）→ invalid，不阻断其余 job
      this.markInvalid(job, "提交前校验失败（manifest 可能已变更）", issues);
      return { batchId: job.batch_id, index: job.idx, status: "invalid" };
    }
    const { graph, resolved } = applyParams(wf.graph, wf.manifest, params);
    const promptId = randomUUID(); // 客户端指定 prompt_id（0.41 实测支持，docs/003 F2）；每次尝试全新 id
    const now = new Date().toISOString();

    // ④ 条件占位 + 事务落库（prompt_id 已持久化后才有资格 POST）
    const claim = this.deps.store.claimForSubmit(job.id, promptId, JSON.stringify(resolved), now);
    if (!claim) return null;

    // ⑤ 提交
    let accepted: Awaited<ReturnType<ComfyClient["http"]["submitPrompt"]>>;
    try {
      accepted = await this.deps.client.http.submitPrompt(graph, {
        clientId: this.deps.client.clientId,
        promptId
      });
    } catch (err) {
      // 网络/超时：提交结果未知 → submission_unknown（保持，不重提）
      const message = err instanceof ComfyLightError ? err.message : String(err);
      this.deps.store.patchJob(job.id, {
        status: "submission_unknown",
        error_json: JSON.stringify({
          code: "SUBMISSION_UNKNOWN",
          message: `提交结果未知（已持久化 prompt_id=${promptId}，不会自动重提）。原因: ${message}`
        } satisfies JobError)
      });
      this.deps.store.patchAttemptStatus(job.id, claim.attemptNo, "submission_unknown", new Date().toISOString());
      this.finishBatch(job.batch_id);
      return { batchId: job.batch_id, index: job.idx, status: "submission_unknown" };
    }

    if (!accepted.ok) {
      const normalized = normalizeNodeErrors(accepted.nodeErrors ?? accepted.errorBody);
      const errType =
        accepted.errorBody && typeof accepted.errorBody === "object"
          ? String((accepted.errorBody as Record<string, unknown>)["type"] ?? "<unknown>")
          : "<unknown>";
      const brief = normalized
        .slice(0, 5)
        .map((n) => `${n.node}${n.input ? `/${n.input}` : ""}: ${n.type}${n.message ? ` — ${n.message}` : ""}`)
        .join("; ");
      const err: JobError = {
        code: "COMFY_REJECTED",
        message: `ComfyUI 拒绝提交（HTTP ${accepted.httpStatus}, ${errType}）${brief ? `: ${brief}` : ""}`,
        node_errors: normalized
      };
      this.deps.store.patchJob(job.id, {
        status: "failed",
        error_json: JSON.stringify(err),
        finished_at: new Date().toISOString()
      });
      this.deps.store.patchAttemptStatus(job.id, claim.attemptNo, "failed", new Date().toISOString());
      this.finishBatch(job.batch_id);
      return { batchId: job.batch_id, index: job.idx, status: "failed" };
    }

    // 服务端回显校验：若 ComfyUI 忽略客户端 id 而自派新 id，以回显为准并回写（保语义正确）
    const effectivePromptId = accepted.promptId || promptId;
    this.deps.store.patchJob(job.id, { status: "queued", prompt_id: effectivePromptId });
    this.deps.store.patchAttemptStatus(job.id, claim.attemptNo, "queued", new Date().toISOString());
    if (effectivePromptId !== promptId) {
      this.deps.store.patchAttemptPrompt(job.id, claim.attemptNo, effectivePromptId);
    }
    const fresh = this.deps.store.getJobById(job.id)!;
    this.deps.tracker.track(fresh);
    return { batchId: job.batch_id, index: job.idx, status: "queued" };
  }

  /**
   * P2 兼容单运行：事务创建 1-job batch 后立即提交（测试/内部路径）。
   * MCP 层的 run_workflow 统一走 BatchManager + Scheduler（含单 params 调用）。
   */
  async submitSingle(wf: RegisteredWorkflow, params: Record<string, unknown>, label?: string): Promise<SubmitHandle> {
    validateParams(wf.manifest, params);
    const batchId = randomUUID();
    const jobId = randomUUID();
    const now = new Date().toISOString();
    this.deps.store.createBatchWithJobs(
      {
        id: batchId,
        workflow: wf.manifest.name,
        workflow_version: wf.manifest.version,
        idempotency_key: null,
        status: "running",
        total: 1,
        options_json: JSON.stringify({ continue_on_error: true, max_attempts: 1 }),
        created_at: now,
        finished_at: null,
        manifest_fingerprint: wf.fingerprints.manifestFingerprint,
        graph_fingerprint: wf.fingerprints.graphFingerprint,
        request_fingerprint: null // 内部便捷路径，不参与幂等
      },
      [
        {
          id: jobId,
          idx: 0,
          label: label ?? null,
          params_json: JSON.stringify(params),
          resolved_json: null, // 提交占位时写入（seed 等 effective 值以提交时为准）
          status: "pending",
          attempt_no: 0,
          prompt_id: null,
          error_json: null,
          outputs_json: null,
          submitted_at: null,
          started_at: null,
          finished_at: null
        }
      ]
    );
    const job = this.deps.store.getJobById(jobId)!;
    const handle = await this.submitJob(wf, job);
    return handle ?? { batchId, index: 0, status: this.deps.store.getJobById(jobId)!.status };
  }

  private markInvalid(job: JobRow, reason: string, issues: ParamIssue[]): void {
    this.deps.store.patchJob(job.id, {
      status: "invalid",
      error_json: JSON.stringify({
        code: "INVALID_PARAMS",
        message: `${reason}${issues.length ? `: ${issues.map((i) => `${i.param}: ${i.message}`).join("; ")}` : ""}`.slice(0, 1000)
      } satisfies JobError),
      finished_at: new Date().toISOString()
    });
    this.finishBatch(job.batch_id);
  }

  private finishBatch(batchId: string): void {
    const { status, finished } = this.deps.store.recomputeBatchStatus(batchId);
    this.deps.store.updateBatchStatus(batchId, status, finished ? new Date().toISOString() : null);
  }
}
