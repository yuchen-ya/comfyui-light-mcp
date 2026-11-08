import { z, type ZodType } from "zod";
import type { WorkflowGraph } from "../client/types.js";
import type { ManifestParam, WorkflowManifest } from "./manifest.js";

/**
 * Parameter Validator/Mapper（docs/002 §4.2）：
 * - buildValidator：manifest → zod schema（启动时构建一次）
 * - apply：已验证参数 → 图深拷贝定点覆写；seed 特殊语义在此落地
 * - 原始模板永不被修改（每次 apply 都 structuredClone）
 */

/** 单参数错误（三段式：参数/实际值/期望） */
export interface ParamIssue {
  param: string;
  message: string;
}

export class ParamsValidationError extends Error {
  constructor(public readonly issues: ParamIssue[]) {
    super(`参数校验失败(${issues.length}处): ${issues.map((i) => `${i.param}: ${i.message}`).join("; ")}`);
    this.name = "ParamsValidationError";
  }
}

export const RANDOM_SEED = -1;
const SEED_MAX = 0xffff_ffff;

function zodForParam(p: ManifestParam): ZodType {
  let base: ZodType;
  switch (p.type) {
    case "string":
      base = z.string();
      break;
    case "boolean":
      base = z.boolean();
      break;
    case "integer":
      base = z.number().int();
      break;
    case "number":
      base = z.number();
      break;
    case "enum":
      base = z.enum(p.enum as [string, ...string[]]);
      break;
  }
  return base;
}

/** 构建整包参数校验器（strict：未知键拒绝） */
export function buildValidator(m: WorkflowManifest): ZodType {
  const shape: Record<string, ZodType> = {};
  for (const p of m.params) {
    let s = zodForParam(p);
    const checks = p.type === "number" || p.type === "integer";
    if (checks && p.min !== undefined && p.max !== undefined) {
      s = s.refine((v) => typeof v === "number" && v >= p.min! && v <= p.max!, {
        message: `须在 [${p.min}, ${p.max}] 区间`
      });
    } else if (checks && p.min !== undefined) {
      s = s.refine((v) => typeof v === "number" && v >= p.min!, { message: `须 ≥ ${p.min}` });
    } else if (checks && p.max !== undefined) {
      s = s.refine((v) => typeof v === "number" && v <= p.max!, { message: `须 ≤ ${p.max}` });
    }
    if (checks && p.step !== undefined) {
      const step = p.step;
      const origin = p.min ?? 0;
      s = s.refine((v) => typeof v === "number" && Math.abs((v - origin) / step - Math.round((v - origin) / step)) < 1e-9, {
        message: `须对齐步长 step=${step}${p.min !== undefined ? `（相对 min=${p.min}）` : ""}`
      });
    }
    shape[p.name] = p.required ? s : s.optional();
  }
  return z.object(shape).strict();
}

/** 校验参数，失败抛 ParamsValidationError（含逐参数三段式信息：实际值/期望/合法清单） */
export function validateParams(m: WorkflowManifest, params: Record<string, unknown>): void {
  const r = buildValidator(m).safeParse(params);
  if (!r.success) {
    const issues: ParamIssue[] = r.error.issues.map((i) => {
      if (i.code === z.ZodIssueCode.unrecognized_keys) {
        return {
          param: i.keys?.join(", ") ?? "<未知键>",
          message: `未知参数。合法参数: ${m.params.map((p) => p.name).join(", ")}（manifest 白名单，禁止修改工作流其他部分）`
        };
      }
      const param = i.path.join(".") || "<root>";
      const actual = params[param];
      const actualNote = actual === undefined ? "（缺失）" : `（实际: ${JSON.stringify(actual)}）`;
      return { param, message: `${i.message}${actualNote}` };
    });
    throw new ParamsValidationError(issues);
  }
}

export interface ApplyResult {
  /** 覆写后的独立图副本（与模板零共享） */
  graph: WorkflowGraph;
  /** 实际生效参数（含 seed 实际值，可复现） */
  resolved: Record<string, unknown>;
}

/** seed 生效值：显式 -1（或缺省 default=-1）→ 每 job 随机；其余原样 */
function effectiveSeed(p: ManifestParam, provided: number | undefined): number {
  const value = provided ?? (typeof p.default === "number" ? p.default : RANDOM_SEED);
  if (value === RANDOM_SEED) {
    return Math.floor(Math.random() * (SEED_MAX + 1));
  }
  return value;
}

/**
 * 定点覆写：只动 manifest 声明的 (node, input)。
 * 契约：调用前 params 必须已过 validateParams（registry 已保证 node/input 存在）。
 */
export function applyParams(
  graphTemplate: WorkflowGraph,
  m: WorkflowManifest,
  params: Record<string, unknown>
): ApplyResult {
  const graph = structuredClone(graphTemplate);
  const resolved: Record<string, unknown> = {};
  for (const p of m.params) {
    const provided = params[p.name];
    if (p.special === "seed") {
      const seed = effectiveSeed(p, typeof provided === "number" ? provided : undefined);
      graph[p.node]!.inputs[p.input] = seed;
      resolved[p.name] = seed;
      continue;
    }
    if (provided === undefined) continue; // 未提供 → 保留模板值（default 仅作 schema 展示）
    graph[p.node]!.inputs[p.input] = provided;
    resolved[p.name] = provided;
  }
  return { graph, resolved };
}
