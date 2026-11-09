import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { WorkflowGraph } from "../client/types.js";
import { parseWorkflowGraph, WorkflowFormatError } from "./loader.js";
import { ManifestError, parseManifest, type WorkflowManifest } from "./manifest.js";
import { contentFingerprint, fingerprintShort } from "../../shared/fingerprint.js";
import type { WorkflowFingerprints } from "./fingerprint.js";

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

export interface RegisteredWorkflow {
  readonly manifest: WorkflowManifest;
  readonly graph: WorkflowGraph;
  /** manifest 文件绝对路径（错误定位用） */
  readonly sourceFile: string;
  /** 内容指纹（P4.1 版本保护）：batch 创建时快照、提交/恢复时比对 */
  readonly fingerprints: WorkflowFingerprints;
  readonly loadedAt?: string;
}

export interface WorkflowSummary {
  name: string;
  description: string;
  version: number;
  params: number;
}

export type WorkflowLoadStatus = "ready" | "invalid" | "deleted";

export interface LoadError {
  file: string;
  message: string;
  issues?: string[];
  code?: string;
  node_id?: string;
  input?: string;
}

export interface WorkflowState {
  name: string;
  status: WorkflowLoadStatus;
  sourceFile: string;
  summary: WorkflowSummary | null;
  error: LoadError | null;
  loadedAt: string;
}

export interface WorkflowListItem extends WorkflowSummary {
  status: WorkflowLoadStatus;
  workflow_fingerprint: string | null;
  last_loaded_at: string;
  error: LoadError | null;
}

export interface LoadReport {
  loaded: WorkflowSummary[];
  errors: LoadError[];
  /** 目录级扫描失败时保留上次快照，但调用方不得把旧快照当成已确认的最新版本。 */
  scanFailed?: boolean;
}

interface FileStamp {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: number;
}

interface StableText {
  text: string;
  stamp: FileStamp;
}

function stampOf(s: { size: number; mtimeMs: number; ctimeMs: number; ino: number }): FileStamp {
  return { size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs, ino: s.ino };
}

function sameStamp(a: FileStamp | null, b: FileStamp | null): boolean {
  if (a === null || b === null) return a === b;
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.ino === b.ino;
}

async function optionalStamp(file: string): Promise<FileStamp | null> {
  try {
    return stampOf(await stat(file));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

async function readStableText(file: string): Promise<StableText> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = stampOf(await stat(file));
    const text = await readFile(file, "utf8");
    const after = stampOf(await stat(file));
    if (sameStamp(before, after)) return { text, stamp: after };
    await delay(20);
  }
  throw new WorkflowFormatError(file, "文件在读取期间持续变化，请等待写入完成后重试", "WORKFLOW_UNSTABLE");
}

function summaryOf(manifest: WorkflowManifest): WorkflowSummary {
  return {
    name: manifest.name,
    description: manifest.description,
    version: manifest.version,
    params: manifest.params.length
  };
}

/** 供 dry-run 使用的单一版本 ID；原始双指纹仍按既有格式存入 batch。 */
export function registeredWorkflowFingerprint(wf: RegisteredWorkflow): string {
  return contentFingerprint(wf.fingerprints);
}

/** manifest 与 API JSON 的交叉校验（防漂移，docs/002 §4.2） */
function crossValidate(manifest: WorkflowManifest, graph: WorkflowGraph, file: string): LoadError | null {
  for (const p of manifest.params) {
    const node = graph[p.node];
    if (!node) {
      return {
        file,
        code: "INVALID_MANIFEST_TARGET",
        node_id: p.node,
        input: p.input,
        message: `参数 "${p.name}" 引用的节点 "${p.node}" 在工作流图中不存在。图内节点: ${Object.keys(graph).join(", ")}`
      };
    }
    if (!(p.input in node.inputs)) {
      return {
        file,
        code: "INVALID_MANIFEST_TARGET",
        node_id: p.node,
        input: p.input,
        message: `参数 "${p.name}" 引用的输入 "${p.node}.inputs.${p.input}" 不存在。该节点可用输入: ${Object.keys(node.inputs).join(", ") || "<无>"}`
      };
    }
    const current = node.inputs[p.input];
    if (current !== undefined && current !== null && Array.isArray(current)) {
      return {
        file,
        code: "MANIFEST_TARGET_IS_LINK",
        node_id: p.node,
        input: p.input,
        message: `参数 "${p.name}" 指向的输入 "${p.node}.inputs.${p.input}" 是连线输入（数组），不可作为参数覆写目标`
      };
    }
    if (p.special === "seed" && typeof current !== "number" && typeof current !== "string") {
      return {
        file,
        code: "INCOMPATIBLE_MANIFEST_TYPE",
        node_id: p.node,
        input: p.input,
        message: `seed 参数 "${p.name}" 的当前值类型异常（${typeof current}），须为 number`
      };
    }
  }
  return null;
}

