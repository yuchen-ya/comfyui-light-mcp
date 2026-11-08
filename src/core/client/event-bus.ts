/**
 * 事件总线：WS 原始事件按 prompt_id 多路分解。
 * 修复 metabrain 的全局钩子覆写竞态（其 wait.ts:49-70 并发等待互相覆盖）。
 * 事件名→语义映射参考 metabrain wait.ts 分支表改编，以真实环境验证为准。
 */

/** WS 文本帧解析后的原始事件（宽松） */
export interface ComfyRawEvent {
  type: string;
  data?: Record<string, unknown>;
  prompt_id?: string;
  [k: string]: unknown;
}

/** 面向 job 层的规范化事件 */
export type JobEvent =
  | { type: "started" }
  | { type: "executing"; nodeId: string | null }
  | { type: "progress"; value: number; max: number }
  | { type: "executed"; nodeId: string; outputs: Record<string, unknown> }
  | { type: "success" }
  | { type: "error"; message: string; details: unknown }
  | { type: "interrupted" };

export type Unsubscribe = () => void;

/** 原始事件 → JobEvent；返回 null 表示与单任务跟踪无关（status/预览等） */
export function translateJobEvent(raw: ComfyRawEvent): JobEvent | null {
  const data = (raw.data ?? {}) as Record<string, unknown>;
  switch (raw.type) {
    case "execution_start":
      return { type: "started" };
    case "executing": {
      // 字段名兼容 node / node_id（以真实验证为准）
      const node = data["node"] ?? data["node_id"] ?? raw["node"] ?? raw["node_id"];
      return { type: "executing", nodeId: typeof node === "string" ? node : null };
    }
    case "progress": {
      const value = typeof data["value"] === "number" ? data["value"] : 0;
      const max = typeof data["max"] === "number" ? data["max"] : 0;
      return { type: "progress", value, max };
    }
    case "executed": {
      const nodeId = typeof data["node"] === "string" ? data["node"] : "";
      const outputs = (data["output"] ?? {}) as Record<string, unknown>;
      return { type: "executed", nodeId, outputs };
    }
    case "execution_success":
      return { type: "success" };
    case "execution_error": {
      const message =
        typeof data["exception_message"] === "string"
          ? data["exception_message"]
          : "execution_error (无 exception_message)";
      return { type: "error", message, details: data };
    }
    case "execution_interrupted":
      return { type: "interrupted" };
    default:
      return null; // status / execution_cached / 未知类型
  }
}

type JobListener = (e: JobEvent, raw: ComfyRawEvent) => void;

export class ComfyEventBus {
  private readonly byPrompt = new Map<string, Set<JobListener>>();
  private readonly anyListeners = new Set<(raw: ComfyRawEvent) => void>();
  private readonly disconnectListeners = new Set<() => void>();
  private readonly reconnectListeners = new Set<() => void>();

  /** 供 comfy-ws 投递原始文本事件 */
  publish(raw: ComfyRawEvent): void {
    const listeners = this.anyListeners;
    for (const l of listeners) l(raw);
    const promptId = raw["prompt_id"];
    if (typeof promptId !== "string" || promptId === "") return;
    const set = this.byPrompt.get(promptId);
    if (!set) return;
    const job = translateJobEvent(raw);
    if (!job) return;
    for (const l of set) l(job, raw);
  }

  subscribePrompt(promptId: string, listener: JobListener): Unsubscribe {
    let set = this.byPrompt.get(promptId);
    if (!set) {
      set = new Set();
      this.byPrompt.set(promptId, set);
    }
    set.add(listener);
    return () => {
      const s = this.byPrompt.get(promptId);
      if (!s) return;
      s.delete(listener);
      if (s.size === 0) this.byPrompt.delete(promptId);
    };
  }

  /** 订阅全部原始事件（无 prompt_id 的广播事件如 status） */
  subscribeAny(listener: (raw: ComfyRawEvent) => void): Unsubscribe {
    this.anyListeners.add(listener);
    return () => this.anyListeners.delete(listener);
  }

  /** WS 断开：job 层应触发 /history 兜底对账 */
  onDisconnect(cb: () => void): Unsubscribe {
    this.disconnectListeners.add(cb);
    return () => this.disconnectListeners.delete(cb);
  }

  /** WS 重连成功：对 in-flight job 做 history 快照对账 */
  onReconnect(cb: () => void): Unsubscribe {
    this.reconnectListeners.add(cb);
    return () => this.reconnectListeners.delete(cb);
  }

  emitDisconnect(): void {
    for (const cb of [...this.disconnectListeners]) cb();
  }

  emitReconnect(): void {
    for (const cb of [...this.reconnectListeners]) cb();
  }
}
