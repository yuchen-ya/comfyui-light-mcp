import path from "node:path";
import type { ComfyClient } from "../client/index.js";
import type { HistoryEntry, HistoryNodeOutputs } from "../client/types.js";
import { jailedJoin, safeFileName } from "./path-jail.js";
import type { JobOutputAsset } from "../batch/store.js";
import { atomicWrite, checkLocalPath } from "./local-files.js";

type OutputRef = Pick<JobOutputAsset, "kind" | "filename" | "subfolder" | "type">;

/**
 * Asset Manager：输出收获与落盘（docs/002 §6.2 输出落盘决策）。
 * - 保留 ComfyUI 原始文件名（重名加序号）
 * - kind 通用扩展：image/video/audio/file（gifs→video，未识别数组→file）
 * - 布局：OUTPUT_DIR/<batch_id>/<idx>/<filename>
 */

/** 从 history 收获全部输出引用（含未知类型，保持通用性） */
export function harvestOutputRefs(entry: HistoryEntry): Array<{
  kind: JobOutputAsset["kind"];
  filename: string;
  subfolder: string;
  type: string;
}> {
  const refs: Array<{ kind: JobOutputAsset["kind"]; filename: string; subfolder: string; type: string }> = [];
  for (const nodeOutputs of Object.values(entry.outputs ?? {})) {
    const o = nodeOutputs as HistoryNodeOutputs;
    for (const [key, value] of Object.entries(o)) {
      if (!Array.isArray(value)) continue;
      const kind = kindOf(key);
      for (const item of value) {
        if (item === null || typeof item !== "object") continue;
        const f = item as Record<string, unknown>;
        if (typeof f["filename"] !== "string") continue;
        refs.push({
          kind,
          filename: f["filename"],
          subfolder: typeof f["subfolder"] === "string" ? f["subfolder"] : "",
          type: typeof f["type"] === "string" ? f["type"] : "output"
        });
      }
    }
  }
  return refs;
}

function kindOf(outputKey: string): JobOutputAsset["kind"] {
  if (outputKey === "images") return "image";
  if (outputKey === "gifs") return "video"; // ComfyUI 的 gifs 含 mp4/webp 动态格式
  if (outputKey === "audio") return "audio";
  return "file";
}

export class AssetManager {
  constructor(
    private readonly client: ComfyClient,
    private readonly outputDir: string
  ) {}

  /** 下载 history 条目的全部输出到本地，返回带绝对路径的资产清单 */
  async saveOutputs(batchId: string, idx: number, entry: HistoryEntry): Promise<JobOutputAsset[]> {
    const refs = harvestOutputRefs(entry);
    return this.downloadRefs(batchId, idx, refs);
  }

  /**
   * 按引用清单下载（AUTO_SAVE_OUTPUTS=false 时 get_result 按需下载用）。
   * 落盘布局与即时落盘完全一致：OUTPUT_DIR/<batch_id>/<idx>/<原始文件名>（重名加序号）。
   */
  async downloadRefs(
    batchId: string,
    idx: number,
    refs: OutputRef[]
  ): Promise<JobOutputAsset[]> {
    const saved: JobOutputAsset[] = [];
    const targets = this.outputPaths(batchId, idx, refs);
    for (const [i, ref] of refs.entries()) {
      saved.push(await this.downloadRef(ref, targets[i]!));
    }
    return saved;
  }

  outputPaths(batchId: string, idx: number, refs: OutputRef[]): string[] {
    const usedNames = new Set<string>();
    return refs.map((ref) => this.outputPath(batchId, idx, ref.filename, usedNames));
  }

  outputPath(batchId: string, idx: number, filename: string, usedNames: Set<string>): string {
    const base = safeFileName(filename);
    let target = base;
    let n = 2;
    while (usedNames.has(target.toLowerCase())) {
      const ext = path.extname(base);
      const stem = path.basename(base, ext);
      target = `${stem}-${n}${ext}`;
      n++;
    }
    usedNames.add(target.toLowerCase());
    return jailedJoin(this.outputDir, batchId, String(idx), target);
  }

  async downloadRef(ref: OutputRef, localPath: string): Promise<JobOutputAsset> {
    await checkLocalPath(this.outputDir, localPath);
    const res = await this.client.http.downloadOutput({
      filename: ref.filename,
      subfolder: ref.subfolder,
      type: ref.type
    });
    if (!res.ok) throw new Error(`Output download HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await atomicWrite(this.outputDir, localPath, buf);
    return { ...ref, local_path: localPath, bytes: buf.length };
  }
}
