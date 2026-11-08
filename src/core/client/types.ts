// 类型定义参考了 MetaBrain-Labs/ComfyUI-MCP-Server-TypeScript (MIT), commit 765c713
// 的 src/types/*，并按本项目需要改编。字段形状以真实环境验证为准（docs/003）。

/** ComfyUI API 格式工作流图：nodeId → node */
export type WorkflowGraph = Record<string, WorkflowNode>;

export interface WorkflowNode {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: { title?: string };
}

/** /prompt 校验错误。结构随 ComfyUI 版本变动，保持宽松，以真实验证为准。 */
export type NodeErrors = Record<string, Record<string, unknown>>;

export interface SystemStats {
  system?: {
    os?: string;
    comfyui_version?: string;
    python_version?: string;
    pytorch_version?: string;
    [k: string]: unknown;
  };
  devices?: Array<Record<string, unknown>>;
}

/** POST /prompt 结果：ok=false 表示 ComfyUI 拒绝（400 等），nodeErrors 尽力提取 */
export type SubmitResult =
  | { ok: true; promptId: string; number: number; nodeErrors: NodeErrors }
  | { ok: false; httpStatus: number; errorBody: unknown; nodeErrors: NodeErrors | null };

/** /history 单条记录。outputs 的键为 nodeId。 */
export interface HistoryEntry {
  prompt: unknown[];
  outputs: Record<string, HistoryNodeOutputs>;
  status?: Record<string, unknown>;
  [k: string]: unknown;
}

/** 单节点输出：images 为常见形态，gifs/audio/其他键以真实环境为准 */
export interface HistoryNodeOutputs {
  images?: HistoryOutputImage[];
  gifs?: HistoryOutputGif[];
  audio?: HistoryOutputAudio[];
  [k: string]: unknown;
}

export interface HistoryOutputImage {
  filename: string;
  subfolder: string;
  type: string;
  [k: string]: unknown;
}

export interface HistoryOutputGif {
  filename: string;
  subfolder: string;
  type: string;
  format?: string;
  [k: string]: unknown;
}

export interface HistoryOutputAudio {
  filename: string;
  subfolder: string;
  type: string;
  [k: string]: unknown;
}

/** /view 下载定位 */
export interface OutputRef {
  filename: string;
  subfolder: string;
  type: string;
}

/**
 * /queue 条目为元组：[序号, 批号, prompt_id, prompt图, extra_data, outputs_to_execute]
 * 版本间存在差异，保持宽松。
 */
export type QueueItem = [number, number, string, unknown, unknown, unknown?];

export interface QueueInfo {
  queue_running: QueueItem[];
  queue_pending: QueueItem[];
  [k: string]: unknown;
}

/** /object_info/{node} 的输入规格（冒烟脚本用于构造测试图） */
export interface ObjectInfoNode {
  name?: string;
  input?: { required?: Record<string, unknown>; optional?: Record<string, unknown> };
  [k: string]: unknown;
}
