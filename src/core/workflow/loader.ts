import { readFile } from "node:fs/promises";
import path from "node:path";
import type { WorkflowGraph } from "../client/types.js";

/**
 * Workflow Loader：读取并校验 ComfyUI API 格式 JSON。
 * UI 格式（含 nodes/links 数组）在此被拒绝——只有 API 格式才能被 /prompt 直接消费。
 */

export class WorkflowFormatError extends Error {
  constructor(
    public readonly file: string,
    message: string
  ) {
    super(`工作流格式错误 [${file}]: ${message}`);
    this.name = "WorkflowFormatError";
  }
}

export async function loadWorkflowGraph(file: string, dir: string): Promise<WorkflowGraph> {
  const full = path.join(dir, file);
  let text: string;
  try {
    text = await readFile(full, "utf8");
  } catch (e) {
    throw new WorkflowFormatError(file, `读取失败: ${e instanceof Error ? e.message : String(e)}`);
  }
  return parseWorkflowGraph(file, text);
}

/** 纯解析（registry 已持有原始文本时使用，便于同时计算内容指纹） */
export function parseWorkflowGraph(file: string, text: string): WorkflowGraph {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new WorkflowFormatError(file, `不是合法 JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    throw new WorkflowFormatError(file, "顶层必须是对象（nodeId → node）");
  }
  const obj = json as Record<string, unknown>;
  // UI 格式特征：nodes/links 数组 + 最后一个元素为版本号
  if (Array.isArray(obj["nodes"]) && Array.isArray(obj["links"])) {
    throw new WorkflowFormatError(
      file,
      "这是 UI 格式（含 nodes/links）。请在 ComfyUI 中用开发者模式导出 API 格式（Save (API Format)）后放入"
    );
  }
  const graph: WorkflowGraph = {};
  for (const [id, v] of Object.entries(obj)) {
    if (v === null || typeof v !== "object" || Array.isArray(v)) {
      throw new WorkflowFormatError(file, `节点 "${id}" 不是对象`);
    }
    const node = v as Record<string, unknown>;
    if (typeof node["class_type"] !== "string" || node["class_type"] === "") {
      throw new WorkflowFormatError(file, `节点 "${id}" 缺少 class_type（疑似非 API 格式）`);
    }
    if (node["inputs"] === null || typeof node["inputs"] !== "object" || Array.isArray(node["inputs"])) {
      throw new WorkflowFormatError(file, `节点 "${id}" 的 inputs 不是对象`);
    }
    graph[id] = { class_type: node["class_type"], inputs: node["inputs"] as Record<string, unknown> };
  }
  if (Object.keys(graph).length === 0) {
    throw new WorkflowFormatError(file, "图为空");
  }
  return graph;
}
