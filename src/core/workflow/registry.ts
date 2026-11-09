import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { WorkflowGraph } from "../client/types.js";
import { parseWorkflowGraph, WorkflowFormatError } from "./loader.js";
import { ManifestError, parseManifest, type WorkflowManifest } from "./manifest.js";
import { sha256Hex } from "../../shared/fingerprint.js";

/** 递归收集 *.manifest.json（返回相对 workflowsDir 的路径） */
async function listManifestFiles(root: string, rel: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(path.join(root, rel), { withFileTypes: true });
  for (const e of entries) {
    const childRel = rel ? path.join(rel, e.name) : e.name;
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      out.push(...(await listManifestFiles(root, childRel)));
    } else if (e.isFile() && e.name.endsWith(".manifest.json")) {
      out.push(childRel);
    }
  }
  return out;
}

/**
 * Workflow Registry：启动扫描 workflows 目录，manifest + API JSON 成对加载与交叉校验。
 * 不向 ComfyUI userdata 做任何"巡检"（metabrain 教训，见 docs/001 §3.3）。
 * load() 不抛异常：逐文件错误进 LoadReport（上下文友好，Agent 可自愈）。
 */

/** 工作流内容指纹（Task 005 §二.2）：manifest 与 API JSON 各自原始文本的 sha256 */
export interface WorkflowFingerprint {
  readonly manifest: string;
  readonly graph: string;
}

export interface RegisteredWorkflow {
  readonly manifest: WorkflowManifest;
  readonly graph: WorkflowGraph;
  /** manifest 文件绝对路径（错误定位用） */
  readonly sourceFile: string;
  /** 注册时内容指纹（batch 创建时快照，恢复/续跑时比对防版本漂移） */
  readonly fingerprint: WorkflowFingerprint;
}

export interface WorkflowSummary {
  name: string;
  description: string;
  version: number;
  params: number;
}

export interface LoadError {
  file: string;
  message: string;
  issues?: string[];
}

export interface LoadReport {
  loaded: WorkflowSummary[];
  errors: LoadError[];
}

/** manifest 与 API JSON 的交叉校验（防漂移，docs/002 §4.2） */
function crossValidate(manifest: WorkflowManifest, graph: WorkflowGraph, file: string): LoadError | null {
  for (const p of manifest.params) {
    const node = graph[p.node];
    if (!node) {
      return { file, message: `参数 "${p.name}" 引用的节点 "${p.node}" 在工作流图中不存在。图内节点: ${Object.keys(graph).join(", ")}` };
    }
    if (!(p.input in node.inputs)) {
      return {
        file,
        message: `参数 "${p.name}" 引用的输入 "${p.node}.inputs.${p.input}" 不存在。该节点可用输入: ${Object.keys(node.inputs).join(", ") || "<无>"}`
      };
    }
    const current = node.inputs[p.input];
    if (current !== undefined && current !== null && Array.isArray(current)) {
      return { file, message: `参数 "${p.name}" 指向的输入 "${p.node}.inputs.${p.input}" 是连线输入（数组），不可作为参数覆写目标` };
    }
    // 类型相容：宽松校验当前值类型（ComfyUI 里 number 也可存成字符串，不硬拒）
    if (p.special === "seed" && typeof current !== "number" && typeof current !== "string") {
      return { file, message: `seed 参数 "${p.name}" 的当前值类型异常（${typeof current}），须为 number` };
    }
  }
  return null;
}

export class WorkflowRegistry {
  private readonly byName = new Map<string, RegisteredWorkflow>();

  constructor(private readonly workflowsDir: string) {}

  /** 扫描目录（含子目录）：*.manifest.json + 同目录 workflowFile 配对 */
  async load(): Promise<LoadReport> {
    const report: LoadReport = { loaded: [], errors: [] };
    let manifestFiles: string[];
    try {
      manifestFiles = (await listManifestFiles(this.workflowsDir, "")).sort();
    } catch (e) {
      report.errors.push({
        file: this.workflowsDir,
        message: `工作流目录不可读: ${e instanceof Error ? e.message : String(e)}。请设置 WORKFLOWS_DIR 并放入 *.manifest.json + API JSON`
      });
      return report;
    }
    if (manifestFiles.length === 0) {
      report.errors.push({ file: this.workflowsDir, message: "未找到任何 *.manifest.json" });
      return report;
    }
    for (const mf of manifestFiles) {
      const manifestPath = path.join(this.workflowsDir, mf);
      try {
        const text = await readFile(manifestPath, "utf8");
        const manifest = parseManifest(mf, text);
        let graphText: string;
        try {
          graphText = await readFile(path.join(path.dirname(manifestPath), manifest.workflowFile), "utf8");
        } catch (e) {
          throw new WorkflowFormatError(manifest.workflowFile, `读取失败: ${e instanceof Error ? e.message : String(e)}`);
        }
        const graph = parseWorkflowGraph(manifest.workflowFile, graphText);
        const xerr = crossValidate(manifest, graph, mf);
        if (xerr) {
          report.errors.push(xerr);
          continue;
        }
        if (this.byName.has(manifest.name)) {
          report.errors.push({ file: mf, message: `工作流名 "${manifest.name}" 重复（已由先有的 manifest 注册）` });
          continue;
        }
        this.byName.set(manifest.name, {
          manifest,
          graph,
          sourceFile: manifestPath,
          fingerprint: { manifest: sha256Hex(text), graph: sha256Hex(graphText) }
        });
        report.loaded.push({
          name: manifest.name,
          description: manifest.description,
          version: manifest.version,
          params: manifest.params.length
        });
      } catch (e) {
        if (e instanceof ManifestError) {
          report.errors.push({ file: e.file, message: e.message.replace(/^manifest 错误 \[.*?\]: /, ""), issues: e.issues });
        } else if (e instanceof WorkflowFormatError) {
          report.errors.push({ file: e.file, message: e.message.replace(/^工作流格式错误 \[.*?\]: /, "") });
        } else {
          report.errors.push({ file: mf, message: e instanceof Error ? e.message : String(e) });
        }
      }
    }
    return report;
  }

  get(name: string): RegisteredWorkflow | undefined {
    return this.byName.get(name);
  }

  list(): WorkflowSummary[] {
    return [...this.byName.values()].map((w) => ({
      name: w.manifest.name,
      description: w.manifest.description,
      version: w.manifest.version,
      params: w.manifest.params.length
    }));
  }

  /** manifest 参数详情（list_workflows 指定名时） */
  paramDetail(name: string): Array<Record<string, unknown>> | undefined {
    const w = this.byName.get(name);
    if (!w) return undefined;
    return w.manifest.params.map((p) => ({
      name: p.name,
      type: p.type,
      required: p.required ?? false,
      default: p.default,
      enum: p.enum,
      min: p.min,
      max: p.max,
      step: p.step,
      seed: p.special === "seed" ? "-1 = 每次执行随机（实际值记录于结果 params_resolved）" : undefined,
      description: p.description
    }));
  }
}
