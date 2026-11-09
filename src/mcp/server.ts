import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Engine } from "../core/engine.js";
import { ParamsValidationError } from "../core/workflow/mapper.js";
import { ComfyLightError } from "../shared/errors.js";
import { renderBounded } from "../shared/truncate.js";
import { INSTRUCTIONS } from "./instructions.js";

/**
 * MCP Interface（唯一依赖 MCP SDK 的层，docs/002 §1）。
 * Task 004 四工具：list_workflows / run_workflow（单 params 或 runs 数组）/ get_result / get_batch。
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
    { name: "comfyui-light-mcp", version: "0.3.0" },
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
        "提交运行工作流：单运行传 params（P2 兼容），批量传 runs 数组（每项 {label?, params}）。参数只接受 manifest 白名单；单 run 参数错误在批量下记为 invalid job 不影响其他 run，单运行简写则整体报错。可选 idempotency_key（同键重复调用不产生新 batch/新提交）、continue_on_error（默认 true：单任务失败不影响其余）、max_attempts（默认 1 不重试）。立即返回 batch_id，用 get_result（单运行）/ get_batch（批量）轮询。",
      inputSchema: {
        workflow: z.string().describe("list_workflows 中的名称"),
        params: z.record(z.string(), z.unknown().default({})).optional().describe("单运行参数集（与 runs 二选一）"),
        runs: z
          .array(
            z.object({
              label: z.string().max(200).optional().describe("可选标记，便于结果对照"),
              params: z.record(z.string(), z.unknown().default({})).default({}).describe("该运行的参数覆盖集")
            })
          )
          .min(1)
          .max(200)
          .optional()
          .describe("批量运行数组（与 params 二选一）；按数组顺序调度执行"),
        label: z.string().optional().describe("单运行时的可选标记"),
        idempotency_key: z.string().min(1).max(200).optional().describe("幂等键：同键+相同请求内容重复调用返回既有 batch，不重复提交；同键但内容不同返回 IDEMPOTENCY_CONFLICT"),
        continue_on_error: z.boolean().optional().describe("默认 true；false 时首个失败将放弃该 batch 剩余未提交任务"),
        max_attempts: z.number().int().min(1).max(5).optional().describe("失败重试次数上限（含首次共 N 次尝试），默认 1 不重试")
      }
    },
    async (args) => {
      const { workflow, params, runs, label, idempotency_key, continue_on_error, max_attempts } = args;
      if (params !== undefined && runs !== undefined) {
        return fail("params 与 runs 二选一：单运行用 params，批量用 runs 数组");
      }
      try {
        if (runs !== undefined) {
          const handle = await engine.runBatch({
            workflow,
            runs,
            idempotencyKey: idempotency_key,
            continueOnError: continue_on_error,
            maxAttempts: max_attempts
          });
          return ok({
            ...handle,
            next: `get_batch(batch_id="${handle.batch_id}")`
          });
        }
        const handle = await engine.runSingle({
          workflow,
          params: params ?? {},
          label,
          idempotencyKey: idempotency_key
        });
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
      description:
        "查询结果：省略 mode 时返回 index 指定的单项详情（默认 0）。mode=index 将全部 job 的精简结果写入本地 JSONL 索引，只返回计数、complete、index_path 和更新时间；complete 仅表示执行均已终结，unavailable_outputs 表示尚不可用文件数。默认按需下载，不触发生成；可用 get_batch 轮询进度。",
      inputSchema: {
        batch_id: z.string().describe("run_workflow 返回的 batch_id"),
        mode: z.enum(["index"]).optional().describe("index：批次完整本地索引；省略：兼容单项查询"),
        index: z.number().int().min(0).default(0).describe("运行序号（单运行为 0）"),
        download: z.boolean().default(true).describe("succeeded 且输出未落盘时按需下载（默认 true，幂等）")
      }
    },
    async ({ batch_id, mode, index, download }) => {
      try {
        if (mode === "index") {
          const result = await engine.getResultIndex(batch_id, { download });
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
        }
        return ok(await engine.getResult(batch_id, index, { download }));
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.registerTool(
    "get_batch",
    {
      description:
        "查询批量运行全貌：batch 状态 + 逐状态统计（succeeded/failed/running/queued/pending/invalid/unknown/paused——submission_unknown 与 paused 单列，绝不混入 failed）+ 分页 job 列表（有界字段：状态/attempt/错误摘要/输出数，不含完整参数与日志）。status 可过滤：pending|invalid|submitting|unknown|queued|executing|succeeded|failed|timeout|cancelled|paused。",
      inputSchema: {
        batch_id: z.string().describe("run_workflow 返回的 batch_id"),
        limit: z.number().int().min(1).max(100).default(20).describe("分页大小，默认 20，上限 100"),
        offset: z.number().int().min(0).default(0).describe("分页偏移，默认 0"),
        status: z.string().optional().describe("可选：按 job 状态过滤列表（统计不受影响）")
      }
    },
    async ({ batch_id, limit, offset, status }) => {
      try {
        return ok(engine.getBatch(batch_id, { limit, offset, status }));
      } catch (e) {
        return toolError(e);
      }
    }
  );

  return server;
}
