import { randomUUID } from "node:crypto";
import { ComfyEventBus } from "./event-bus.js";
import { ComfyHttp } from "./comfy-http.js";
import { ComfyWs, wsUrlFromHttp } from "./comfy-ws.js";

/**
 * 客户端装配门面：HTTP + WS + 事件总线。
 * WS 状态变化 → 总线 disconnect/reconnect 通知（job 层据此触发 /history 对账）。
 */

export interface ComfyClient {
  http: ComfyHttp;
  bus: ComfyEventBus;
  ws: ComfyWs;
  readonly clientId: string;
  start(): Promise<void>;
  stop(): void;
}

export function createComfyClient(opts: {
  comfyUiUrl: string;
  clientId?: string;
  firstOpenTimeoutMs?: number;
}): ComfyClient {
  const clientId = opts.clientId ?? randomUUID();
  const http = new ComfyHttp({ baseUrl: opts.comfyUiUrl });
  const ws = new ComfyWs({
    url: wsUrlFromHttp(opts.comfyUiUrl, clientId),
    firstOpenTimeoutMs: opts.firstOpenTimeoutMs
  });
  const bus = new ComfyEventBus();

  ws.onRawEvent((raw) => bus.publish(raw));

  let hadOpen = false;
  ws.onStateChange((s) => {
    if (s === "open") {
      if (hadOpen) bus.emitReconnect();
      hadOpen = true;
    } else if (s === "reconnecting") {
      bus.emitDisconnect();
    }
  });

  return {
    http,
    bus,
    ws,
    clientId,
    async start() {
      await ws.start();
    },
    stop() {
      ws.stop();
    }
  };
}