function manifestNameFromText(text: string): string | undefined {
  try {
    const value = JSON.parse(text) as unknown;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const name = (value as Record<string, unknown>)["name"];
      if (typeof name === "string" && /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name)) return name;
    }
  } catch {
    // 无效 JSON 没有可靠的新名称；调用方回退到该来源上一次已知名称。
  }
  return undefined;
}

function asLoadError(e: unknown, file: string): LoadError {
  if (e instanceof ManifestError) {
    return { file: e.file, code: "INVALID_MANIFEST", message: e.message.replace(/^manifest 错误 \[.*?\]: /, ""), issues: e.issues };
  }
  if (e instanceof WorkflowFormatError) {
    return {
      file: e.file,
      code: e.code,
      node_id: e.nodeId,
      input: e.input,
      message: e.message.replace(/^工作流格式错误 \[.*?\]: /, "")
    };
  }
  return { file, code: "WORKFLOW_READ_FAILED", message: `读取失败: ${e instanceof Error ? e.message : String(e)}` };
}

interface StablePair {
  manifest: WorkflowManifest;
  graph: WorkflowGraph;
  manifestStamp: FileStamp;
  graphStamp: FileStamp;
}

async function readStablePair(manifestPath: string, manifestRel: string): Promise<StablePair> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const stableManifest = await readStableText(manifestPath);
    const manifest = parseManifest(manifestRel, stableManifest.text);
    const graphPath = path.join(path.dirname(manifestPath), manifest.workflowFile);
    const stableGraph = await readStableText(graphPath);
    const graph = parseWorkflowGraph(manifest.workflowFile, stableGraph.text);
    const [manifestAfter, graphAfter] = await Promise.all([optionalStamp(manifestPath), optionalStamp(graphPath)]);
    if (sameStamp(stableManifest.stamp, manifestAfter) && sameStamp(stableGraph.stamp, graphAfter)) {
      return { manifest, graph, manifestStamp: stableManifest.stamp, graphStamp: stableGraph.stamp };
    }
    await delay(20);
  }
  throw new WorkflowFormatError(manifestRel, "manifest 与 workflow 在配对读取期间持续变化，请重试", "WORKFLOW_UNSTABLE");
}

export class WorkflowRegistry {
  private byName = new Map<string, RegisteredWorkflow>();
  private lastValidByName = new Map<string, RegisteredWorkflow>();
  private states = new Map<string, WorkflowState>();
  private sourceNames = new Map<string, string>();
  private graphByManifest = new Map<string, string>();
  private snapshot: string | null = null;
  private pairStamps = new Map<string, { manifest: FileStamp; graph: FileStamp }>();
  private currentReport: LoadReport = { loaded: [], errors: [] };
  private refreshing: Promise<LoadReport> | null = null;

  constructor(private readonly workflowsDir: string) {}

  /** 启动时强制完整加载；后续 list/run/dry-run 使用 refresh() 的元数据指纹检测。 */
  async load(): Promise<LoadReport> {
    return this.reload(true);
  }

  /** 文件未变化时只做目录项与 stat 对账，不重新读取或解析工作流。 */
  async refresh(): Promise<LoadReport> {
    return this.reload(false);
  }

  private reload(force: boolean): Promise<LoadReport> {
    if (this.refreshing) return this.refreshing;
    const pending = this.doRefresh(force);
    this.refreshing = pending;
    return pending.finally(() => {
      if (this.refreshing === pending) this.refreshing = null;
    });
  }

