import { ComfyEventBus } from "../../src/core/client/event-bus.js";
import type { ComfyClient } from "../../src/core/client/index.js";
import type { HistoryEntry, SubmitResult, WorkflowGraph } from "../../src/core/client/types.js";

/**
 * 离线测试用 ComfyClient 替身：真实事件总线 + 可编程 http 行为。
 * submitCalls 记录调用序（供"提交前持久化"顺序断言）；
 * *Impl 可选覆写各端点行为（模拟网络失败/HTTP 拒绝/取消失败等）。
 */
export interface FakeHttpState {
  submitCalls: number;
  submitImpl: (graph: WorkflowGraph, opts?: { clientId?: string; promptId?: string }) => Promise<SubmitResult>;
  submitGraphs: WorkflowGraph[];
  history: Map<string, HistoryEntry>;
  queuePromptIds: { running: string[]; pending: string[] };
  interruptCalls: string[];
  interruptImpl?: (promptId?: string) => Promise<void>;
  deleteQueueCalls: string[][];
  deleteQueueImpl?: (promptIds: string[]) => Promise<void>;
  downloads: Map<string, Buffer>;
  downloadCalls: number;
  /** 向真实事件总线发布该 prompt 的成功事件（驱动 tracker 定终态） */
  publishSuccess: (promptId: string) => void;
}

export function makeFakeClient(): { client: ComfyClient; state: FakeHttpState; bus: ComfyEventBus } {
  const bus = new ComfyEventBus();
  const state: FakeHttpState = {
    submitCalls: 0,
    submitImpl: async (graph, opts) => ({ ok: true, promptId: opts?.promptId ?? "auto-id", number: 1, nodeErrors: {} }),
    submitGraphs: [],
    history: new Map(),
    queuePromptIds: { running: [], pending: [] },
    interruptCalls: [],
    deleteQueueCalls: [],
    downloads: new Map(),
    downloadCalls: 0,
    publishSuccess: (promptId: string) => {
      bus.publish({ type: "execution_success", data: { prompt_id: promptId } });
    }
  };
  const client: ComfyClient = {
    clientId: "fake-client-id",
    bus,
    http: {
      async submitPrompt(graph: WorkflowGraph, opts?: { clientId?: string; promptId?: string }) {
        state.submitCalls++;
        state.submitGraphs.push(graph);
        return state.submitImpl(graph, opts);
      },
      async getHistory(promptId: string) {
        return state.history.get(promptId) ?? null;
      },
      async getQueue() {
        return {
          queue_running: state.queuePromptIds.running.map((id, i) => [i, id, {}]),
          queue_pending: state.queuePromptIds.pending.map((id, i) => [i + 100, id, {}])
        } as never;
      },
      async interrupt(promptId?: string) {
        state.interruptCalls.push(promptId ?? "<none>");
        if (state.interruptImpl) return state.interruptImpl(promptId);
      },
      async deleteQueue(promptIds: string[]) {
        state.deleteQueueCalls.push(promptIds);
        if (state.deleteQueueImpl) return state.deleteQueueImpl(promptIds);
        // 模拟真实语义：从 pending 队列移除
        for (const id of promptIds) {
          state.queuePromptIds.pending = state.queuePromptIds.pending.filter((p) => p !== id);
        }
      },
      async downloadOutput(ref: { filename: string }) {
        state.downloadCalls++;
        const buf = state.downloads.get(ref.filename) ?? Buffer.from("fake-image-bytes");
        return new Response(new Uint8Array(buf), { status: 200 });
      }
    } as never,
    ws: { getStats: () => ({ state: "open" }) } as never,
    start: async () => {},
    stop: () => {}
  };
  return { client, state, bus };
}

export function historyEntry(outputs: Record<string, unknown>, statusStr = "success"): HistoryEntry {
  return {
    prompt: [],
    outputs: outputs as HistoryEntry["outputs"],
    status: { status_str: statusStr === "interrupted" ? "error" : statusStr, completed: statusStr === "success",
      messages: statusStr === "interrupted" ? [["execution_interrupted", { prompt_id: "fixture-prompt", node_id: "7" }]] : [] }
  };
}
