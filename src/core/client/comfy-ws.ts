import { WebSocket } from "ws";
import type { ComfyRawEvent } from "./event-bus.js";

/**
 * ComfyUI WebSocket 客户端。
 * - 单连接、固定 clientId（提交与事件须同 id 关联）
 * - 指数退避 + 全抖动重连（修复 metabrain 固定 3s 无退避问题）
 * - 二进制帧（执行预览图）显式计数后丢弃，不进 JSON.parse（修复 metabrain 解析报错问题）
 */

export type WsState = "idle" | "connecting" | "open" | "reconnecting" | "stopped";

export interface ComfyWsOptions {
  /** 完整 ws url，含 /ws?clientId=... */
  url: string;
  reconnect?: { initialMs?: number; maxMs?: number; factor?: number };
  /** 首次连接等待上限；超时抛错（供启动期健康判断），此后自动无限重连 */
  firstOpenTimeoutMs?: number;
}

export interface WsStats {
  state: WsState;
  binaryFramesSkipped: number;
  parseErrors: number;
  reconnects: number;
  lastEventType: string | null;
}

export function wsUrlFromHttp(httpUrl: string, clientId: string): string {
  const withWs = httpUrl.replace(/^http/, "ws").replace(/\/+$/, "");
  return `${withWs}/ws?clientId=${encodeURIComponent(clientId)}`;
}

export class ComfyWs {
  private readonly opts: Required<Pick<NonNullable<ComfyWsOptions["reconnect"]>, "initialMs" | "maxMs" | "factor">>;
  private readonly firstOpenTimeoutMs: number;
  private sock: WebSocket | null = null;
  private state: WsState = "idle";
  private stopped = false;
  private attempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;

  private readonly rawListeners = new Set<(raw: ComfyRawEvent) => void>();
  private readonly stateListeners = new Set<(s: WsState) => void>();
  private stats: WsStats = {
    state: "idle",
    binaryFramesSkipped: 0,
    parseErrors: 0,
    reconnects: 0,
    lastEventType: null
  };

  constructor(private readonly options: ComfyWsOptions) {
    const r = options.reconnect ?? {};
    this.opts = {
      initialMs: r.initialMs ?? 500,
      maxMs: r.maxMs ?? 15_000,
      factor: r.factor ?? 2
    };
    this.firstOpenTimeoutMs = options.firstOpenTimeoutMs ?? 10_000;
  }

  onRawEvent(cb: (raw: ComfyRawEvent) => void): () => void {
    this.rawListeners.add(cb);
    return () => this.rawListeners.delete(cb);
  }

  onStateChange(cb: (s: WsState) => void): () => void {
    this.stateListeners.add(cb);
    return () => this.stateListeners.delete(cb);
  }

  getStats(): WsStats {
    return { ...this.stats, state: this.state };
  }

  /** 建立首连（超时抛 Error）；此后断线自动重连直到 stop() */
  async start(): Promise<void> {
    if (this.state !== "idle") throw new Error("ComfyWs.start() 只能调用一次");
    const firstOpen = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`WS 首连超时(${this.firstOpenTimeoutMs}ms): ${this.options.url}`)), this.firstOpenTimeoutMs);
      const off = this.onStateChange((s) => {
        if (s === "open") {
          clearTimeout(timer);
          resolve();
        }
      });
      void off; // 首连后移除由 GC 处理；此处仅需一次性信号
    });
    this.connect();
    await firstOpen;
  }

  stop(): void {
    this.stopped = true;
    this.setState("stopped");
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.sock?.close(1000, "client-stop");
    this.sock = null;
  }

  private connect(): void {
    if (this.stopped) return;
    this.setState(this.attempt === 0 ? "connecting" : "reconnecting");
    const sock = new WebSocket(this.options.url);
    this.sock = sock;

    sock.on("open", () => {
      this.attempt = 0;
      this.setState("open");
    });

    sock.on("message", (data: unknown, isBinary: boolean) => {
      if (isBinary) {
        // 二进制帧为执行预览（progress 的图像数据），本项目不消费，显式计数丢弃
        this.stats.binaryFramesSkipped++;
        return;
      }
      try {
        const raw = JSON.parse(String(data)) as ComfyRawEvent;
        if (typeof raw?.type === "string") {
          this.stats.lastEventType = raw.type;
          for (const cb of [...this.rawListeners]) cb(raw);
        }
      } catch {
        this.stats.parseErrors++;
      }
    });

    const onDrop = (reason: string): void => {
      if (this.stopped || this.sock !== sock) return;
      this.sock = null;
      this.scheduleReconnect(reason);
    };
    sock.on("close", () => onDrop("close"));
    sock.on("error", () => onDrop("error")); // ws 的 error 后必跟 close，去重处理
  }

  private scheduleReconnect(reason: string): void {
    this.attempt++;
    this.stats.reconnects++;
    this.setState("reconnecting");
    const cap = Math.min(this.opts.maxMs, this.opts.initialMs * this.opts.factor ** (this.attempt - 1));
    // 全抖动：[initialMs/2, cap] 均匀分布
    const delay = Math.round(this.opts.initialMs / 2 + Math.random() * Math.max(0, cap - this.opts.initialMs / 2));
    void reason;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private setState(s: WsState): void {
    if (this.state === s) return;
    this.state = s;
    this.stats.state = s;
    for (const cb of [...this.stateListeners]) cb(s);
  }
}
