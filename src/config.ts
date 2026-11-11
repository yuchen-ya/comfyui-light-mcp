import { z } from "zod";

/**
 * 配置管理：环境变量 → zod 校验 → 深冻结配置对象。
 * 默认面向 Windows 本地单实例部署：只连已启动的 ComfyUI，不做启动管理。
 */

const boolish = z
  .enum(["true", "false", "1", "0"])
  .default("true")
  .transform((v) => v === "true" || v === "1");

const positiveInt = (fallback: number, max = 1000) =>
  z
    .string()
    .default(String(fallback))
    .transform((v, ctx) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > max) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `须为 1–${max} 的整数，实际: "${v}"` });
        return z.NEVER;
      }
      return n;
    });

const rawSchema = z.object({
  COMFYUI_URL: z
    .string()
    .default("http://127.0.0.1:8188")
    .transform((value, ctx) => {
      try {
        const url = new URL(value);
        if (!/^https?:\/\//i.test(value) || !["http:", "https:"].includes(url.protocol) ||
            !url.hostname || url.username || url.password || value.includes("?") || value.includes("#") ||
            /[\s\\]/.test(value)) throw new Error("invalid endpoint");
        return url.href.replace(/\/+$/, "");
      } catch {
        // Never echo the input: it may contain accidentally pasted credentials.
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "COMFYUI_URL 须为有效 HTTP(S) 地址，可含路径前缀，不允许凭据、查询参数或 fragment" });
        return z.NEVER;
      }
    }),
  WORKFLOWS_DIR: z.string().default("./workflows"),
  DATA_DIR: z.string().default("./data"),
  OUTPUT_DIR: z.string().default("./output"),
  AUTO_SAVE_OUTPUTS: boolish,
  MAX_IN_FLIGHT: positiveInt(1, 64),
  MAX_QUEUED_JOBS: positiveInt(1, 64),
  JOB_TIMEOUT_MS: z
    .string()
    .default("600000")
    .transform((v, ctx) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 10_000 || n > 86_400_000) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `须为 10000–86400000 的整数毫秒，实际: "${v}"` });
        return z.NEVER;
      }
      return n;
    })
});

export interface AppConfig {
  readonly comfyUiUrl: string;
  readonly workflowsDir: string;
  readonly dataDir: string;
  readonly outputDir: string;
  readonly autoSaveOutputs: boolean;
  /** 在途窗口（submitting/submission_unknown/queued/executing 总和上限） */
  readonly maxInFlight: number;
  /** ComfyUI 队列占用窗口（仅 queued），须 ≤ maxInFlight */
  readonly maxQueuedJobs: number;
  /** 单 job 墙钟超时（触发即尽力 interrupt/queue delete） */
  readonly jobTimeoutMs: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(`配置错误: ${message}`);
    this.name = "ConfigError";
  }
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const picked: Record<string, string | undefined> = {};
  for (const key of [
    "COMFYUI_URL",
    "WORKFLOWS_DIR",
    "DATA_DIR",
    "OUTPUT_DIR",
    "AUTO_SAVE_OUTPUTS",
    "MAX_IN_FLIGHT",
    "MAX_QUEUED_JOBS",
    "JOB_TIMEOUT_MS"
  ]) {
    const v = env[key];
    if (v !== undefined && v !== "") picked[key] = v;
  }

  const parsed = rawSchema.safeParse(picked);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new ConfigError(detail);
  }
  const r = parsed.data;
  if (r.MAX_QUEUED_JOBS > r.MAX_IN_FLIGHT) {
    throw new ConfigError(`MAX_QUEUED_JOBS(${r.MAX_QUEUED_JOBS}) 不能大于 MAX_IN_FLIGHT(${r.MAX_IN_FLIGHT})`);
  }
  return deepFreeze({
    comfyUiUrl: r.COMFYUI_URL.replace(/\/+$/, ""),
    workflowsDir: r.WORKFLOWS_DIR,
    dataDir: r.DATA_DIR,
    outputDir: r.OUTPUT_DIR,
    autoSaveOutputs: r.AUTO_SAVE_OUTPUTS,
    maxInFlight: r.MAX_IN_FLIGHT,
    maxQueuedJobs: r.MAX_QUEUED_JOBS,
    jobTimeoutMs: r.JOB_TIMEOUT_MS
  });
}

function deepFreeze<T>(obj: T): T {
  for (const key of Object.getOwnPropertyNames(obj)) {
    const v = (obj as Record<string, unknown>)[key];
    if (v !== null && typeof v === "object") deepFreeze(v);
  }
  return Object.freeze(obj);
}
