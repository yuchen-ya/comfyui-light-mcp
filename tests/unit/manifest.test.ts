import { describe, expect, it } from "vitest";
import { parseManifest } from "../../src/core/workflow/manifest.js";
import { loadWorkflowGraph, WorkflowFormatError } from "../../src/core/workflow/loader.js";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const VALID_MANIFEST = {
  name: "demo",
  description: "测试工作流",
  version: 1,
  workflowFile: "demo.json",
  params: [
    { name: "prompt", node: "4", input: "text", type: "string", required: true },
    { name: "steps", node: "7", input: "steps", type: "integer", min: 1, max: 100, default: 20 },
    { name: "seed", node: "7", input: "seed", type: "integer", default: -1, special: "seed" },
    { name: "model", node: "1", input: "ckpt", type: "enum", enum: ["a.safetensors", "b.safetensors"] },
    { name: "cfg", node: "7", input: "cfg", type: "number", min: 1, max: 20, step: 0.5, default: 2.5 },
    { name: "tiled", node: "8", input: "tiled", type: "boolean", default: false }
  ]
};

const VALID_GRAPH = {
  "1": { class_type: "Loader", inputs: { ckpt: "a.safetensors" } },
  "4": { class_type: "TextEncode", inputs: { text: "hi" } },
  "7": { class_type: "KSampler", inputs: { steps: 20, seed: 42, cfg: 7 } },
  "8": { class_type: "VAEDecode", inputs: { tiled: false, vae: ["1", 0] } }
};

describe("manifest 解析", () => {
  it("合法 manifest 通过并保留全部字段", () => {
    const m = parseManifest("demo.manifest.json", JSON.stringify(VALID_MANIFEST));
    expect(m.name).toBe("demo");
    expect(m.params).toHaveLength(6);
    expect(m.params[5]!.default).toBe(false);
  });

  it("非法 JSON / 非 JSON 结构报 ManifestError", () => {
    expect(() => parseManifest("a.json", "not json")).toThrow(/不是合法 JSON/);
    expect(() => parseManifest("a.json", "[1,2]")).toThrow();
  });

  it("未知顶层字段被拒（strict）", () => {
    const bad = { ...VALID_MANIFEST, extra: 1 };
    expect(() => parseManifest("a.json", JSON.stringify(bad))).toThrow(/schema 校验失败/);
  });

  it("enum 缺失 / enum 用于非 enum 类型被拒", () => {
    const noEnum = { ...VALID_MANIFEST, params: [{ name: "m", node: "1", input: "ckpt", type: "enum" }] };
    expect(() => parseManifest("a.json", JSON.stringify(noEnum))).toThrow(/enum 必须提供非空/);
    const misUse = { ...VALID_MANIFEST, params: [{ name: "m", node: "1", input: "ckpt", type: "string", enum: ["x"] }] };
    expect(() => parseManifest("a.json", JSON.stringify(misUse))).toThrow(/enum 仅允许 type=enum/);
  });

  it("min>max / 数值约束用于非数值类型被拒", () => {
    const badRange = { ...VALID_MANIFEST, params: [{ name: "s", node: "7", input: "steps", type: "integer", min: 10, max: 5 }] };
    expect(() => parseManifest("a.json", JSON.stringify(badRange))).toThrow(/min\(10\) 不能大于 max\(5\)/);
    const strRange = { ...VALID_MANIFEST, params: [{ name: "p", node: "4", input: "text", type: "string", min: 1 }] };
    expect(() => parseManifest("a.json", JSON.stringify(strRange))).toThrow(/min\/max\/step 仅允许/);
  });

  it("seed 特殊语义要求 integer；required 与 default 互斥", () => {
    const badSeed = { ...VALID_MANIFEST, params: [{ name: "seed", node: "7", input: "seed", type: "string", special: "seed" }] };
    expect(() => parseManifest("a.json", JSON.stringify(badSeed))).toThrow(/seed 要求 type=integer/);
    const both = { ...VALID_MANIFEST, params: [{ name: "p", node: "4", input: "text", type: "string", required: true, default: "x" }] };
    expect(() => parseManifest("a.json", JSON.stringify(both))).toThrow(/required 参数不应再提供 default/);
  });

  it("参数名与 workflowFile 约束", () => {
    const badName = { ...VALID_MANIFEST, name: "1abc" };
    expect(() => parseManifest("a.json", JSON.stringify(badName))).toThrow();
    const pathy = { ...VALID_MANIFEST, workflowFile: "../escape.json" };
    expect(() => parseManifest("a.json", JSON.stringify(pathy))).toThrow(/不含路径分隔符/);
    const dup = { ...VALID_MANIFEST, params: [VALID_MANIFEST.params[0], VALID_MANIFEST.params[0]] };
    expect(() => parseManifest("a.json", JSON.stringify(dup))).toThrow(/参数名重复/);
  });
});

