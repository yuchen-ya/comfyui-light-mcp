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
    if (p.required && p.default !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${where}: required 参数不应再提供 default` });
    }
    // default 完整校验（Task 005 §二.3）：非法 manifest 拒绝注册（→ LoadReport）
    if (p.default !== undefined) {
      const d = p.default;
      const validateDefault = (ok: boolean, expected: string) => {
        if (!ok) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${where}: default 非法（实际: ${JSON.stringify(d)}，期望 ${expected}）`
          });
        }
      };
      switch (p.type) {
        case "string":
          validateDefault(typeof d === "string", "string");
          break;
        case "boolean":
          validateDefault(typeof d === "boolean", "boolean");
          break;
        case "integer":
          validateDefault(typeof d === "number" && Number.isInteger(d), "integer");
          break;
        case "number":
          validateDefault(typeof d === "number" && Number.isFinite(d), "number");
          break;
        case "enum":
          validateDefault(typeof d === "string" && (p.enum ?? []).includes(d), `enum 之一: ${(p.enum ?? []).join(", ")}`);
          break;
      }
      const numeric = p.type === "number" || p.type === "integer";
      if (numeric && typeof d === "number" && Number.isFinite(d)) {
        if (p.min !== undefined && d < p.min) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${where}: default(${d}) 低于 min(${p.min})` });
        }
        if (p.max !== undefined && d > p.max) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${where}: default(${d}) 超过 max(${p.max})` });
        }
        if (p.step !== undefined) {
          const origin = p.min ?? 0;
          if (Math.abs((d - origin) / p.step - Math.round((d - origin) / p.step)) >= 1e-9) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `${where}: default(${d}) 未对齐 step=${p.step}${p.min !== undefined ? `（相对 min=${p.min}）` : ""}`
            });
          }
        }
      }
      // seed 特殊规则：default 只允许 -1（随机哨兵）或 [0, 2^32-1] 的合法种子；
      // 显式 min 声明（如示例中的 min=-1）时以上通用范围校验已覆盖，此处兜底未声明 min 的情况
      if (p.special === "seed" && typeof d === "number" && p.min === undefined && p.max === undefined) {
        if (!(d === -1 || (Number.isInteger(d) && d >= 0 && d <= 4294967295))) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${where}: seed default 须为 -1（随机）或 0–4294967295 的整数（实际: ${JSON.stringify(d)}）`
          });
        }
      }
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
