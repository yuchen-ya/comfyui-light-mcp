import type { ObjectInfoSnapshot } from "./object-info.js";
import type { RegisteredWorkflow } from "./registry.js";
import { registeredWorkflowFingerprint } from "./registry.js";
import { applyParams, ParamsValidationError, validateParams } from "./mapper.js";
import { preflightWorkflow, type PreflightIssue } from "./preflight.js";
import type { RunSpec } from "../batch/manager.js";
import type { WorkflowGraph } from "../client/types.js";
import { clipTail } from "../../shared/truncate.js";

export type DryRunCheckStatus = "passed" | "failed" | "unknown";

export interface DryRunIssue {
  index?: number;
  node_id?: string;
  input?: string;
  param?: string;
  code: string;
  message: string;
}

export interface DryRunView {
  dry_run: true;
  valid: boolean;
  workflow: string;
  workflow_fingerprint: string | null;
  runs: {
    total: number;
    valid: number;
    invalid: number;
    invalid_runs: Array<{ index: number; error_count: number; errors_truncated?: boolean }>;
  };
  checks: {
    json_format: DryRunCheckStatus;
    workflow_structure: DryRunCheckStatus;
    node_types: DryRunCheckStatus;
    manifest_mapping: DryRunCheckStatus;
    parameters: DryRunCheckStatus;
    model_dependencies: DryRunCheckStatus;
  };
  models: { found: number; missing: number; unknown: number };
  errors: DryRunIssue[];
  warnings: DryRunIssue[];
  errors_truncated: number;
  warnings_truncated: number;
  details_truncated?: boolean;
  validation_sources: {
    node_schema: { source: string; fetched_at: string | null; epoch: number };
  };
  submission: "not_submitted";
}

const MAX_ERRORS = 30;
const MAX_WARNINGS = 10;

const ERROR_CODE: Record<string, string> = {
  combo_value_invalid: "INVALID_COMBO_VALUE"
};

function publicIssue(issue: PreflightIssue): DryRunIssue {
  return {
    index: issue.run,
    node_id: issue.node_id,
    input: issue.input,
    param: issue.param,
    code: ERROR_CODE[issue.code] ?? issue.code.toUpperCase(),
    message: issue.message
  };
}

function finalStatus(failed: boolean, unknown: boolean): DryRunCheckStatus {
  return failed ? "failed" : unknown ? "unknown" : "passed";
}

/**
 * Dry-run 的唯一计算入口：只读取已注册对象和 object_info 快照。
 * 不接收 DB/Scheduler/Comfy 提交客户端，从结构上禁止生成副作用。
 */
