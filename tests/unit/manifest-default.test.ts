import { describe, expect, it } from "vitest";
import { parseManifest, ManifestError } from "../../src/core/workflow/manifest.js";
import { validateParamDefault } from "../../src/core/workflow/manifest.js";
import type { ManifestParam } from "../../src/core/workflow/manifest.js";

/**
 * P4.1 §二.3 Manifest default 完整校验：
 * 类型正确 / min-max 满足 / step 对齐 / enum 合法 / seed 特殊规则。
 * 非法 manifest 必须整体拒绝注册（parseManifest 抛 ManifestError → LoadReport）。
 */

function param(over: Record<string, unknown>): ManifestParam {
  return { name: "p", node: "4", input: "text", type: "string", ...over } as ManifestParam;
}

function parseWith(p: Record<string, unknown>): { ok: true } | { ok: false; issues: string[] } {
  try {
    parseManifest(
      "t.manifest.json",
      JSON.stringify({
        name: "t",
        description: "d",
        version: 1,
        workflowFile: "t.json",
        params: [p]
      })
    );
    return { ok: true };
  } catch (e) {
    if (e instanceof ManifestError && e.issues) return { ok: false, issues: e.issues };
    return { ok: false, issues: [e instanceof Error ? e.message : String(e)] };
  }
}

describe("default 类型校验", () => {
  it("string 参数 default 非字符串 → 拒绝", () => {
    expect(parseWith(param({ type: "string", default: 123 })).ok).toBe(false);
    expect(validateParamDefault(param({ type: "string", default: 123 }))[0]).toContain("string");
  });
  it("boolean 参数 default 非布尔 → 拒绝", () => {
    expect(parseWith(param({ type: "boolean", default: "true" })).ok).toBe(false);
  });
  it("number 参数 default 非数字 → 拒绝", () => {
    expect(parseWith(param({ type: "number", default: "3" })).ok).toBe(false);
    expect(parseWith(param({ type: "number", default: null })).ok).toBe(false);
  });
  it("integer 参数 default 非整数 → 拒绝", () => {
    expect(parseWith(param({ type: "integer", default: 2.5 })).ok).toBe(false);
    expect(parseWith(param({ type: "integer", default: 7 })).ok).toBe(true);
  });
  it("类型正确的 default 正常通过", () => {
    expect(parseWith(param({ type: "string", default: "hi" })).ok).toBe(true);
    expect(parseWith(param({ type: "boolean", default: false })).ok).toBe(true);
    expect(parseWith(param({ type: "number", default: 1.5 })).ok).toBe(true);
  });
});

describe("default 数值约束校验", () => {
  it("default 低于 min → 拒绝", () => {
    const r = parseWith(param({ type: "integer", min: 1, max: 100, default: 0 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.join("")).toContain("低于 min");
  });
  it("default 超过 max → 拒绝", () => {
    const r = parseWith(param({ type: "integer", min: 1, max: 100, default: 101 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.join("")).toContain("超过 max");
  });
  it("default 恰在边界 → 通过", () => {
    expect(parseWith(param({ type: "integer", min: 1, max: 100, default: 1 })).ok).toBe(true);
    expect(parseWith(param({ type: "integer", min: 1, max: 100, default: 100 })).ok).toBe(true);
  });
  it("default 未对齐 step → 拒绝（相对 0）", () => {
    const r = parseWith(param({ type: "number", step: 0.5, default: 1.3 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.join("")).toContain("step");
  });
  it("step 对齐相对 min 而非 0：min=1, step=2, default=3 通过；default=2 拒绝", () => {
    expect(parseWith(param({ type: "integer", min: 1, step: 2, default: 3 })).ok).toBe(true);
    expect(parseWith(param({ type: "integer", min: 1, step: 2, default: 2 })).ok).toBe(false);
  });
  it("default 对齐 step → 通过", () => {
    expect(parseWith(param({ type: "number", step: 0.5, default: 2.5 })).ok).toBe(true);
    expect(parseWith(param({ type: "integer", step: 16, default: 512 })).ok).toBe(true);
  });
});

describe("default enum 校验", () => {
  it("enum default 不在合法值 → 拒绝", () => {
    const r = parseWith(param({ type: "enum", enum: ["euler", "ddim"], default: "euler_ancestral" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.join("")).toContain("enum");
  });
  it("enum default 在合法值 → 通过", () => {
    expect(parseWith(param({ type: "enum", enum: ["euler", "ddim"], default: "ddim" })).ok).toBe(true);
  });
});

describe("default seed 特殊规则", () => {
  const seed = (over: Record<string, unknown>) => param({ type: "integer", special: "seed", ...over });

  it("default=-1（每次随机哨兵）→ 通过（min≥0 也不受限）", () => {
    expect(parseWith(seed({ default: -1 })).ok).toBe(true);
    expect(parseWith(seed({ default: -1, min: 0, max: 4294967295 })).ok).toBe(true);
  });
  it("default 为 0–4294967295 整数 → 通过", () => {
    expect(parseWith(seed({ default: 0 })).ok).toBe(true);
    expect(parseWith(seed({ default: 4294967295 })).ok).toBe(true);
    expect(parseWith(seed({ default: 42, min: 0, max: 100 })).ok).toBe(true);
  });
  it("default 超出 seed 值域 → 拒绝（负数非 -1 / 超上限 / 非整数）", () => {
    expect(parseWith(seed({ default: -2 })).ok).toBe(false);
    expect(parseWith(seed({ default: 4294967296 })).ok).toBe(false);
    expect(parseWith(seed({ default: 2.5 })).ok).toBe(false);
  });
  it("seed default 声明显式 min 时越界 → 拒绝（非哨兵值须落在声明区间）", () => {
    expect(parseWith(seed({ default: 5, min: 10, max: 100 })).ok).toBe(false);
  });
});

describe("真实示例与注册联动", () => {
  it("示例 manifest（qwen-image-demo）的 default 全部通过校验", async () => {
    const { readFile } = await import("node:fs/promises");
    const text = await readFile("workflows/examples/qwen-image.manifest.json", "utf8");
    expect(() => parseManifest("qwen-image.manifest.json", text)).not.toThrow();
  });

  it("非法 default 的 manifest 经 registry 加载进 LoadReport（拒绝注册）", async () => {
    const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = (await import("node:path")).default;
    const { WorkflowRegistry } = await import("../../src/core/workflow/registry.js");
    const dir = await mkdtemp(path.join(tmpdir(), "wf-bad-default-"));
    try {
      const graph = JSON.stringify({ "4": { class_type: "TextEncode", inputs: { text: "tpl" } } });
      await writeFile(path.join(dir, "t.json"), graph);
      await writeFile(
        path.join(dir, "t.manifest.json"),
        JSON.stringify({
          name: "t",
          description: "d",
          version: 1,
          workflowFile: "t.json",
          params: [{ name: "p", node: "4", input: "text", type: "integer", min: 1, max: 10, default: 99 }]
        })
      );
      const reg = new WorkflowRegistry(dir);
      const report = await reg.load();
      expect(report.loaded).toHaveLength(0);
      expect(report.errors).toHaveLength(1);
      expect(report.errors[0]!.message).toContain("default(99)");
      expect(reg.get("t")).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