  private async doRefresh(force: boolean): Promise<LoadReport> {
    let manifestFiles: string[];
    let before: string;
    const previousGraphFiles = this.graphByManifest;
    try {
      manifestFiles = (await listManifestFiles(this.workflowsDir, "")).sort();
      before = await this.computeSnapshot(manifestFiles, previousGraphFiles);
      if (!force && this.snapshot !== null && before === this.snapshot) return this.currentReport;
    } catch (e) {
      const error = {
        file: this.workflowsDir,
        code: "WORKFLOW_SCAN_FAILED",
        message: `工作流目录不可读: ${e instanceof Error ? e.message : String(e)}。请设置 WORKFLOWS_DIR 并放入 *.manifest.json + API JSON`
      };
      this.currentReport = { loaded: this.currentReport.loaded, errors: [error], scanFailed: true };
      return this.currentReport;
    }

    const report = await this.fullScan(manifestFiles);
    try {
      const finalFiles = (await listManifestFiles(this.workflowsDir, "")).sort();
      const after = await this.computeSnapshot(finalFiles, this.graphByManifest);
      if (JSON.stringify(finalFiles) === JSON.stringify(manifestFiles)) {
        // 只记录实际读取并验证过的文件元数据；若配对发生变化，下一次必须重读。
        this.snapshot = after;
      } else {
        // 扫描后再次修改：当前 Map 不能冒充已确认的最新版本，下次调用必须重读。
        this.snapshot = null;
        report.scanFailed = true;
        report.errors.push({
          file: this.workflowsDir,
          code: "WORKFLOW_UNSTABLE",
          message: "工作流文件在扫描期间再次修改，本次版本未确认；不会执行可能过期的缓存版本"
        });
      }
    } catch (e) {
      this.snapshot = null;
      report.scanFailed = true;
      report.errors.push({
        file: this.workflowsDir,
        code: "WORKFLOW_SCAN_FAILED",
        message: `加载后无法确认工作流目录状态: ${e instanceof Error ? e.message : String(e)}`
      });
    }
    this.currentReport = report;
    return report;
  }

  private async computeSnapshot(manifestFiles: string[], graphFiles: Map<string, string>): Promise<string> {
    const entries: Array<[string, FileStamp | null | boolean]> = [];
    for (const rel of manifestFiles) {
      const manifestPath = path.join(this.workflowsDir, rel);
      const manifestStamp = await optionalStamp(manifestPath);
      entries.push([`m:${rel}`, manifestStamp]);
      const graphPath = graphFiles.get(manifestPath);
      const pair = this.pairStamps.get(manifestPath);
      if (graphPath) {
        const graphStamp = await optionalStamp(graphPath);
        entries.push([`g:${graphPath}`, graphStamp]);
        if (pair) entries.push([`p:${rel}`, sameStamp(pair.manifest, manifestStamp) && sameStamp(pair.graph, graphStamp)]);
      }
    }
    return JSON.stringify(entries);
  }