describe("default 完整校验（Task 005 §二.3）", () => {
  function withParam(p: Record<string, unknown>) {
    return JSON.stringify({ ...VALID_MANIFEST, params: [p] });
  }

  it("合法 default 全类型通过（string/number/integer/boolean/enum/seed）", () => {
    expect(() => parseManifest("a.json", JSON.stringify(VALID_MANIFEST))).not.toThrow();
  });

  it("类型错误被拒：string 传 number / boolean 传 string / integer 传小数与字符串", () => {
    expect(() => parseManifest("a.json", withParam({ name: "p", node: "4", input: "text", type: "string", default: 42 })))
      .toThrow(/default 非法.*期望 string/);
    expect(() => parseManifest("a.json", withParam({ name: "p", node: "8", input: "tiled", type: "boolean", default: "yes" })))
      .toThrow(/default 非法.*期望 boolean/);
    expect(() => parseManifest("a.json", withParam({ name: "p", node: "7", input: "steps", type: "integer", default: 1.5 })))
      .toThrow(/default 非法.*期望 integer/);
    expect(() => parseManifest("a.json", withParam({ name: "p", node: "7", input: "steps", type: "integer", default: "20" })))
      .toThrow(/default 非法/);
  });

  it("min/max 违反被拒（低于 min / 超过 max）", () => {
    expect(() => parseManifest("a.json", withParam({ name: "p", node: "7", input: "steps", type: "integer", min: 1, max: 100, default: 0 })))
      .toThrow(/default\(0\) 低于 min\(1\)/);
    expect(() => parseManifest("a.json", withParam({ name: "p", node: "7", input: "steps", type: "integer", min: 1, max: 100, default: 101 })))
      .toThrow(/default\(101\) 超过 max\(100\)/);
  });

  it("step 未对齐被拒（对齐示例通过）", () => {
    expect(() => parseManifest("a.json", withParam({ name: "p", node: "7", input: "cfg", type: "number", min: 1, step: 0.5, default: 1.3 })))
      .toThrow(/未对齐 step=0.5/);
    expect(() => parseManifest("a.json", withParam({ name: "p", node: "7", input: "cfg", type: "number", min: 1, step: 0.5, default: 1.5 })))
      .not.toThrow();
  });

  it("enum default 必须在合法值中", () => {
    expect(() => parseManifest("a.json", withParam({ name: "p", node: "1", input: "ckpt", type: "enum", enum: ["a", "b"], default: "c" })))
      .toThrow(/default 非法.*enum 之一: a, b/);
    expect(() => parseManifest("a.json", withParam({ name: "p", node: "1", input: "ckpt", type: "enum", enum: ["a", "b"], default: "a" })))
      .not.toThrow();
  });

  it("seed 特殊规则：-1（随机）与 0–2^32-1 合法；越界/非整数被拒", () => {
    expect(() => parseManifest("a.json", withParam({ name: "s", node: "7", input: "seed", type: "integer", special: "seed", default: -1 })))
      .not.toThrow();
    expect(() => parseManifest("a.json", withParam({ name: "s", node: "7", input: "seed", type: "integer", special: "seed", default: 4294967295 })))
      .not.toThrow();
    expect(() => parseManifest("a.json", withParam({ name: "s", node: "7", input: "seed", type: "integer", special: "seed", default: -2 })))
      .toThrow(/seed default/);
    expect(() => parseManifest("a.json", withParam({ name: "s", node: "7", input: "seed", type: "integer", special: "seed", default: 4294967296 })))
      .toThrow(/seed default/);
    expect(() => parseManifest("a.json", withParam({ name: "s", node: "7", input: "seed", type: "integer", special: "seed", default: 1.5 })))
      .toThrow(/default 非法.*integer/);
  });

  it("非法 default 的 manifest 经 registry.load 落入 LoadReport 而非抛出", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "wf-def-"));
    await writeFile(path.join(dir, "demo.json"), JSON.stringify(VALID_GRAPH));
    await writeFile(
      path.join(dir, "bad.manifest.json"),
      JSON.stringify({ ...VALID_MANIFEST, params: [{ name: "steps", node: "7", input: "steps", type: "integer", min: 1, max: 100, default: 999 }] })
    );
    const { WorkflowRegistry } = await import("../../src/core/workflow/registry.js");
    const reg = new WorkflowRegistry(dir);
    const report = await reg.load();
    expect(report.loaded).toEqual([]);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]!.message).toMatch(/default\(999\) 超过 max\(100\)/);
    expect(reg.get("demo")).toBeUndefined(); // 未注册
  });
});

describe("workflow loader", () => {
  it("API 格式通过并规范化", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "wf-"));
    await writeFile(path.join(dir, "demo.json"), JSON.stringify(VALID_GRAPH));
    const g = await loadWorkflowGraph("demo.json", dir);
    expect(Object.keys(g)).toHaveLength(4);
    expect(g["7"]!.class_type).toBe("KSampler");
  });

  it("UI 格式（nodes/links）被拒绝并给出修正指引", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "wf-"));
    await writeFile(path.join(dir, "ui.json"), JSON.stringify({ nodes: [], links: [], last_node_id: 1 }));
    await expect(loadWorkflowGraph("ui.json", dir)).rejects.toThrow(WorkflowFormatError);
    await expect(loadWorkflowGraph("ui.json", dir)).rejects.toThrow(/API 格式/);
  });

  it("缺失文件 / 缺 class_type 的伪 API 图被拒", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "wf-"));
    await expect(loadWorkflowGraph("missing.json", dir)).rejects.toThrow(/读取失败/);
    await writeFile(path.join(dir, "bad.json"), JSON.stringify({ "1": { inputs: {} } }));
    await expect(loadWorkflowGraph("bad.json", dir)).rejects.toThrow(/class_type/);
  });
});
