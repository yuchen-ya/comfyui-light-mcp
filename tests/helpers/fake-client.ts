import { ComfyEventBus } from "../../src/core/client/event-bus.js";
import type { ComfyClient } from "../../src/core/client/index.js";
import type { HistoryEntry, SubmitResult, WorkflowGraph } from "../../src/core/client/types.js";

/**
 * 离线测试用 ComfyClient 替身：真实事件总线 + 可编程 http 行为。
 * submitCalls 记录调用序（供"提交前持久化"顺序断言）。
 */
export interface FakeHttpState {
  submitCalls: number;
  submitImpl: (graph: WorkflowGraph, opts?: { clientId?: string; promptId?: string }) => Promise<SubmitResult>;
  history: Map<string, HistoryEntry>;
  queuePromptIds: { running: string[]; pending: string[] };
  interruptCalls: string[];
  downloads: Map<string, Buffer>;
  /** 向真实事件总线发布该 prompt 的成功事件（驱动 tracker 定终态） */
  publishSuccess: (promptId: string) => void;
}

export function makeFakeClient(): { client: ComfyClient; state: FakeHttpState; bus: ComfyEventBus } {
  const bus = new ComfyEventBus();
  const state: FakeHttpState = {
    submitCalls: 0,
    submitImpl: async (graph, opts) => ({ ok: true, promptId: opts?.promptId ?? "auto-id", number: 1, nodeErrors: {} }),
    history: new Map(),
    queuePromptIds: { running: [], pending: [] },
    interruptCalls: [],
    downloads: new Map(),
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
      },
      async downloadOutput(ref: { filename: string }) {
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
    status: { status_str: statusStr, completed: statusStr === "success", messages: [] }
  };
}
