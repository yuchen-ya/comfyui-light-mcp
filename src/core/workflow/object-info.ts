import type { ObjectInfoNode } from "../client/types.js";

/**
 * /object_info 缓存与规范化（Task 010）：
 * - ObjectInfoCache：TTL 缓存 + 并发去重 + 连接 epoch 失效 + 降级语义（live/cache/stale/unavailable）。
 *   绝不把 stale 当 live：刷新失败只能返回 source=stale 并带 warning；无任何数据返回 source=unavailable。
 * - normalizeObjectInfo / normalizeInputSpec：多形状兼容的输入规格规范化（docs/003 F8 combo 双形状等）。
 * - classifyModelInput：模型文件输入识别（ckpt/lora/vae/upscale/controlnet/unet/clip 等明确可识别项）。
 * 纯内存模块：自身不发请求（fetcher 注入）、不落盘、不依赖 DB。
 */

// ---------------------------------------------------------------------------
// 规格类型
// ---------------------------------------------------------------------------

export interface ComboSpec {
  kind: "combo";
  /** 合法值清单（可能为空 = 无法枚举，校验方按不可确认处理） */
  choices: string[];
  default?: string;
}

export interface IntSpec {
  kind: "int";
  default?: number;
  min?: number;
  max?: number;
  step?: number;
}

export interface FloatSpec {
  kind: "float";
  default?: number;
  min?: number;
  max?: number;
  step?: number;
}

export interface StringSpec {
  kind: "string";
  default?: string;
  multiline?: boolean;
}

export interface BooleanSpec {
  kind: "boolean";
  default?: boolean;
}

/** 连接引用类型：MODEL/CLIP/VAE/LATENT/CONDITIONING/IMAGE/自定义节点类型 */
export interface RefSpec {
  kind: "ref";
  type: string;
}

export interface UnknownSpec {
  kind: "unknown";
}

export type NormalizedInputSpec =
  | ComboSpec
  | IntSpec
  | FloatSpec
  | StringSpec
  | BooleanSpec
  | RefSpec
  | UnknownSpec;

export interface NormalizedNodeInfo {
  classType: string;
  required: Record<string, NormalizedInputSpec>;
  optional: Record<string, NormalizedInputSpec>;
  hidden: Record<string, NormalizedInputSpec>;
  /** 输出类型数组（如 ["MODEL","CLIP","VAE"]），供连线上界与类型检查 */
  outputs: string[];
  /** false = 原响应未提供 output 数组，索引上界不可确认 */
  outputsKnown?: boolean;
  /** /object_info 的 output_node 标志（SaveImage 等为 true） */
  outputNode: boolean;
  /** input 段结构异常无法解析：preflight 须按“schema 不可确认”处理而非当作空规格 */
  malformed?: boolean;
}

// ---------------------------------------------------------------------------
// 形状兼容解析
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function toFiniteNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** 数组 → 过滤出的字符串值（保留空数组：空清单意味着“无法枚举/未安装”） */
function toStringChoices(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((c): c is string => typeof c === "string");
}

/**
 * 从 options 对象提取 combo 值清单（兼容键位）：
 * options.choices / choices / combo.choices / combo.options。
 * 返回 undefined 表示未发现任何清单键。
 */
function extractChoices(opts: Record<string, unknown>): string[] | undefined {
  const candidates: unknown[] = [];
  const options = opts["options"];
  if (Array.isArray(options)) candidates.push(options);
  if (isPlainObject(options)) candidates.push(options["choices"]);
  candidates.push(opts["choices"]);
  const combo = opts["combo"];
  if (isPlainObject(combo)) {
    candidates.push(combo["choices"], combo["options"]);
  }
  for (const c of candidates) {
    if (Array.isArray(c)) return toStringChoices(c);
  }
  return undefined;
}

function numericSpec(kind: "int" | "float", opts: Record<string, unknown>): IntSpec | FloatSpec {
  const spec: IntSpec | FloatSpec = { kind };
  const d = toFiniteNumber(opts["default"]);
  if (d !== undefined) spec.default = d;
  const min = toFiniteNumber(opts["min"]);
  if (min !== undefined) spec.min = min;
  const max = toFiniteNumber(opts["max"]);
  if (max !== undefined) spec.max = max;
  const step = toFiniteNumber(opts["step"]);
  if (step !== undefined) spec.step = step;
  return spec;
}

