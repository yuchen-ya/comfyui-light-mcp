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
    message: string,
    public readonly code = "INVALID_WORKFLOW",
    public readonly nodeId?: string,
    public readonly input?: string
  ) {
    super(`工作流格式错误 [${file}]: ${message}`);
    this.name = "WorkflowFormatError";
  }
}

const nodeIdPattern = /^[A-Za-z0-9_#-]{1,64}$/;

/** JSON.parse 会静默保留重复键的最后一个值，因此在解析前额外扫描顶层节点键。 */
function duplicateTopLevelKeys(text: string): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  let depth = 0;
  let expectingKey = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      let end = i + 1;
      let escaped = false;
      for (; end < text.length; end++) {
        const c = text[end];
        if (escaped) {
          escaped = false;
        } else if (c === "\\") {
          escaped = true;
        } else if (c === '"') {
          break;
        }
      }
      if (depth === 1 && expectingKey && end < text.length) {
        let colon = end + 1;
        while (colon < text.length && /\s/.test(text[colon]!)) colon++;
        if (text[colon] === ":") {
          const key = JSON.parse(text.slice(i, end + 1)) as string;
          if (seen.has(key)) duplicates.add(key);
          seen.add(key);
          expectingKey = false;
        }
      }
      i = end;
      continue;
    }
    if (ch === "{") {
      depth++;
      if (depth === 1) expectingKey = true;
    } else if (ch === "}") {
      depth--;
    } else if (ch === "," && depth === 1) {
      expectingKey = true;
    }
  }
  return [...duplicates];
}

export function parseWorkflowGraph(file: string, text: string): WorkflowGraph {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new WorkflowFormatError(file, `不是合法 JSON: ${e instanceof Error ? e.message : String(e)}`, "INVALID_JSON");
  }
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    throw new WorkflowFormatError(file, "顶层必须是对象（nodeId → node）", "INVALID_API_FORMAT");
  }
  const duplicates = duplicateTopLevelKeys(text);
  if (duplicates.length > 0) {
    const id = duplicates[0]!;
    throw new WorkflowFormatError(file, `节点 ID "${id}" 重复`, "DUPLICATE_NODE_ID", id);
  }
  const obj = json as Record<string, unknown>;
  // UI 格式特征：nodes/links 数组 + 最后一个元素为版本号
  if (Array.isArray(obj["nodes"]) && Array.isArray(obj["links"])) {
    throw new WorkflowFormatError(
      file,
      "这是 UI 格式（含 nodes/links）。请在 ComfyUI 中用开发者模式导出 API 格式（Save (API Format)）后放入",
      "UI_FORMAT_REJECTED"
    );
  }
  const graph: WorkflowGraph = {};
  for (const [id, v] of Object.entries(obj)) {
    if (!nodeIdPattern.test(id)) {
      throw new WorkflowFormatError(file, `节点 ID "${id}" 非法；须为 1–64 位字母数字或 _#-`, "INVALID_NODE_ID", id);
    }
    if (v === null || typeof v !== "object" || Array.isArray(v)) {
      throw new WorkflowFormatError(file, `节点 "${id}" 不是对象`, "INVALID_NODE", id);
    }
    const node = v as Record<string, unknown>;
    if (typeof node["class_type"] !== "string" || node["class_type"] === "") {
      throw new WorkflowFormatError(file, `节点 "${id}" 缺少 class_type（疑似非 API 格式）`, "MISSING_CLASS_TYPE", id);
    }
    if (node["inputs"] === null || typeof node["inputs"] !== "object" || Array.isArray(node["inputs"])) {
      throw new WorkflowFormatError(file, `节点 "${id}" 的 inputs 不是对象`, "INVALID_INPUTS", id);
    }
    graph[id] = { class_type: node["class_type"], inputs: node["inputs"] as Record<string, unknown> };
  }
  if (Object.keys(graph).length === 0) {
    throw new WorkflowFormatError(file, "图为空", "EMPTY_WORKFLOW");
  }
  return graph;
}

export async function loadWorkflowGraph(file: string, dir: string): Promise<WorkflowGraph> {
  const full = path.join(dir, file);
  let text: string;
  try {
    text = await readFile(full, "utf8");
  } catch (e) {
    throw new WorkflowFormatError(file, `读取失败: ${e instanceof Error ? e.message : String(e)}`, "WORKFLOW_READ_FAILED");
  }
  return parseWorkflowGraph(file, text);
}