export function calculateDryRun(
  wf: RegisteredWorkflow,
  runs: RunSpec[],
  objectInfo: ObjectInfoSnapshot
): DryRunView {
  const errors: DryRunIssue[] = [];
  const warnings: DryRunIssue[] = [];
  const invalidRuns: DryRunView["runs"]["invalid_runs"] = [];
  const models = { found: 0, missing: 0, unknown: 0 };
  let errorTotal = 0;
  let warningTotal = 0;
  let skipped = 0;
  let detailsTruncated = false;
  let structureFailed = false;
  let structureUnknown = false;
  let nodeFailed = false;
  let nodeUnknown = false;
  let manifestFailed = false;
  let manifestUnknown = false;
  let paramsFailed = false;
  let modelFailed = false;
  let modelUnknown = false;

  const pushIssue = (target: DryRunIssue[], issue: DryRunIssue, warning: boolean): void => {
    const total = warning ? ++warningTotal : ++errorTotal;
    const limit = warning ? MAX_WARNINGS : MAX_ERRORS;
    if (target.length < limit) target.push({ ...issue, message: clipTail(issue.message, 200) });
    else if (total === limit + 1) detailsTruncated = true;
  };

  for (let index = 0; index < runs.length; index++) {
    let graph: WorkflowGraph;
    try {
      const params = runs[index]!.params;
      validateParams(wf.manifest, params);
      graph = applyParams(wf.graph, wf.manifest, params).graph;
    } catch (e) {
      skipped++;
      paramsFailed = true;
      const issues = e instanceof ParamsValidationError
        ? e.issues
        : [{ param: "<root>", message: e instanceof Error ? e.message : String(e) }];
      let count = 0;
      for (const issue of issues) {
        pushIssue(errors, { index, param: issue.param, code: "INVALID_PARAMS", message: issue.message }, false);
        count++;
      }
      invalidRuns.push({ index, error_count: count });
      continue;
    }

    const report = preflightWorkflow({ graph, manifest: wf.manifest, objectInfo: objectInfo.nodes, runIndex: index });
    models.found += report.models.found;
    models.missing += report.models.missing;
    models.unknown += report.models.unknown;
    let runErrorCount = 0;
    for (const issue of report.issues) {
      const isError = issue.severity === "error";
      if (isError) runErrorCount++;
      pushIssue(isError ? errors : warnings, publicIssue(issue), !isError);

      if (issue.code.startsWith("manifest_")) {
        if (isError) manifestFailed = true;
        else manifestUnknown = true;
      }
      if (issue.code === "model_missing") modelFailed = true;
      if (issue.code === "model_unknown") modelUnknown = true;
      if (["invalid_node_id", "invalid_node", "invalid_link", "unknown_node_ref", "invalid_output_index", "no_output_node"].includes(issue.code)) {
        if (isError) structureFailed = true;
        else structureUnknown = true;
      }
      if (["unknown_class_type", "unknown_input", "missing_required", "combo_value_invalid", "value_type_mismatch", "value_out_of_range", "value_step_mismatch", "output_index_out_of_range", "type_mismatch"].includes(issue.code)) {
        if (isError) nodeFailed = true;
        else nodeUnknown = true;
      }
      if (["schema_unavailable", "schema_unparseable", "combo_unverified", "input_spec_unverified", "output_index_unverified"].includes(issue.code)) {
        nodeUnknown = true;
        if (issue.code === "schema_unavailable") structureUnknown = true;
      }
      if (issue.code === "manifest_input_unverified") manifestUnknown = true;
    }
    if (report.truncated) detailsTruncated = true;
    if (runErrorCount > 0) {
      invalidRuns.push({ index, error_count: runErrorCount, ...(report.truncated ? { errors_truncated: true } : {}) });
    }
  }

  if (objectInfo.source === "stale") {
    nodeUnknown = true;
    manifestUnknown = true;
    modelUnknown = true;
    pushIssue(warnings, {
      code: "OBJECT_INFO_STALE",
      message: objectInfo.warning ?? "object_info 刷新失败，本次仅使用明确标记的过期缓存"
    }, true);
  } else if (objectInfo.source === "unavailable") {
    nodeUnknown = true;
    structureUnknown = true;
    manifestUnknown = true;
    modelUnknown = true;
    pushIssue(warnings, {
      code: "OBJECT_INFO_UNAVAILABLE",
      message: `object_info 不可用: ${objectInfo.error ?? "未知错误"}`
    }, true);
  }
  if (skipped > 0) {
    nodeUnknown = true;
    manifestUnknown = true;
    modelUnknown = true;
    if (skipped === runs.length) structureUnknown = true;
  }

  const validRuns = runs.length - invalidRuns.length;
  return {
    dry_run: true,
    valid: invalidRuns.length === 0,
    workflow: wf.manifest.name,
    workflow_fingerprint: registeredWorkflowFingerprint(wf),
    runs: { total: runs.length, valid: validRuns, invalid: invalidRuns.length, invalid_runs: invalidRuns },
    checks: {
      json_format: "passed",
      workflow_structure: finalStatus(structureFailed, structureUnknown),
      node_types: finalStatus(nodeFailed, nodeUnknown),
      manifest_mapping: finalStatus(manifestFailed, manifestUnknown),
      parameters: paramsFailed ? "failed" : "passed",
      model_dependencies: finalStatus(modelFailed, modelUnknown)
    },
    models,
    errors,
    warnings,
    errors_truncated: Math.max(0, errorTotal - errors.length),
    warnings_truncated: Math.max(0, warningTotal - warnings.length),
    validation_sources: {
      node_schema: {
        source: objectInfo.source,
        fetched_at: objectInfo.fetchedAt > 0 ? new Date(objectInfo.fetchedAt).toISOString() : null,
        epoch: objectInfo.epoch
      }
    },
    submission: "not_submitted",
    ...(detailsTruncated ? { details_truncated: true } : {})
  };
}

export function invalidWorkflowDryRun(
  workflow: string,
  total: number,
  error: { code?: string; message: string; node_id?: string; input?: string }
): DryRunView {
  const code = error.code ?? "WORKFLOW_INVALID";
  const jsonFailed = code === "INVALID_JSON" || (code === "INVALID_MANIFEST" && error.message.includes("不是合法 JSON"));
  const manifestFailed = code.startsWith("INVALID_MANIFEST") || code.startsWith("MANIFEST_") || code === "INCOMPATIBLE_MANIFEST_TYPE";
  return {
    dry_run: true,
    valid: false,
    workflow,
    workflow_fingerprint: null,
    runs: {
      total,
      valid: 0,
      invalid: total,
      invalid_runs: Array.from({ length: total }, (_, index) => ({ index, error_count: 1 }))
    },
    checks: {
      json_format: jsonFailed ? "failed" : "passed",
      workflow_structure: jsonFailed ? "unknown" : manifestFailed ? "unknown" : "failed",
      node_types: "unknown",
      manifest_mapping: manifestFailed ? "failed" : "unknown",
      parameters: "unknown",
      model_dependencies: "unknown"
    },
    models: { found: 0, missing: 0, unknown: 0 },
    errors: [{ code, message: clipTail(error.message, 200), node_id: error.node_id, input: error.input }],
    warnings: [],
    errors_truncated: 0,
    warnings_truncated: 0,
    validation_sources: { node_schema: { source: "not_queried", fetched_at: null, epoch: 0 } },
    submission: "not_submitted"
  };
}
