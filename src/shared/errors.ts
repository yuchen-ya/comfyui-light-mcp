/**
 * 结构化错误分类（参考 comfy-org taxonomy 的"免字符串匹配"思想，独立实现）。
 * 每个错误带稳定 code + 三段式消息要素（实际值/期望/修正建议）由调用方补充。
 */

export type ErrorCode =
  | "LEGACY_IDEMPOTENCY_CONFLICT"
  | "CONFIG_ERROR"
  | "COMFY_UNREACHABLE"
  | "COMFY_HTTP_ERROR"
  | "COMFY_NODE_VALIDATION"
  | "COMFY_WS_ERROR"
  | "TIMEOUT"
  | "NOT_FOUND"
  | "INVALID_RUNS"
  | "IDEMPOTENCY_CONFLICT"
  | "INTERNAL";

export class ComfyLightError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "ComfyLightError";
    this.code = code;
    this.details = details;
  }
}

/** 网络层无法连接（fetch TypeError / ECONNREFUSED 等）统一归类 */
export function toComfyUnreachable(err: unknown, url: string): ComfyLightError {
  const reason = err instanceof Error ? err.message : String(err);
  return new ComfyLightError(
    "COMFY_UNREACHABLE",
    `无法连接 ComfyUI (${url})。期望: ComfyUI 已启动且地址正确。请确认后重试。原因: ${reason}`,
    { reason }
  );
}
