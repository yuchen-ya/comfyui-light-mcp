import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import { ComfyWs, wsUrlFromHttp } from "../../src/core/client/comfy-ws.js";
import type { ComfyRawEvent } from "../../src/core/client/event-bus.js";

/** 轮询等待谓词成立（离线 WS 集成测试的通用小工具） */
async function waitFor(pred: () => boolean, timeoutMs = 5000, stepMs = 25): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor 超时(${timeoutMs}ms)`);
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

describe("ComfyWs（对本地 ws 服务器的离线集成测试）", () => {
  let server: WebSocketServer;
  let port: number;
  const sockets: WsSocket[] = [];
  const receivedRaw: ComfyRawEvent[] = [];

  beforeEach(async () => {
    receivedRaw.length = 0;
    sockets.length = 0;
    server = new WebSocketServer({ port: 0 });
    port = (server.address() as { port: number }).port;
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    server.on("connection", (sock) => {
      sockets.push(sock);
    });
  });

  afterEach(async () => {
    for (const s of sockets) s.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function makeClient(over?: Partial<ConstructorParameters<typeof ComfyWs>[0]>): ComfyWs {
    return new ComfyWs({
      url: `ws://127.0.0.1:${port}/ws?clientId=test-client`,
      reconnect: { initialMs: 30, maxMs: 150, factor: 2 },
      firstOpenTimeoutMs: 3000,
      ...over
    });
  }

  it("wsUrlFromHttp 转换协议并携带 clientId", () => {
    expect(wsUrlFromHttp("http://127.0.0.1:8188/", "abc")).toBe("ws://127.0.0.1:8188/ws?clientId=abc");
    expect(wsUrlFromHttp("https://h.example.com", "a b")).toBe("wss://h.example.com/ws?clientId=a%20b");
  });

  it("文本帧解析投递；二进制帧计数后丢弃（不进解析）", async () => {
    const ws = makeClient();
    ws.onRawEvent((raw) => receivedRaw.push(raw));
    await ws.start();
    expect(sockets.length).toBe(1);
    const sock = sockets[0]!;

    sock.send(JSON.stringify({ type: "execution_start", prompt_id: "p1", data: {} }));
    sock.send(Buffer.from([0x89, 0x02, 0x01, 0x02])); // 二进制预览帧
    sock.send(JSON.stringify({ type: "progress", prompt_id: "p1", data: { value: 1, max: 4 } }));

    await waitFor(() => receivedRaw.length >= 2);
    const stats = ws.getStats();
    expect(receivedRaw.map((r) => r.type)).toEqual(["execution_start", "progress"]);
    expect(stats.binaryFramesSkipped).toBe(1);
    expect(stats.parseErrors).toBe(0);
    ws.stop();
  });

  it("非法 JSON 文本帧计为 parseErrors，不中断连接", async () => {
    const ws = makeClient();
    await ws.start();
    const sock = sockets[0]!;
    sock.send("this is not json");
    sock.send(JSON.stringify({ type: "status", data: {} }));
    await waitFor(() => ws.getStats().parseErrors === 1);
    expect(ws.getStats().state).toBe("open");
    ws.stop();
  });

  it("服务端断开后按退避自动重连并恢复 open（二进制计数/事件继续）", async () => {
    const ws = makeClient();
    ws.onRawEvent((raw) => receivedRaw.push(raw));
    await ws.start();
    expect(sockets.length).toBe(1);

    sockets[0]!.terminate(); // 模拟异常断开（terminate 不校验 close code）
    await waitFor(() => sockets.length === 2, 4000);
    await waitFor(() => ws.getStats().state === "open", 2000);
    expect(ws.getStats().reconnects).toBe(1);

    const sock2 = sockets[1]!;
    sock2.send(JSON.stringify({ type: "execution_success", prompt_id: "p1" }));
    await waitFor(() => receivedRaw.some((r) => r.type === "execution_success"));
    ws.stop();
  });

  it("stop() 后不再重连", async () => {
    const ws = makeClient();
    await ws.start();
    const countAtStop = sockets.length;
    ws.stop();
    sockets[0]!.terminate();
    await new Promise((r) => setTimeout(r, 400));
    expect(sockets.length).toBe(countAtStop); // 无新连接
    expect(ws.getStats().state).toBe("stopped");
  });

  it("首连超时抛错（ComfyUI 未启动场景）", async () => {
    // 绑定一个空闲端口后立刻关闭 → 连接必然被拒
    const ghost = new WebSocketServer({ port: 0 });
    const ghostPort = (ghost.address() as { port: number }).port;
    await new Promise<void>((resolve) => ghost.close(() => resolve()));

    const ws = new ComfyWs({
      url: `ws://127.0.0.1:${ghostPort}/ws?clientId=x`,
      reconnect: { initialMs: 20, maxMs: 50, factor: 2 },
      firstOpenTimeoutMs: 200
    });
    await expect(ws.start()).rejects.toThrow(/超时/);
    ws.stop();
  });
});
