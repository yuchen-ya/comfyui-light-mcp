import { describe, expect, it } from "vitest";
import { ComfyEventBus, translateJobEvent } from "../../src/core/client/event-bus.js";

describe("translateJobEvent", () => {
  it("execution_start → started", () => {
    expect(translateJobEvent({ type: "execution_start", prompt_id: "p", data: {} })).toEqual({ type: "started" });
  });

  it("executing 兼容 node 与 node_id 字段；null 为完毕哨兵", () => {
    expect(translateJobEvent({ type: "executing", prompt_id: "p", data: { node: "12" } })).toEqual({
      type: "executing",
      nodeId: "12"
    });
    expect(translateJobEvent({ type: "executing", prompt_id: "p", data: { node_id: "7" } })).toEqual({
      type: "executing",
      nodeId: "7"
    });
    expect(translateJobEvent({ type: "executing", prompt_id: "p", data: { node: null } })).toEqual({
      type: "executing",
      nodeId: null
    });
  });

  it("progress 提取 value/max", () => {
    expect(translateJobEvent({ type: "progress", prompt_id: "p", data: { value: 3, max: 10 } })).toEqual({
      type: "progress",
      value: 3,
      max: 10
    });
  });

  it("executed 提取 node 与 output", () => {
    const e = translateJobEvent({
      type: "executed",
      prompt_id: "p",
      data: { node: "9", output: { images: [{ filename: "a.png" }] } }
    });
    expect(e).toEqual({
      type: "executed",
      nodeId: "9",
      outputs: { images: [{ filename: "a.png" }] }
    });
  });

  it("execution_error 提取 exception_message；缺省有兜底文案", () => {
    expect(
      translateJobEvent({ type: "execution_error", prompt_id: "p", data: { exception_message: "boom" } })
    ).toEqual({ type: "error", message: "boom", details: { exception_message: "boom" } });
    const fallback = translateJobEvent({ type: "execution_error", prompt_id: "p", data: {} });
    expect(fallback && fallback.type === "error" && fallback.message.includes("无 exception_message")).toBe(true);
  });

  it("execution_success / execution_interrupted 映射", () => {
    expect(translateJobEvent({ type: "execution_success", prompt_id: "p" })).toEqual({ type: "success" });
    expect(translateJobEvent({ type: "execution_interrupted", prompt_id: "p" })).toEqual({ type: "interrupted" });
  });

  it("status / 未知类型返回 null", () => {
    expect(translateJobEvent({ type: "status", data: { status: {} } })).toBeNull();
    expect(translateJobEvent({ type: "execution_cached", data: { nodes: ["1"] } })).toBeNull();
    expect(translateJobEvent({ type: "future_event" })).toBeNull();
  });
});

describe("ComfyEventBus", () => {
  it("按 prompt_id 多路分解，互不串扰（metabrain 竞态的回归测试）", () => {
    const bus = new ComfyEventBus();
    const gotA: string[] = [];
    const gotB: string[] = [];
    bus.subscribePrompt("A", (e) => gotA.push(e.type));
    bus.subscribePrompt("B", (e) => gotB.push(e.type));

    bus.publish({ type: "execution_start", prompt_id: "A", data: {} });
    bus.publish({ type: "execution_start", prompt_id: "B", data: {} });
    bus.publish({ type: "execution_success", prompt_id: "A" });

    expect(gotA).toEqual(["started", "success"]);
    expect(gotB).toEqual(["started"]);
  });

  it("无 prompt_id 的事件不投递给 job 订阅者，仅 any 订阅者可见", () => {
    const bus = new ComfyEventBus();
    const jobs: string[] = [];
    const anys: string[] = [];
    bus.subscribePrompt("A", (e) => jobs.push(e.type));
    bus.subscribeAny((raw) => anys.push(raw.type));
    bus.publish({ type: "status", data: { status: { exec_info: { queue_remaining: 1 } } } });
    expect(jobs).toEqual([]);
    expect(anys).toEqual(["status"]);
  });

  it("退订后不再接收；引用可回收", () => {
    const bus = new ComfyEventBus();
    const got: string[] = [];
    const off = bus.subscribePrompt("A", (e) => got.push(e.type));
    bus.publish({ type: "execution_start", prompt_id: "A", data: {} });
    off();
    bus.publish({ type: "execution_success", prompt_id: "A" });
    expect(got).toEqual(["started"]);
  });

  it("disconnect / reconnect 通知", () => {
    const bus = new ComfyEventBus();
    const events: string[] = [];
    bus.onDisconnect(() => events.push("down"));
    bus.onReconnect(() => events.push("up"));
    bus.emitDisconnect();
    bus.emitReconnect();
    expect(events).toEqual(["down", "up"]);
  });
});
