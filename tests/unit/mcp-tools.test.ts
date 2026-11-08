import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { Engine } from "../../src/core/engine.js";
import { openDb } from "../../src/core/storage/db.js";
import { loadConfig } from "../../src/config.js";
import { makeFakeClient, historyEntry, type FakeHttpState } from "../helpers/fake-client.js";
import { readFile } from "node:fs/promises";
import path from "node:path";

/** MCP 层内存传输测试：真实 McpServer + SDK Client 全链路（除 stdio 传输本身） */
async function withMcp(fn: (args: {
  client: Client;
  engine: Engine;
  fake: FakeHttpState;
}) => Promise<void>): Promise<void> {
  const config = loadConfig({
    COMFYUI_URL: "http://fake",
    WORKFLOWS_DIR: "./workflows",
    DATA_DIR: "./.analysis/t-data",
    OUTPUT_DIR: "./.analysis/t-out"
  });
  const db = openDb(":memory:");
  const fake = makeFakeClient();
  const engine = new Engine(config, fake.client, db);
  const report = await engine.loadWorkflowsAsync();
  expect(report.errors).toEqual([]);
  const server = createMcpServer(engine);
  const [sT, cT] = InMemoryTransport.createLinkedPair();
  await server.connect(sT);
  const client = new Client({ name: "test-client", version: "0.0.1" });
  await client.connect(cT);
  try {
    await fn({ client, engine, fake: fake.state });
  } finally {
    await client.close();
    await server.close();
    engine.stop();
    db.close();
  }
}

interface ToolRes {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

function text(res: ToolRes): Record<string, unknown> {
  expect(res.content[0]?.type).toBe("text");
  return JSON.parse(res.content[0]!.text!) as Record<string, unknown>;
}

describe("MCP 工具（内存传输）", () => {
  it("tools/list 恰好包含 4 个工具（Task 004 起含 get_batch）", async () => {
    await withMcp(async ({ client }) => {
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name).sort()).toEqual(["get_batch", "get_result", "list_workflows", "run_workflow"]);
    });
  });

  it("list_workflows：摘要含真实示例；未知名 → isError + 可用清单", async () => {
    await withMcp(async ({ client }) => {
      const list = text((await client.callTool({ name: "list_workflows", arguments: {} })) as never) as {
        workflows: Array<{ name: string; params: number }>;
      };
      const demo = list.workflows.find((w) => w.name === "qwen-image-demo");
      expect(demo?.params).toBe(8);

      const detail = text((await client.callTool({
        name: "list_workflows",
        arguments: { workflow: "qwen-image-demo" }
      })) as never) as { params: Array<{ name: string; type: string }> };
      expect(detail.params.map((p) => p.name)).toContain("prompt");
      expect(detail.params.find((p) => p.name === "seed")?.["seed"]).toContain("-1 = 每次执行随机");

      const bad = (await client.callTool({ name: "list_workflows", arguments: { workflow: "nope" } })) as never;
      expect((bad as ToolRes).isError).toBe(true);
      expect(JSON.stringify(bad)).toContain("qwen-image-demo");
    });
  });

  it("run_workflow 参数非法 → isError 且错误可自愈（含未知键与越界值）", async () => {
    await withMcp(async ({ client, fake }) => {
      const res = (await client.callTool({
        name: "run_workflow",
        arguments: { workflow: "qwen-image-demo", params: { steps: 999, hacker_param: "x" } }
      })) as never;
      expect((res as ToolRes).isError).toBe(true);
      const t = JSON.stringify(res);
      expect(t).toContain("hacker_param");
      expect(t).toContain("999");
      expect(fake.submitCalls).toBe(0); // 校验失败不产生任何提交
    });
  });

