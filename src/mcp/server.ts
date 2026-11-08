import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Engine } from "../core/engine.js";
import { ParamsValidationError } from "../core/workflow/mapper.js";
import { ComfyLightError } from "../shared/errors.js";
import { renderBounded } from "../shared/truncate.js";
import { INSTRUCTIONS } from "./instructions.js";

/**
 * MCP Interface（唯一依赖 MCP SDK 的层，docs/002 §1）。
 * P2 工具：list_workflows / run_workflow（单运行，接口留 runs 扩展位）/ get_result。
 * 工具层职责仅三件事：解析入参 → engine → 有界化输出/结构化错误。
 */

const MAX_TEXT = 20_000;

function ok(value: unknown) {
  return { content: [{ type: "text" as const, text: renderBounded(value, MAX_TEXT) }] };
}

function fail(message: string, details?: unknown) {
  const text = details === undefined ? message : `${message}\n${renderBounded(details, 2000)}`;
  return { content: [{ type: "text" as const, text }], isError: true };
}

function toolError(e: unknown) {
  if (e instanceof ParamsValidationError) {
    return fail("参数校验失败（按错误修正后重试）:", e.issues);
  }
  if (e instanceof ComfyLightError) {
    return fail(`[${e.code}] ${e.message}`);
  }
  return fail(`内部错误: ${e instanceof Error ? e.message : String(e)}`);
}

export function createMcpServer(engine: Engine): McpServer {
  const server = new McpServer(
    { name: "comfyui-light-mcp", version: "0.2.0" },
    { instructions: INSTRUCTIONS }
  );

  server.registerTool(
    "list_workflows",
    {
      description: "列出已注册工作流（名称+描述+参数个数）。传 workflow 名则返回该工作流的完整参数说明（类型/必填/默认/枚举/范围）。",
      inputSchema: { workflow: z.string().optional().describe("可选：工作流名，返回参数详情") }
    },
    async ({ workflow }) => {
      const result = engine.listWorkflows(workflow);
      if ("error" in (result as Record<string, unknown>)) {
        const err = (result as { error: { message: string } }).error;
        return fail(err.message);
      }
      return ok(result);
    }
  );

  server.registerTool(
    "run_workflow",
    {
      description:
        "提交运行一个工作流（P2 单运行；参数只接受 manifest 白名单）。立即返回 batch_id/index，用 get_result 轮询。params 的可用键先经 list_workflows(workflow) 查询。",
      inputSchema: {
        workflow: z.string().describe("list_workflows 中的名称"),
        params: z.record(z.string(), z.unknown()).default({}).describe("参数覆盖集，键须匹配 manifest 白名单"),
        label: z.string().optional().describe("可选标记，便于结果对照")
      }
    },
    async ({ workflow, params, label }) => {
      try {
        const handle = await engine.runSingle({ workflow, params, label });
        return ok({
          ...handle,
          next: `get_result(batch_id="${handle.batch_id}", index=${handle.index})`
        });
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.registerTool(
    "get_result",
    {
      description: "查询单个运行的结果与状态；succeeded 后 outputs 为本地绝对路径文件清单。",
      inputSchema: {
        batch_id: z.string().describe("run_workflow 返回的 batch_id"),
        index: z.number().int().min(0).default(0).describe("运行序号（P2 单运行为 0）")
      }
    },
    async ({ batch_id, index }) => {
      try {
        return ok(engine.getResult(batch_id, index));
      } catch (e) {
        return toolError(e);
      }
    }
  );

  return server;
}
