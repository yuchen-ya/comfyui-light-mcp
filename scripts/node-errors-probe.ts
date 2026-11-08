import { readFile } from "node:fs/promises";
import path from "node:path";
import { createComfyClient } from "../src/core/client/index.js";
import type { WorkflowGraph } from "../src/core/client/types.js";

/**
 * Task 004 §七：node_errors 真实样本探针。
 * 目的：用「manifest 前置校验放行、但 ComfyUI 校验拒绝」的非法 combo 值触发 POST /prompt 拒绝，
 * 记录 HTTP 状态码 / error 结构 / node_errors 结构 / 是否有 prompt_id / 是否产生执行事件。
 * 运行：COMFYUI_URL=http://127.0.0.1:8188 npm run probe:node-errors
 */

const url = process.env["COMFYUI_URL"] ?? "http://127.0.0.1:8188";

async function main(): Promise<void> {
  const graph = JSON.parse(
    await readFile(path.resolve("workflows", "examples", "qwen-image.json"), "utf8")
  ) as WorkflowGraph;
  // 非法 combo：sampler_name 不在 KSampler 的合法枚举内（manifest 若声明该参数为普通 string 则前置校验放行）
  graph["7"]!.inputs["sampler_name"] = "euler_NOT_EXIST";

  const client = createComfyClient({ comfyUiUrl: url });
  const health = await client.http.healthCheck();
  console.log(`[probe] ComfyUI ${health.version} @ ${url}`);

  const res = await client.http.submitPrompt(graph, { clientId: client.clientId });
  if (res.ok) {
    console.error("[probe] 意外：非法 combo 被接受（不应发生）");
    process.exitCode = 1;
    return;
  }
  console.log("=== HTTP 状态码 ===");
  console.log(res.httpStatus);
  console.log("=== error 结构 ===");
  console.log(JSON.stringify(res.errorBody, null, 2));
  console.log("=== node_errors 结构 ===");
  console.log(JSON.stringify(res.nodeErrors, null, 2));

  // 拒绝后队列与历史不应有该提交（无 prompt_id 回显、无执行事件）
  const queue = await client.http.getQueue();
  const pending = [...queue.queue_running, ...queue.queue_pending].length;
  console.log("=== 拒绝后队列长度（应为 0 项新增） ===");
  console.log(pending);
  client.stop();
}

void main().catch((e) => {
  console.error("[probe] 失败:", e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
