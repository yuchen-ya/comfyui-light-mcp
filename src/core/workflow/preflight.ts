import type { WorkflowGraph } from "../client/types.js";
import type { ManifestParam, WorkflowManifest } from "./manifest.js";
import { classifyModelInput } from "./object-info.js";
import type { NormalizedInputSpec, NormalizedNodeInfo } from "./object-info.js";
import { clipTail, renderBounded } from "../../shared/truncate.js";

/**
 * Preflight：提交前的纯只读静态检查（Task 010）。
 * 不读文件、不访问 DB、不发请求——输入只有 WorkflowGraph、WorkflowManifest
 * 和可选的 /object_info 规范化节点表（来自 ObjectInfoCache）。
 *
 * 诚实性原则：schema 不可确认的项必须给 warning（status 至少 warning），绝不假装 passed。
 * 返回有界结构化 issue（node_id/input/param/code/message，可选 run index），
 * 不回传完整 graph/schema/模型清单。
 */

export const MAX_PREFLIGHT_ISSUES = 50;
const MAX_MESSAGE_LENGTH = 200;
/** 与 manifest.ts 的 nodeRefPattern 一致（该处未导出，此处按相同规则复刻） */
const NODE_ID_PATTERN = /^[A-Za-z0-9_#-]{1,64}$/;

export type PreflightSeverity = "error" | "warning";

export type PreflightIssueCode =
  // 结构（无 schema 也检查）
  | "invalid_node_id"
  | "invalid_node"
  | "unknown_node_ref"
  | "invalid_link"
  | "invalid_output_index"
  | "output_index_unverified"
  | "output_index_out_of_range"
  | "type_mismatch"
  // schema 相关
  | "unknown_class_type"
  | "schema_unparseable"
  | "schema_unavailable"
  | "unknown_input"
  | "missing_required"
  | "combo_value_invalid"
  | "combo_unverified"
  | "input_spec_unverified"
  | "value_type_mismatch"
  | "value_out_of_range"
  | "value_step_mismatch"
  | "no_output_node"
  // 模型依赖
  | "model_missing"
  | "model_unknown"
  // manifest
  | "manifest_target_missing"
  | "manifest_input_unknown"
  | "manifest_input_unverified"
  | "manifest_type_mismatch"
  | "manifest_enum_out_of_choices"
  | "manifest_default_invalid"
  | "manifest_default_out_of_range";

export interface PreflightIssue {
  code: PreflightIssueCode;
  severity: PreflightSeverity;
  message: string;
  node_id?: string;
  input?: string;
  param?: string;
  /** 批量运行索引（单运行/无上下文时缺省） */
  run?: number;
}

export interface PreflightModelsSummary {
  found: number;
  missing: number;
  unknown: number;
}

export type PreflightStatus = "passed" | "warning" | "failed";

export interface PreflightReport {
  status: PreflightStatus;
  /** 是否拿到了可用 /object_info（false = schema 相关检查未执行，status 至少 warning） */
  schemaAvailable: boolean;
  issues: PreflightIssue[];
  /** issue 超过 MAX_PREFLIGHT_ISSUES 被截断 */
  truncated: boolean;
  models: PreflightModelsSummary;
}

export interface PreflightInput {
  graph: WorkflowGraph;
  manifest: WorkflowManifest;
  /** 可选：ObjectInfoCache.get()/peek() 返回的 nodes（null/缺省 = schema 不可用） */
  objectInfo?: Record<string, NormalizedNodeInfo> | null;
  /** 可选：批量运行索引，附加到每个 issue（run 字段） */
  runIndex?: number;
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

class IssueCollector {
  readonly issues: PreflightIssue[] = [];
  truncated = false;

  constructor(private readonly runIndex?: number) {}

  push(issue: Omit<PreflightIssue, "run">): void {
    if (this.issues.length >= MAX_PREFLIGHT_ISSUES) {
      this.truncated = true;
      return;
    }
    const bounded: PreflightIssue = {
      ...issue,
      message: clipTail(issue.message, MAX_MESSAGE_LENGTH)
    };
    if (this.runIndex !== undefined) bounded.run = this.runIndex;
    this.issues.push(bounded);
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** API JSON 连线形状：[nodeId, outputIndex]（首元素为字符串的二元组即按连线候选处理） */
function isLinkValue(v: unknown): v is [string, unknown] {
  return Array.isArray(v) && v.length === 2 && typeof v[0] === "string";
}

function preview(v: unknown): string {
  const s = typeof v === "string" ? clipTail(v, 40) : renderBounded(v, 40);
  return `"${s}"`;
}

function summarizeChoices(choices: readonly string[]): string {
  const head = choices.slice(0, 5).join(" | ");
  return choices.length > 5 ? `${head} | …共 ${choices.length} 项` : head;
}

function describeSpecType(spec: NormalizedInputSpec): string {
  switch (spec.kind) {
    case "combo":
      return `COMBO(${spec.choices.length} 选项)`;
    case "ref":
      return spec.type;
    case "unknown":
      return "<未知规格>";
    default:
      return spec.kind.toUpperCase();
  }
}

/** manifest 参数类型 → 可接入的输入规格 kind（白名单兼容矩阵；number→int 单独降级为 warning） */
const PARAM_KIND_COMPAT: Record<ManifestParam["type"], readonly NormalizedInputSpec["kind"][]> = {
  string: ["string", "combo"],
  number: ["float"],
  integer: ["int"],
  boolean: ["boolean"],
  enum: ["combo"]
};

const WILDCARD_TYPES = new Set(["*", "ANY"]);

/** 连线类型兼容（保守子集：精确匹配、INT→FLOAT、通配 * / ANY；不匹配的交给服务端即视为不兼容） */
function linkTypeOk(srcType: string, spec: NormalizedInputSpec): boolean {
  if (WILDCARD_TYPES.has(srcType)) return true;
  switch (spec.kind) {
    case "ref":
      return spec.type === srcType || WILDCARD_TYPES.has(spec.type);
    case "int":
      return srcType === "INT";
    case "float":
      return srcType === "FLOAT" || srcType === "INT";
    case "string":
      return srcType === "STRING";
    case "boolean":
      return srcType === "BOOLEAN";
    default:
      // combo/unknown 接线无可靠类型语义，不报
      return true;
  }
}

/** 字面值与规格类型是否相容（combo 只要求字符串；清单归属另查） */
function literalTypeOk(spec: NormalizedInputSpec, value: unknown): boolean {
  switch (spec.kind) {
    case "int":
      return typeof value === "number" && Number.isInteger(value);
    case "float":
      return typeof value === "number" && Number.isFinite(value);
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "combo":
      return typeof value === "string";
    case "ref":
      // 引用类型输入需要连线，字面值一律不合法
      return false;
    default:
      return true;
  }
}

const MODEL_KIND_LABEL: Record<string, string> = {
  ckpt: "checkpoint",
  lora: "LoRA",
  vae: "VAE",
  upscale: "放大",
  controlnet: "ControlNet",
  unet: "UNet",
  clip: "CLIP",
  clip_vision: "CLIP Vision",
  style_model: "Style Model",
  gligen: "GLIGEN",
  hypernetwork: "Hypernetwork"
};

// ---------------------------------------------------------------------------
// 主检查
// ---------------------------------------------------------------------------

export function preflightWorkflow(input: PreflightInput): PreflightReport {
  const schema = input.objectInfo ?? null;
  const schemaAvailable = schema !== null && Object.keys(schema).length > 0;
  const collector = new IssueCollector(input.runIndex);
  const models: PreflightModelsSummary = { found: 0, missing: 0, unknown: 0 };

  let sawOutputNode = false;
  let sawUnconfirmableClass = false;

  // ---- 阶段 1：图结构 + schema 逐节点检查 --------------------------------
  for (const [nodeId, rawNode] of Object.entries(input.graph)) {
    if (!NODE_ID_PATTERN.test(nodeId)) {
      collector.push({
        code: "invalid_node_id",
        severity: "error",
        node_id: nodeId,
        message: `节点 id ${preview(nodeId)} 不合法（须为 1-64 位字母数字_#-）`
      });
    }
    const classType = typeof rawNode?.class_type === "string" ? rawNode.class_type : "";
    const rawInputs = rawNode?.inputs;
    if (classType === "" || !isRecord(rawInputs)) {
      collector.push({
        code: "invalid_node",
        severity: "error",
        node_id: nodeId,
        message: `节点 ${preview(nodeId)} 结构不合法（class_type 须为非空字符串、inputs 须为对象）`
      });
      sawUnconfirmableClass = true;
      continue;
    }

    let info: NormalizedNodeInfo | null = null;
    if (schemaAvailable) {
      info = schema?.[classType] ?? null;
      if (!info) {
        collector.push({
          code: "unknown_class_type",
          severity: "error",
          node_id: nodeId,
          message: `节点 "${nodeId}" 的 class_type "${clipTail(classType, 80)}" 不在 /object_info（自定义节点未安装或名称漂移）`
        });
        sawUnconfirmableClass = true;
      } else if (info.malformed) {
        collector.push({
          code: "schema_unparseable",
          severity: "warning",
          node_id: nodeId,
          message: `节点 "${nodeId}" 的 /object_info 规格无法解析，该节点 schema 相关检查跳过`
        });
        info = null;
        sawUnconfirmableClass = true;
      }
    }

    for (const [key, value] of Object.entries(rawInputs)) {
      const spec = info ? (info.required[key] ?? info.optional[key] ?? null) : null;
      if (info && !spec) {
        collector.push({
          code: "unknown_input",
          severity: "error",
          node_id: nodeId,
          input: key,
          message: `节点 "${nodeId}"(${classType}) 的输入 "${key}" 不在该节点的 /object_info 规格（required/optional 均无）`
        });
      }

      if (Array.isArray(value) && !isLinkValue(value)) {
        collector.push({
          code: "invalid_link",
          severity: "error",
          node_id: nodeId,
          input: key,
          message: `节点 "${nodeId}" 输入 "${key}" 的数组值不是合法连线；API 连线须为 [nodeId, outputIndex]`
        });
        continue;
      }

      if (isLinkValue(value)) {
        const [targetId, idx] = value;
        if (typeof idx !== "number" || !Number.isInteger(idx) || idx < 0) {
          collector.push({
            code: "invalid_output_index",
            severity: "error",
            node_id: nodeId,
            input: key,
            message: `节点 "${nodeId}" 输入 "${key}" 的连线 [${JSON.stringify(targetId)}, ${JSON.stringify(idx)}] 输出索引非法（须为非负整数）`
          });
          continue;
        }
        const target = input.graph[targetId];
        if (!target || typeof target.class_type !== "string") {
          collector.push({
            code: "unknown_node_ref",
            severity: "error",
            node_id: nodeId,
            input: key,
            message: `节点 "${nodeId}" 输入 "${key}" 连到不存在的节点 ${preview(targetId)}`
          });
          continue;
        }
        const targetInfo = schemaAvailable ? (schema?.[target.class_type] ?? null) : null;
        if (targetInfo && !targetInfo.malformed && targetInfo.outputsKnown === false) {
          collector.push({
            code: "output_index_unverified",
            severity: "warning",
            node_id: nodeId,
            input: key,
            message: `节点 "${target.class_type}" 的 object_info 未提供输出表，无法确认连线 ["${targetId}", ${idx}] 的索引上界`
          });
        } else if (targetInfo && !targetInfo.malformed && idx >= targetInfo.outputs.length) {
          collector.push({
            code: "output_index_out_of_range",
            severity: "error",
            node_id: nodeId,
            input: key,
            message: `节点 "${nodeId}" 输入 "${key}" 的连线 ["${targetId}", ${idx}] 超出目标输出上限（${target.class_type} 共 ${targetInfo.outputs.length} 路输出）`
          });
          continue;
        }
        const srcType = targetInfo && !targetInfo.malformed ? (targetInfo.outputs[idx] ?? null) : null;
        if (srcType && spec && !linkTypeOk(srcType, spec)) {
          collector.push({
            code: "type_mismatch",
            severity: "error",
            node_id: nodeId,
            input: key,
            message: `节点 "${nodeId}" 输入 "${key}" 期望 ${describeSpecType(spec)}，实际接入 "${target.class_type}"[${idx}] 的 ${srcType}`
          });
        }
        continue;
      }

      // 字面值：类型 / combo 清单 / 模型依赖
      const modelKind = classifyModelInput(classType, key);
      if (spec) {
        if (modelKind && spec.kind === "combo") {
          // 模型文件 combo：清单核对即类型核对
          const choices = spec.choices;
          if (choices.length > 0) {
            if (typeof value === "string" && choices.includes(value)) {
              models.found++;
            } else {
              models.missing++;
              collector.push({
                code: "model_missing",
                severity: "error",
                node_id: nodeId,
                input: key,
                message: `节点 "${nodeId}" 输入 "${key}" 引用的${MODEL_KIND_LABEL[modelKind] ?? modelKind}模型文件 ${preview(value)} 不在可用清单（共 ${choices.length} 项）`
              });
            }
          } else {
            models.unknown++;
            collector.push({
              code: "model_unknown",
              severity: "warning",
              node_id: nodeId,
              input: key,
              message: `无法确认节点 "${nodeId}" 输入 "${key}" 的${MODEL_KIND_LABEL[modelKind] ?? modelKind}模型文件是否存在（combo 选项清单为空）`
            });
          }
        } else if (!literalTypeOk(spec, value)) {
          collector.push({
            code: "value_type_mismatch",
            severity: "error",
            node_id: nodeId,
            input: key,
            message: `节点 "${nodeId}"(${classType}) 输入 "${key}" 的值 ${preview(value)} 类型不符（期望 ${describeSpecType(spec)}）`
          });
        } else if ((spec.kind === "int" || spec.kind === "float") && typeof value === "number") {
          const lo = spec.min;
          const hi = spec.max;
          if ((lo !== undefined && value < lo) || (hi !== undefined && value > hi)) {
            collector.push({
              code: "value_out_of_range",
              severity: "error",
              node_id: nodeId,
              input: key,
              message: `节点 "${nodeId}" 输入 "${key}" 的值 ${value} 超出 schema 范围 [${lo ?? "-∞"}, ${hi ?? "+∞"}]`
            });
          } else if (spec.step !== undefined && spec.step > 0) {
            const origin = lo ?? 0;
            if (Math.abs((value - origin) / spec.step - Math.round((value - origin) / spec.step)) >= 1e-9) {
              collector.push({
                code: "value_step_mismatch",
                severity: "error",
                node_id: nodeId,
                input: key,
                message: `节点 "${nodeId}" 输入 "${key}" 的值 ${value} 未对齐 schema step=${spec.step}（相对 ${origin}）`
              });
            }
          }
        } else if (spec.kind === "combo" && spec.choices.length > 0 && !spec.choices.includes(value as string)) {
          collector.push({
            code: "combo_value_invalid",
            severity: "error",
            node_id: nodeId,
            input: key,
            message: `节点 "${nodeId}"(${classType}) 输入 "${key}" 的值 ${preview(value)} 不在 combo 清单（${summarizeChoices(spec.choices)}）`
          });
        } else if (spec.kind === "combo" && spec.choices.length === 0) {
          collector.push({
            code: "combo_unverified",
            severity: "warning",
            node_id: nodeId,
            input: key,
            message: `节点 "${nodeId}"(${classType}) 输入 "${key}" 的 combo 未暴露可选值，无法确认 ${preview(value)}`
          });
        } else if (modelKind) {
          // 模型输入但规格不是 combo：无法确认
          models.unknown++;
          collector.push({
            code: "model_unknown",
            severity: "warning",
            node_id: nodeId,
            input: key,
            message: `无法确认节点 "${nodeId}" 输入 "${key}" 的${MODEL_KIND_LABEL[modelKind] ?? modelKind}模型文件是否存在（规格 ${describeSpecType(spec)} 无选项清单）`
          });
        } else if (spec.kind === "unknown") {
          collector.push({
            code: "input_spec_unverified",
            severity: "warning",
            node_id: nodeId,
            input: key,
            message: `节点 "${nodeId}"(${classType}) 输入 "${key}" 的 object_info 规格无法解析，未验证字面值类型`
          });
        }
      } else if (modelKind) {
        // schema 不可用/未知节点：计入 unknown（相应 schema_unavailable/unknown_class_type 已另行提示）
        models.unknown++;
      }
    }

    // 缺 required 检查（schema 可用且已解析时）
    if (info) {
      for (const key of Object.keys(info.required)) {
        if (key in rawInputs) continue;
        collector.push({
          code: "missing_required",
          severity: "error",
          node_id: nodeId,
          input: key,
          message: `节点 "${nodeId}"(${classType}) 缺少 required 输入 "${key}"，提交将被 ComfyUI 拒绝`
        });
      }
      if (info.outputNode) sawOutputNode = true;
    }
  }

  // 输出节点：仅在全部 class_type 均可确认时判定（存在未知节点时不能断言“没有输出节点”）
  if (schemaAvailable && !sawUnconfirmableClass && !sawOutputNode) {
    collector.push({
      code: "no_output_node",
      severity: "error",
      message: "图中没有任何输出节点（output_node=true，如 SaveImage），执行不会产生可交付结果"
    });
  }

  // ---- 阶段 2：manifest 白名单交叉检查 ------------------------------------
  for (const p of input.manifest.params) {
    const node = input.graph[p.node];
    if (!node) {
      collector.push({
        code: "manifest_target_missing",
        severity: "error",
        param: p.name,
        message: `manifest 参数 "${p.name}" 指向不存在的节点 ${preview(p.node)}`
      });
      continue;
    }
    const classType = typeof node.class_type === "string" ? node.class_type : "";
    const info = schemaAvailable ? (schema?.[classType] ?? null) : null;
    const inGraph = isRecord(node.inputs) && p.input in node.inputs;
    const spec =
      info && !info.malformed ? (info.required[p.input] ?? info.optional[p.input] ?? null) : null;

    if (!inGraph && !spec) {
      if (info && !info.malformed) {
        collector.push({
          code: "manifest_input_unknown",
          severity: "error",
          param: p.name,
          node_id: p.node,
          input: p.input,
          message: `manifest 参数 "${p.name}" 指向 "${classType}" 的未知输入 "${p.input}"（图中与 /object_info 均不存在）`
        });
      } else {
        collector.push({
          code: "manifest_input_unverified",
          severity: "warning",
          param: p.name,
          node_id: p.node,
          input: p.input,
          message: `manifest 参数 "${p.name}" 指向的输入 "${p.input}" 不在图中且 schema 不可用，无法确认`
        });
      }
      continue;
    }
    if (spec) checkManifestCompat(p, spec, collector);
  }

  // ---- 阶段 3：schema 不可用总提示 ----------------------------------------
  if (!schemaAvailable) {
    collector.push({
      code: "schema_unavailable",
      severity: "warning",
      message:
        "object_info 不可用：未知 class_type/未知输入/combo 值/模型清单/连线类型/输出节点等 schema 相关检查未执行，本次结果不能视为完全通过"
    });
  }

  const hasError = collector.issues.some((i) => i.severity === "error");
  const hasWarning = collector.issues.some((i) => i.severity === "warning");
  const status: PreflightStatus = hasError ? "failed" : hasWarning ? "warning" : "passed";
  return { status, schemaAvailable, issues: collector.issues, truncated: collector.truncated, models };
}

// ---------------------------------------------------------------------------
// manifest 参数与输入规格交叉校验
// ---------------------------------------------------------------------------

function checkManifestCompat(p: ManifestParam, spec: NormalizedInputSpec, collector: IssueCollector): void {
  const where = `manifest 参数 "${p.name}"`;
  const allowed = PARAM_KIND_COMPAT[p.type];

  if (!allowed.includes(spec.kind)) {
    // number → INT 是常见宽松映射（写整数值可行）：降为 warning，其余不兼容按 error
    if (p.type === "number" && spec.kind === "int") {
      collector.push({
        code: "manifest_type_mismatch",
        severity: "warning",
        param: p.name,
        message: `${where}(number) 指向 INT 输入：须自行保证写入整数值`
      });
    } else {
      collector.push({
        code: "manifest_type_mismatch",
        severity: "error",
        param: p.name,
        message: `${where} 类型 ${p.type} 与输入规格不兼容（期望 ${allowed.join("/")}, 实际 ${describeSpecType(spec)}）`
      });
    }
    return;
  }

  // combo 清单可枚举时：enum 集合与 default 交叉校验
  if (spec.kind === "combo" && spec.choices.length > 0) {
    const choices = spec.choices;
    if (p.type === "enum" && p.enum) {
      const enumVals = p.enum;
      const bad = enumVals.filter((v) => !choices.includes(v));
      if (bad.length > 0) {
        collector.push({
          code: "manifest_enum_out_of_choices",
          severity: "error",
          param: p.name,
          message: `${where} 的 enum 含 ${bad.length} 个不在 combo 清单的值（如 ${bad.slice(0, 3).map((v) => preview(v)).join("、")}；清单 ${summarizeChoices(choices)}）`
        });
      }
    }
    if (typeof p.default === "string" && !choices.includes(p.default)) {
      collector.push({
        code: "manifest_default_invalid",
        severity: "error",
        param: p.name,
        message: `${where} 的 default ${preview(p.default)} 不在目标 combo 清单（${summarizeChoices(choices)}）`
      });
    }
  }

  // 数值 default 与输入规格 min/max 交叉校验（manifest 自身约束已在注册时校验，此处查漂移）
  if ((p.type === "number" || p.type === "integer") && typeof p.default === "number" && (spec.kind === "int" || spec.kind === "float")) {
    const lo = spec.min;
    const hi = spec.max;
    if ((lo !== undefined && p.default < lo) || (hi !== undefined && p.default > hi)) {
      collector.push({
        code: "manifest_default_out_of_range",
        severity: "error",
        param: p.name,
        message: `${where} 的 default(${p.default}) 超出输入规格范围 [${lo ?? "-∞"}, ${hi ?? "+∞"}]`
      });
    }
  }
}
