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
    engine.tracker.disposeAll();
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
  it("tools/list 恰好包含 3 个 P2 工具", async () => {
    await withMcp(async ({ client }) => {
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name).sort()).toEqual(["get_result", "list_workflows", "run_workflow"]);
    });
  });

  it("list_workflows：摘要含真实示例；未知名 → isError + 可用清单", async () => {
    await withMcp(async ({ client }) => {
      const list = text((await client.callTool({ name: "list_workflows", arguments: {} })) as never) as {
        workflows: Array<{ name: string; params: number }>;
      };
      const demo = list.workflows.find((w) => w.name === "qwen-image-demo");
      expect(demo?.params).toBe(7);

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
        if (final["status"] !== "queued" && final["status"] !== "executing") break;
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
});
