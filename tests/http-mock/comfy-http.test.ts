import { describe, expect, it, vi } from "vitest";
import { ComfyHttp } from "../../src/core/client/comfy-http.js";
import type { WorkflowGraph } from "../../src/core/client/types.js";
import { ComfyLightError } from "../../src/shared/errors.js";

const BASE = "http://127.0.0.1:8188";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** 模拟真实 fetch 的超时行为：监听 signal abort 并以 TimeoutError 拒绝 */
function neverResolvingFetch(): typeof fetch {
  return ((_url: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const e = new Error("The operation was aborted due to timeout");
        e.name = "TimeoutError";
        reject(e);
      });
    })) as unknown as typeof fetch;
}

describe("ComfyHttp", () => {
  it("systemStats 命中 /system_stats 并解析版本", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, { system: { comfyui_version: "0.3.75", os: "nt" }, devices: [] })
    );
    const http = new ComfyHttp({ baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch });
    const stats = await http.systemStats();
    expect(stats.system?.["comfyui_version"]).toBe("0.3.75");
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(`${BASE}/system_stats`);
  });

  it("healthCheck 返回版本；连接拒绝归类 COMFY_UNREACHABLE", async () => {
    const ok = new ComfyHttp({
      baseUrl: BASE,
      fetchImpl: vi.fn().mockResolvedValue(jsonResponse(200, { system: { comfyui_version: "1.0" } })) as unknown as typeof fetch
    });
    expect(await ok.healthCheck()).toEqual({ ok: true, version: "1.0" });

    const down = new ComfyHttp({
      baseUrl: BASE,
      fetchImpl: vi.fn().mockRejectedValue(new TypeError("fetch failed")) as unknown as typeof fetch
    });
    const err = await down.healthCheck().catch((e) => e);
    expect(err).toBeInstanceOf(ComfyLightError);
    expect(err.code).toBe("COMFY_UNREACHABLE");
  });

  it("submitPrompt 构造正确的 body：client_id 与可选 prompt_id", async () => {
    // 每次调用必须返回新 Response（body 只能读一次）
    const fetchImpl = vi.fn().mockImplementation(async () =>
      jsonResponse(200, { prompt_id: "srv-pid", number: 5, node_errors: {} })
    );
    const http = new ComfyHttp({ baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch });
    const graph: WorkflowGraph = { "1": { class_type: "KSampler", inputs: {} } };

    const r1 = await http.submitPrompt(graph, { clientId: "c1" });
    expect(r1).toEqual({ ok: true, promptId: "srv-pid", number: 5, nodeErrors: {} });
    const body1 = JSON.parse((fetchImpl.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body1).toEqual({ prompt: graph, client_id: "c1" }); // 不带 prompt_id 键

    const r2 = await http.submitPrompt(graph, { clientId: "c1", promptId: "my-pid" });
    expect(r2.ok && r2.promptId).toBe("srv-pid");
    const body2 = JSON.parse((fetchImpl.mock.calls[1]?.[1] as RequestInit).body as string);
    expect(body2).toEqual({ prompt: graph, client_id: "c1", prompt_id: "my-pid" });
  });

  it("submitPrompt 400 时返回 ok:false 并携带 node_errors（不抛异常）", async () => {
    const nodeErrors = { "3": { errors: [{ type: "value_not_in_list", detail: "bad sampler" }] } };
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(400, { error: { type: "prompt_outputs_failed_validation" }, node_errors: nodeErrors })
    );
    const http = new ComfyHttp({ baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch });
    const r = await http.submitPrompt({ "1": { class_type: "X", inputs: {} } });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.httpStatus).toBe(400);
      expect(r.nodeErrors).toEqual(nodeErrors);
      expect(r.errorBody).toEqual({ type: "prompt_outputs_failed_validation" });
    }
  });

  it("getHistory：命中返回条目，未命中返回 null", async () => {
    const entry = { prompt: [], outputs: {}, status: {} };
    const hit = new ComfyHttp({
      baseUrl: BASE,
      fetchImpl: vi.fn().mockResolvedValue(jsonResponse(200, { "pid-1": entry })) as unknown as typeof fetch
    });
    expect(await hit.getHistory("pid-1")).toEqual(entry);

    const miss = new ComfyHttp({
      baseUrl: BASE,
      fetchImpl: vi.fn().mockResolvedValue(jsonResponse(200, {})) as unknown as typeof fetch
    });
    expect(await miss.getHistory("pid-1")).toBeNull();
  });

  it("getQueue 解析队列结构", async () => {
    const q = { queue_running: [[0, 0, "run-1", {}, {}]], queue_pending: [[1, 1, "pend-1", {}, {}]] };
    const http = new ComfyHttp({
      baseUrl: BASE,
      fetchImpl: vi.fn().mockResolvedValue(jsonResponse(200, q)) as unknown as typeof fetch
    });
    const info = await http.getQueue();
    expect(info.queue_running[0]?.[2]).toBe("run-1");
    expect(info.queue_pending[0]?.[2]).toBe("pend-1");
  });

  it("interrupt 带/不带 prompt_id 的两种 body", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, {}))
      .mockResolvedValueOnce(jsonResponse(200, {}));
    const http = new ComfyHttp({ baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch });
    await http.interrupt("p1");
    await http.interrupt();
    expect(JSON.parse((fetchImpl.mock.calls[0]?.[1] as RequestInit).body as string)).toEqual({ prompt_id: "p1" });
    expect(JSON.parse((fetchImpl.mock.calls[1]?.[1] as RequestInit).body as string)).toEqual({});
  });

  it("downloadOutput 构造 /view 查询串", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    const http = new ComfyHttp({ baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch });
    const res = await http.downloadOutput({ filename: "a b.png", subfolder: "sub dir", type: "output" });
    expect(res.status).toBe(200);
    const url = String(fetchImpl.mock.calls[0]?.[0]);
    expect(url).toContain("/view?filename=a+b.png&subfolder=sub+dir&type=output");
  });

  it("超时抛 ComfyLightError(TIMEOUT)", async () => {
    const http = new ComfyHttp({ baseUrl: BASE, fetchImpl: neverResolvingFetch(), timeoutMs: 50 });
    const err = await http.systemStats().catch((e) => e);
    expect(err).toBeInstanceOf(ComfyLightError);
    expect(err.code).toBe("TIMEOUT");
  });

  it("5xx 抛 COMFY_HTTP_ERROR 且消息含截断后的响应尾部", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response("x".repeat(5000) + "TAIL-MARKER", { status: 500 })
    );
    const http = new ComfyHttp({ baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch });
    const err = await http.getQueue().catch((e) => e);
    expect(err).toBeInstanceOf(ComfyLightError);
    expect(err.code).toBe("COMFY_HTTP_ERROR");
    expect(err.message).toContain("HTTP 500");
    expect(err.message).toContain("TAIL-MARKER");
    expect(err.message.length).toBeLessThan(1200);
  });
});