/** 已知类型名 → 规格；COMBO 无清单降为空 choices combo（区别于 ref 引用类型） */
function specFromTypeName(typeName: string, opts: Record<string, unknown>): NormalizedInputSpec {
  switch (typeName.toUpperCase()) {
    case "INT":
      return numericSpec("int", opts);
    case "FLOAT":
      return numericSpec("float", opts);
    case "STRING": {
      const spec: StringSpec = { kind: "string" };
      if (typeof opts["default"] === "string") spec.default = opts["default"];
      if (opts["multiline"] === true) spec.multiline = true;
      return spec;
    }
    case "BOOLEAN": {
      const spec: BooleanSpec = { kind: "boolean" };
      if (typeof opts["default"] === "boolean") spec.default = opts["default"];
      return spec;
    }
    case "COMBO":
      return { kind: "combo", choices: [] };
    default:
      return { kind: "ref", type: typeName };
  }
}

/**
 * 单个输入规格规范化，兼容形状：
 * - 旧 combo：["COMBO" | 类型名, [值...]]（docs/003 F8 旧版）
 * - 0.41 combo：[[值...], {tooltip/options}]（值在 spec[0]）
 * - COMBO + options/choices：["COMBO", {options:{choices:[...]}} | {choices:[...]} | {combo:{...}}]
 * - 对象形状：{type:"COMBO", options:{choices:[...]}} / {type:"combo", choices:[...]}
 * - 普通类型：["INT"/"FLOAT"/"STRING"/"BOOLEAN", {default,min,max,step,...}]、对象形状同
 * - 自定义引用类型：["MODEL"] / ["MODEL", {tooltip}] / {type:"MODEL"}
 * 无法解析 → {kind:"unknown"}（调用方按不可确认处理，不得视为通过）。
 */
export function normalizeInputSpec(spec: unknown): NormalizedInputSpec {
  if (Array.isArray(spec)) {
    const first = spec[0];
    if (Array.isArray(first)) {
      // 0.41 新形状：[值数组, 配置对象]
      const out: ComboSpec = { kind: "combo", choices: toStringChoices(first) };
      const opts = spec[1];
      if (isPlainObject(opts) && typeof opts["default"] === "string") out.default = opts["default"];
      return out;
    }
    if (typeof first === "string") {
      const second = spec[1];
      if (Array.isArray(second)) {
        // 旧形状：[类型名, 值数组]
        return { kind: "combo", choices: toStringChoices(second) };
      }
      const opts = isPlainObject(second) ? second : {};
      const choices = extractChoices(opts);
      if (choices !== undefined) return { kind: "combo", choices };
      return specFromTypeName(first, opts);
    }
    return { kind: "unknown" };
  }
  if (isPlainObject(spec)) {
    const choices = extractChoices(spec);
    if (choices !== undefined) return { kind: "combo", choices };
    const t = spec["type"];
    if (typeof t === "string") return specFromTypeName(t, spec);
    return { kind: "unknown" };
  }
  return { kind: "unknown" };
}

function normalizeInputSection(section: unknown): { specs: Record<string, NormalizedInputSpec>; malformed: boolean } {
  if (section === undefined) return { specs: {}, malformed: false };
  if (!isPlainObject(section)) return { specs: {}, malformed: true };
  const specs: Record<string, NormalizedInputSpec> = {};
  for (const [key, v] of Object.entries(section)) specs[key] = normalizeInputSpec(v);
  return { specs, malformed: false };
}

