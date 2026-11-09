import { z } from "zod";

/**
 * Manifest：显式参数白名单（docs/002 §5）。
 * Agent 只能改 manifest 声明的参数，且只经 ParameterMapper 定点覆写——不存在提交任意工作流 JSON 的通道。
 */

export const PARAM_TYPES = ["string", "number", "integer", "boolean", "enum"] as const;
export type ParamType = (typeof PARAM_TYPES)[number];

const namePattern = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

/** ComfyUI 节点 id 与 inputs 键：API JSON 里节点 id 是字符串 */
const nodeRefPattern = /^[A-Za-z0-9_#-]{1,64}$/;

const baseParam = {
  /** Agent 可见参数名 */
  name: z.string().regex(namePattern, "参数名须为字母开头、≤64 位字母数字_-"),
  /** API JSON 中目标节点 id */
  node: z.string().regex(nodeRefPattern, "node 须为节点 id 字符串"),
  /** 目标节点 inputs 键名 */
  input: z.string().min(1),
  type: z.enum(PARAM_TYPES),
  required: z.boolean().optional(),
  default: z.unknown().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  /** 数值离散化约束：值须对齐步长（相对 min，无 min 则相对 0） */
  step: z.number().positive().optional(),
  /** type=enum 时必填 */
  enum: z.array(z.string()).min(1).optional(),
  /** seed：值 -1 = 每次执行随机，实际值记入 params_resolved */
  special: z.literal("seed").optional(),
  description: z.string().max(500).optional()
};

/** default 的显示辅助（错误消息里给实际值） */
function describeValue(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean" || v === null) return String(v);
  return Array.isArray(v) ? "<array>" : typeof v;
}

export function seedBounds(p: Pick<ManifestParam, "min" | "max">): { min: number; max: number } {
  return { min: Math.max(0, Math.ceil(p.min ?? 0)), max: Math.min(0xffff_ffff, Math.floor(p.max ?? 0xffff_ffff)) };
}

export function isValidSeed(p: Pick<ManifestParam, "min" | "max">, value: unknown): value is number {
  const range = seedBounds(p);
  return value === -1 || (typeof value === "number" && Number.isInteger(value) && value >= range.min && value <= range.max);
}

/**
 * default 完整校验（P4.1 §二.3）：default 必须自身满足该参数声明的全部约束。
 * 返回问题清单（空数组 = 通过）。在 superRefine 中调用，非法 manifest 整体拒绝注册。
 */
export function validateParamDefault(p: ManifestParam): string[] {
  if (p.default === undefined) return [];
  const d = p.default;
  const where = `params[${p.name}]`;
  const issues: string[] = [];
  const push = (msg: string) => issues.push(`${where}: ${msg}`);

  // 类型正确
  switch (p.type) {
    case "string":
      if (typeof d !== "string") push(`default 类型须为 string，实际 ${describeValue(d)}`);
      break;
    case "boolean":
      if (typeof d !== "boolean") push(`default 类型须为 boolean，实际 ${describeValue(d)}`);
      break;
    case "number":
      if (typeof d !== "number" || !Number.isFinite(d)) push(`default 类型须为有限 number，实际 ${describeValue(d)}`);
      break;
    case "integer":
      if (!Number.isInteger(d)) push(`default 类型须为 integer，实际 ${describeValue(d)}`);
      break;
    case "enum":
      if (typeof d !== "string" || !p.enum || !p.enum.includes(d)) {
        push(`default 须为 enum 合法值（${(p.enum ?? []).join(" | ") || "<空>"}），实际 ${describeValue(d)}`);
      }
      break;
  }

  const isNum = typeof d === "number" && Number.isFinite(d);

  // seed 特殊规则：-1（随机哨兵）或 [min??0, max??0xffffffff] 内的整数（step 不适用）
  if (p.special === "seed" && isNum) {
    const { min: lo, max: hi } = seedBounds(p);
    if (!isValidSeed(p, d)) {
      push(`seed 的 default 只允许 -1（每次随机）或 [${lo}, ${hi}] 内的整数，实际 ${describeValue(d)}`);
    }
    return issues;
  }

  // min / max / step（number/integer；seed 已在上方单独处理）
  if (isNum && (p.type === "number" || p.type === "integer")) {
    if (p.min !== undefined && d < p.min) push(`default(${d}) 低于 min(${p.min})`);
    if (p.max !== undefined && d > p.max) push(`default(${d}) 超过 max(${p.max})`);
    if (p.step !== undefined) {
      const origin = p.min ?? 0;
      if (Math.abs((d - origin) / p.step - Math.round((d - origin) / p.step)) >= 1e-9) {
        push(`default(${d}) 未对齐 step=${p.step}${p.min !== undefined ? `（相对 min=${p.min}）` : ""}`);
      }
    }
  }
  return issues;
}

export const manifestParamSchema = z
  .object(baseParam)
  .strict()
  .superRefine((p, ctx) => {
    const where = `params[${p.name}]`;
    if (p.type === "enum" && (!p.enum || p.enum.length === 0)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${where}: type=enum 必须提供非空 enum` });
    }
    if (p.enum && p.type !== "enum") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${where}: enum 仅允许 type=enum 使用` });
    }
    if (p.min !== undefined && p.max !== undefined && p.min > p.max) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${where}: min(${p.min}) 不能大于 max(${p.max})` });
    }
    if ((p.min !== undefined || p.max !== undefined || p.step !== undefined) &&
      p.type !== "number" && p.type !== "integer") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${where}: min/max/step 仅允许 number/integer` });
    }
    if (p.special === "seed" && p.type !== "integer") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${where}: special=seed 要求 type=integer` });
    }
    if (p.special === "seed" && seedBounds(p).min > seedBounds(p).max) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${where}: seed range contains no valid nonnegative integer` });
    }
    if (p.required && p.default !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${where}: required 参数不应再提供 default` });
    }
    for (const issue of validateParamDefault(p)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: issue });
    }
  });

export const workflowManifestSchema = z
  .object({
    name: z.string().regex(namePattern, "manifest name 须为字母开头、≤64 位字母数字_-（即工具入参 workflow）"),
    description: z.string().min(1).max(300),
    /** manifest 自身版本号（跟踪与工作流文件的漂移） */
    version: z.number().int().min(1),
    /** 相对 manifest 文件的 API JSON 文件名 */
    workflowFile: z.string().min(1).refine((v) => !/[/\\]/.test(v), "workflowFile 须为同目录文件名，不含路径分隔符"),
    params: z.array(manifestParamSchema).min(1)
  })
  .strict()
  .superRefine((m, ctx) => {
    const names = new Set<string>();
    for (const p of m.params) {
      if (names.has(p.name)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `参数名重复: ${p.name}` });
      names.add(p.name);
    }
  });

export type ManifestParam = z.infer<typeof manifestParamSchema>;
export type WorkflowManifest = z.infer<typeof workflowManifestSchema>;

/** 结构化 manifest 解析错误（含文件定位与 zod 明细） */
export class ManifestError extends Error {
  constructor(
    public readonly file: string,
    message: string,
    public readonly issues?: string[]
  ) {
    super(`manifest 错误 [${file}]: ${message}`);
    this.name = "ManifestError";
  }
}

export function parseManifest(file: string, text: string): WorkflowManifest {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new ManifestError(file, `不是合法 JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const parsed = workflowManifestSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`);
    throw new ManifestError(file, `schema 校验失败: ${issues.join("; ")}`, issues);
  }
  return parsed.data;
}