  private async fullScan(manifestFiles: string[]): Promise<LoadReport> {
    const report: LoadReport = { loaded: [], errors: [] };
    const nextByName = new Map<string, RegisteredWorkflow>();
    const nextLastValid = new Map(this.lastValidByName);
    const nextStates = new Map<string, WorkflowState>();
    for (const [name, state] of this.states) {
      if (state.status === "deleted") nextStates.set(name, state);
    }
    const nextSourceNames = new Map<string, string>();
    const nextGraphByManifest = new Map<string, string>();
    const nextPairStamps = new Map<string, { manifest: FileStamp; graph: FileStamp }>();
    const loadedAt = new Date().toISOString();

    if (manifestFiles.length === 0) {
      report.errors.push({ file: this.workflowsDir, code: "NO_WORKFLOWS", message: "未找到任何 *.manifest.json" });
    }

    for (const mf of manifestFiles) {
      const manifestPath = path.join(this.workflowsDir, mf);
      let manifest: WorkflowManifest | undefined;
      let manifestText = "";
      try {
        const stableManifest = await readStableText(manifestPath);
        manifestText = stableManifest.text;
        manifest = parseManifest(mf, manifestText);
        const candidateName = manifest.name;
        nextSourceNames.set(manifestPath, candidateName);
        const graphPath = path.join(path.dirname(manifestPath), manifest.workflowFile);
        nextGraphByManifest.set(manifestPath, graphPath);
        const pair = await readStablePair(manifestPath, mf);
        manifest = pair.manifest;
        const graph = pair.graph;
        nextSourceNames.set(manifestPath, manifest.name);
        nextGraphByManifest.set(manifestPath, path.join(path.dirname(manifestPath), manifest.workflowFile));
        nextPairStamps.set(manifestPath, { manifest: pair.manifestStamp, graph: pair.graphStamp });
        const xerr = crossValidate(manifest, graph, mf);
        if (xerr) throw new WorkflowFormatError(mf, xerr.message, xerr.code, xerr.node_id, xerr.input);
        if (nextByName.has(manifest.name)) {
          throw new WorkflowFormatError(mf, `工作流名 "${manifest.name}" 重复（已由先前的 manifest 注册）`, "DUPLICATE_WORKFLOW_NAME");
        }
        const fingerprints: WorkflowFingerprints = {
          manifestFingerprint: contentFingerprint(manifest),
          graphFingerprint: contentFingerprint(graph)
        };
        const registered: RegisteredWorkflow = { manifest, graph, sourceFile: manifestPath, fingerprints, loadedAt };
        nextByName.set(manifest.name, registered);
        nextLastValid.set(manifest.name, registered);
        nextStates.set(manifest.name, {
          name: manifest.name,
          status: "ready",
          sourceFile: mf,
          summary: summaryOf(manifest),
          error: null,
          loadedAt
        });
        report.loaded.push(summaryOf(manifest));
      } catch (e) {
        const error = asLoadError(e, mf);
        report.errors.push(error);
        const candidateName = manifest?.name ?? manifestNameFromText(manifestText) ?? this.sourceNames.get(manifestPath);
        if (candidateName) nextSourceNames.set(manifestPath, candidateName);
        if (manifest) nextGraphByManifest.set(manifestPath, path.join(path.dirname(manifestPath), manifest.workflowFile));
        if (candidateName && !nextByName.has(candidateName) && nextStates.get(candidateName)?.status !== "invalid") {
          const previous = nextLastValid.get(candidateName);
          nextStates.set(candidateName, {
            name: candidateName,
            status: "invalid",
            sourceFile: mf,
            summary: manifest
              ? summaryOf(manifest)
              : previous
                ? summaryOf(previous.manifest)
                : { name: candidateName, description: "", version: 0, params: 0 },
            error,
            loadedAt
          });
        }
      }
    }

    for (const [source, previousName] of this.sourceNames) {
      if (nextSourceNames.get(source) === previousName) continue;
      if (nextByName.has(previousName) || nextStates.has(previousName)) continue;
      const previous = nextLastValid.get(previousName);
      nextStates.set(previousName, {
        name: previousName,
        status: "deleted",
        sourceFile: path.relative(this.workflowsDir, source),
        summary: previous ? summaryOf(previous.manifest) : null,
        error: { file: path.relative(this.workflowsDir, source), code: "WORKFLOW_DELETED", message: "manifest 文件已删除" },
        loadedAt
      });
    }

    // 仅在本次扫描与逐文件验证全部结束后一次性替换，读取中的半成品不会修改旧 Map。
    this.byName = nextByName;
    this.lastValidByName = nextLastValid;
    this.states = nextStates;
    this.sourceNames = nextSourceNames;
    this.graphByManifest = nextGraphByManifest;
    this.pairStamps = nextPairStamps;
    return report;
  }

  /** 当前可执行版本。无效或已删除版本不会从这里返回。 */
  get(name: string): RegisteredWorkflow | undefined {
    return this.byName.get(name);
  }

  /** 最后有效版本仅供状态诊断与既有结果关联，不可用于新执行。 */
  getLastValid(name: string): RegisteredWorkflow | undefined {
    return this.lastValidByName.get(name);
  }

  statusOf(name: string): WorkflowState | undefined {
    return this.states.get(name);
  }

  report(): LoadReport {
    return this.currentReport;
  }

  /** 调度器纯内存门控：最近一次目录确认失败时禁止提交旧图。 */
  executionConfirmed(): boolean {
    return this.snapshot !== null && !this.currentReport.scanFailed;
  }

  list(): WorkflowListItem[] {
    return [...this.states.values()]
      .filter((state) => state.summary !== null)
      .map((state) => {
        const current = state.status === "ready" ? this.byName.get(state.name) : undefined;
        const summary = current ? summaryOf(current.manifest) : state.summary!;
        return {
          ...summary,
          status: state.status,
          workflow_fingerprint: current ? fingerprintShort(registeredWorkflowFingerprint(current)) : null,
          last_loaded_at: state.loadedAt,
          error: state.error
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** manifest 参数详情（list_workflows 指定名时）；仅当前有效版本可返回。 */
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