/** 整份 /object_info → 规范化节点表（key = class_type） */
export function normalizeObjectInfo(raw: Record<string, ObjectInfoNode>): Record<string, NormalizedNodeInfo> {
  const out: Record<string, NormalizedNodeInfo> = {};
  for (const [classType, node] of Object.entries(raw)) {
    if (!isPlainObject(node)) {
      out[classType] = { classType, required: {}, optional: {}, hidden: {}, outputs: [], outputsKnown: false, outputNode: false, malformed: true };
      continue;
    }
    const input = node["input"];
    let required: Record<string, NormalizedInputSpec> = {};
    let optional: Record<string, NormalizedInputSpec> = {};
    let hidden: Record<string, NormalizedInputSpec> = {};
    let malformed = false;
    if (isPlainObject(input)) {
      const req = normalizeInputSection(input["required"]);
      const opt = normalizeInputSection(input["optional"]);
      const hid = normalizeInputSection(input["hidden"]);
      required = req.specs;
      optional = opt.specs;
      hidden = hid.specs;
      malformed = req.malformed || opt.malformed || hid.malformed;
    } else if (input !== undefined) {
      malformed = true;
    }
    const outputsKnown = Array.isArray(node["output"]) && node["output"].every((o) => typeof o === "string");
    const outputs = outputsKnown ? node["output"] as string[] : [];
    const info: NormalizedNodeInfo = {
      classType,
      required,
      optional,
      hidden,
      outputs,
      outputsKnown,
      outputNode: node["output_node"] === true
    };
    if (malformed) info.malformed = true;
    out[classType] = info;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 模型输入识别
// ---------------------------------------------------------------------------

export type ModelInputKind = "ckpt" | "lora" | "vae" | "upscale" | "controlnet" | "unet" | "clip" | "clip_vision" | "style_model" | "gligen" | "hypernetwork";

interface ModelInputRule {
  kind: ModelInputKind;
  param: RegExp;
  /** 需要类名佐证的规则（如 model_name 只在 Upscale*Loader 上认定） */
  classType?: RegExp;
}

/** ComfyUI 核心 Loader 的约定参数名——只认定明确可识别项，其余返回 null */
const MODEL_INPUT_RULES: readonly ModelInputRule[] = [
  { kind: "ckpt", param: /^ckpt_name$/i },
  { kind: "lora", param: /^lora_name$/i },
  { kind: "vae", param: /^vae_name$/i },
  { kind: "controlnet", param: /^control_?net_?name$/i },
  { kind: "unet", param: /^unet_name$/i },
  { kind: "clip", param: /^clip_name[1-4]?$/i },
  { kind: "clip_vision", param: /^clip_vision_name$/i },
  { kind: "style_model", param: /^style_model_name$/i },
  { kind: "gligen", param: /^gligen_name$/i },
  { kind: "hypernetwork", param: /^hypernetwork_name$/i },
  { kind: "upscale", param: /^(upscale_name|model_name)$/i, classType: /upscale/i }
];

/** 识别模型文件输入；非明确可识别返回 null（调用方不得臆测） */
export function classifyModelInput(classType: string, paramName: string): ModelInputKind | null {
  for (const rule of MODEL_INPUT_RULES) {
    if (!rule.param.test(paramName)) continue;
    if (rule.classType && !rule.classType.test(classType)) continue;
    return rule.kind;
  }
  return null;
}

// ---------------------------------------------------------------------------
// TTL 缓存
// ---------------------------------------------------------------------------

export const DEFAULT_OBJECT_INFO_TTL_MS = 5 * 60_000;

/**
 * - live：本次请求真实拉取成功
 * - cache：未过期缓存直接命中（含 epoch 未变化）
 * - stale：刷新失败但有旧数据（必带 warning；绝不能当 live 使用）
 * - unavailable：无任何数据（必带 error）
 */
export type ObjectInfoSource = "live" | "cache" | "stale" | "unavailable";

export interface ObjectInfoSnapshot {
  source: ObjectInfoSource;
  /** 规范化节点表（unavailable 时为 null） */
  nodes: Record<string, NormalizedNodeInfo> | null;
  /** 原始 /object_info JSON（unavailable 时为 null） */
  raw: Record<string, ObjectInfoNode> | null;
  fetchedAt: number;
  epoch: number;
  /** source=stale 必带：降级原因 */
  warning?: string;
  /** source=unavailable 必带：失败原因 */
  error?: string;
}

export interface ObjectInfoCacheOptions {
  /** 执行 GET /object_info（如 () => http.objectInfo()）；由调用方注入，本模块不发请求 */
  fetcher: () => Promise<Record<string, ObjectInfoNode>>;
  /** 缓存 TTL，默认 5 分钟 */
  ttlMs?: number;
  /** 时钟注入（测试用），默认 Date.now */
  now?: () => number;
  /** 连接 epoch 提供者（如 () => ws.getStats().reconnects）；变化即失效，默认恒 0 */
  epoch?: () => number;
}

interface CacheEntry {
  raw: Record<string, ObjectInfoNode>;
  nodes: Record<string, NormalizedNodeInfo>;
  fetchedAt: number;
  epoch: number;
}

export class ObjectInfoCache {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly getEpoch: () => number;
  private entry: CacheEntry | null = null;
  /** 并发去重：进行中的刷新 promise（settle 后清空） */
  private inflight: Promise<ObjectInfoSnapshot> | null = null;

  constructor(private readonly opts: ObjectInfoCacheOptions) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_OBJECT_INFO_TTL_MS;
    this.now = opts.now ?? Date.now;
    this.getEpoch = opts.epoch ?? (() => 0);
  }

  /**
   * 获取 /object_info 快照（永不抛异常：失败以 source=stale/unavailable 表达）。
   * - 未过期且 epoch 未变 → source=cache（不请求）
   * - 过期/epoch 变化/force → 刷新；成功 source=live，失败按旧数据降级
   * - 并发调用共享同一次在途请求
   */
  async get(opts?: { force?: boolean }): Promise<ObjectInfoSnapshot> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const epoch = this.getEpoch();
      if (!opts?.force && this.entry && this.isFresh(this.entry, this.now(), epoch)) {
        return this.snapshotFrom(this.entry, "cache");
      }
      if (!this.inflight) this.inflight = this.refresh(epoch);
      const snapshot = await this.inflight;
      // 旧连接上的在途请求不能成为新连接 epoch 的 live 验证结果。
      if (snapshot.source !== "live" || snapshot.epoch === this.getEpoch()) return snapshot;
    }
    // 重连风暴必须有界：返回明确 stale/unavailable，绝不递归制造 GET 风暴。
    if (this.entry) {
      return {
        ...this.snapshotFrom(this.entry, "stale"),
        warning: "object_info 获取期间连接 epoch 持续变化，本次结果不是当前连接的实时验证"
      };
    }
    return {
      source: "unavailable",
      nodes: null,
      raw: null,
      fetchedAt: 0,
      epoch: this.getEpoch(),
      error: "object_info 获取期间连接 epoch 持续变化，无法确认当前节点定义"
    };
  }

  /** 只读窥视：返回当前缓存快照而不触发任何请求；无缓存返回 null。过期数据标记为 stale（带 warning）。 */
  peek(): ObjectInfoSnapshot | null {
    const e = this.entry;
    if (!e) return null;
    if (this.isFresh(e, this.now(), this.getEpoch())) return this.snapshotFrom(e, "cache");
    return {
      ...this.snapshotFrom(e, "stale"),
      warning: "object_info 缓存已过期或 epoch 已变化且尚未刷新（peek 不触发请求）"
    };
  }

  /** 丢弃缓存（下次 get 重新请求；进行中的请求不受影响） */
  invalidate(): void {
    this.entry = null;
  }

  private isFresh(e: CacheEntry, now: number, epoch: number): boolean {
    return now - e.fetchedAt < this.ttlMs && e.epoch === epoch;
  }

  private async refresh(epoch: number): Promise<ObjectInfoSnapshot> {
    try {
      const raw = await this.opts.fetcher();
      const entry: CacheEntry = { raw, nodes: normalizeObjectInfo(raw), fetchedAt: this.now(), epoch };
      this.entry = entry;
      return this.snapshotFrom(entry, "live");
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      const old = this.entry;
      if (old) {
        // 有旧数据：降级返回，明确标记 stale（绝不当 live）
        return {
          ...this.snapshotFrom(old, "stale"),
          warning: `object_info 刷新失败，返回过期缓存（fetchedAt=${old.fetchedAt}, epoch=${old.epoch}）: ${reason}`
        };
      }
      return { source: "unavailable", nodes: null, raw: null, fetchedAt: 0, epoch, error: reason };
    } finally {
      this.inflight = null;
    }
  }

  private snapshotFrom(e: CacheEntry, source: ObjectInfoSource): ObjectInfoSnapshot {
    return { source, nodes: e.nodes, raw: e.raw, fetchedAt: e.fetchedAt, epoch: e.epoch };
  }
}