  it("run_workflow + get_result 全链路：succeeded + 本地绝对路径文件", async () => {
    await withMcp(async ({ client, engine, fake }) => {
      const run = text((await client.callTool({
        name: "run_workflow",
        arguments: { workflow: "qwen-image-demo", params: { prompt: "a cube", steps: 4, seed: 7 }, label: "t1" }
      })) as never) as { batch_id: string; index: number; status: string };
      expect(run.status).toBe("queued");
      expect(fake.submitCalls).toBe(1);

      const job = engine.store.getJob(run.batch_id, 0)!;
      fake.history.set(job.prompt_id!, historyEntry({
        "9": { images: [{ filename: "ComfyUI_00001_.png", subfolder: "", type: "output" }] }
      }));
      fake.publishSuccess(job.prompt_id!);

      const deadline = Date.now() + 10_000;
      let final: Record<string, unknown> = {};
      while (Date.now() < deadline) {
        final = text((await client.callTool({
          name: "get_result",
          arguments: { batch_id: run.batch_id, index: 0 }
        })) as never);
        const s = String(final["status"]);
        if (!["pending", "submitting", "queued", "executing"].includes(s)) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(final["status"]).toBe("succeeded");
      const outputs = final["outputs"] as Array<{ filename: string; local_path: string; kind: string }>;
      expect(outputs[0]!.filename).toBe("ComfyUI_00001_.png");
      expect(outputs[0]!.kind).toBe("image");
      expect(path.isAbsolute(outputs[0]!.local_path)).toBe(true);
      expect(await readFile(outputs[0]!.local_path)).toBeTruthy();
      const resolved = final["params_resolved"] as { seed: number; prompt: string };
      expect(resolved.seed).toBe(7);
      expect(resolved.prompt).toBe("a cube");
    });
  });

  it("get_result 不存在的 batch → isError NOT_FOUND", async () => {
    await withMcp(async ({ client }) => {
      const res = (await client.callTool({
        name: "get_result",
        arguments: { batch_id: "no-such", index: 0 }
      })) as never;
      expect((res as ToolRes).isError).toBe(true);
      expect(JSON.stringify(res)).toContain("NOT_FOUND");
    });
  });

  it("run_workflow runs 数组：创建批量 + get_batch 统计/分页/过滤", async () => {
    await withMcp(async ({ client, engine, fake }) => {
      // 5 runs：3 合法（不同 seed）+ 2 参数非法（越界/未知键）→ invalid 独立记录
      const runs = [
        { label: "ok-1", params: { prompt: "a red sphere", steps: 4, seed: 101 } },
        { label: "bad-1", params: { prompt: "x", steps: 999 } },
        { label: "ok-2", params: { prompt: "a blue cube", steps: 4, seed: 202 } },
        { label: "bad-2", params: { prompt: "x", oops: 1 } },
        { label: "ok-3", params: { prompt: "a green cone", steps: 4, seed: 303 } }
      ];
      const run = text((await client.callTool({
        name: "run_workflow",
        arguments: { workflow: "qwen-image-demo", runs }
      })) as never) as { batch_id: string; total: number; invalid: number };
      expect(run.total).toBe(5);
      expect(run.invalid).toBe(2);

      // 串行窗口（默认 1/1）：一拍只提交 1 个合法任务
      expect(fake.submitCalls).toBe(1);

      const batch = text((await client.callTool({
        name: "get_batch",
        arguments: { batch_id: run.batch_id }
      })) as never) as {
        status: string;
        stats: Record<string, number>;
        jobs: Array<{ index: number; status: string }>;
        next_offset: number | null;
      };
      expect(batch.stats).toMatchObject({ total: 5, invalid: 2, pending: 2, queued: 1 });
      expect(batch.jobs.map((j) => j.index)).toEqual([0, 1, 2, 3, 4]);

      // 分页
      const page1 = text((await client.callTool({
        name: "get_batch",
        arguments: { batch_id: run.batch_id, limit: 2 }
      })) as never) as { jobs: unknown[]; next_offset: number | null };
      expect(page1.jobs).toHaveLength(2);
      expect(page1.next_offset).toBe(2);

      // 状态过滤（unknown → submission_unknown 别名路径同源）
      const failed = text((await client.callTool({
        name: "get_batch",
        arguments: { batch_id: run.batch_id, status: "invalid" }
      })) as never) as { jobs: Array<{ index: number; error: { code: string } }>; stats: Record<string, number> };
      expect(failed.jobs.map((j) => j.index).sort()).toEqual([1, 3]);
      expect(failed.jobs.every((j) => j.error!.code === "INVALID_PARAMS")).toBe(true);
      expect(failed.stats.invalid).toBe(2); // 统计不受过滤影响

      // 逐个完成任务（fake 直推成功事件）
      for (let i = 0; i < 3; i++) {
        await driveToSuccess(engine, fake);
      }
      const finalBatch = text((await client.callTool({
        name: "get_batch",
        arguments: { batch_id: run.batch_id }
      })) as never) as { status: string; stats: Record<string, number> };
      expect(finalBatch.stats).toMatchObject({ total: 5, succeeded: 3, invalid: 2 });
      expect(finalBatch.status).toBe("partial"); // 部分成功部分失败
    });
  });

  it("run_workflow 幂等键：重复调用返回既有 batch，不产生新提交", async () => {
    await withMcp(async ({ client, fake }) => {
      const args = {
        workflow: "qwen-image-demo",
        params: { prompt: "idem", steps: 4, seed: 1 },
        idempotency_key: "batch-req-001"
      };
      const r1 = text((await client.callTool({ name: "run_workflow", arguments: args })) as never) as { batch_id: string };
      const calls1 = fake.submitCalls;
      const r2 = text((await client.callTool({ name: "run_workflow", arguments: args })) as never) as { batch_id: string; total: number };
      expect(r2.batch_id).toBe(r1.batch_id);
      expect(fake.submitCalls).toBe(calls1); // 无新提交
    });
  });

  it("params 与 runs 同时传 → isError", async () => {
    await withMcp(async ({ client }) => {
      const res = (await client.callTool({
        name: "run_workflow",
        arguments: {
          workflow: "qwen-image-demo",
          params: { prompt: "x" },
          runs: [{ params: { prompt: "y" } }]
        }
      })) as never;
      expect((res as ToolRes).isError).toBe(true);
      expect(JSON.stringify(res)).toContain("二选一");
    });
  });
});

/** 推进调度一拍，找到当前在途 job 并推送到成功终态（fake WS 事件） */
async function driveToSuccess(engine: Engine, fake: FakeHttpState): Promise<void> {
  await engine.scheduler.tick();
  const deadline = Date.now() + 5_000;
  let job = engine.store.inFlightJobs().find((j) => j.status === "queued" || j.status === "executing");
  while (!job && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
    job = engine.store.inFlightJobs().find((j) => j.status === "queued" || j.status === "executing");
  }
  if (!job) throw new Error("driveToSuccess：无可推进的在途 job");
  fake.history.set(job.prompt_id!, historyEntry({
    "9": { images: [{ filename: `ComfyUI_0000${job.idx + 1}_.png`, subfolder: "", type: "output" }] }
  }));
  fake.publishSuccess(job.prompt_id!);
  const settleDeadline = Date.now() + 5_000;
  while (Date.now() < settleDeadline) {
    if (engine.store.getJobById(job.id)!.status === "succeeded") return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`driveToSuccess 超时: job ${job.id} 状态 ${engine.store.getJobById(job.id)!.status}`);
}
