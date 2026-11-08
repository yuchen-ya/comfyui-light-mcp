import { describe, expect, it } from "vitest";
import { applyParams, validateParams, ParamsValidationError } from "../../src/core/workflow/mapper.js";
import { parseManifest } from "../../src/core/workflow/manifest.js";
import type { WorkflowGraph } from "../../src/core/client/types.js";

const manifest = parseManifest(
  "t.manifest.json",
  JSON.stringify({
    name: "t",
    description: "d",
    version: 1,
    workflowFile: "t.json",
    params: [
      { name: "prompt", node: "4", input: "text", type: "string", required: true },
      { name: "steps", node: "7", input: "steps", type: "integer", min: 1, max: 100, default: 20 },
      { name: "cfg", node: "7", input: "cfg", type: "number", min: 1, max: 20, step: 0.5, default: 2.5 },
      { name: "seed", node: "7", input: "seed", type: "integer", default: -1, special: "seed" },
      { name: "model", node: "1", input: "ckpt", type: "enum", enum: ["a.safetensors", "b.safetensors"], default: "a.safetensors" },
      { name: "tiled", node: "8", input: "tiled", type: "boolean", default: false }
    ]
  })
);

const template: WorkflowGraph = {
  "1": { class_type: "Loader", inputs: { ckpt: "a.safetensors" } },
  "4": { class_type: "TextEncode", inputs: { text: "hi" } },
  "7": { class_type: "KSampler", inputs: { steps: 20, seed: 42, cfg: 7 } },
  "8": { class_type: "VAEDecode", inputs: { tiled: false } }
};
const templateSnapshot = JSON.parse(JSON.stringify(template)) as WorkflowGraph;

describe("参数校验器", () => {
  it("全部合法参数通过", () => {
    expect(() =>
      validateParams(manifest, { prompt: "a cat", steps: 30, cfg: 3.5, seed: 99, model: "b.safetensors", tiled: true })
    ).not.toThrow();
  });

  it("required 缺失报错并指名", () => {
    expect(() => validateParams(manifest, {})).toThrow(ParamsValidationError);
    try {
      validateParams(manifest, {});
      expect.unreachable();
    } catch (e) {
      const issues = (e as ParamsValidationError).issues;
      expect(issues.some((i) => i.param === "prompt")).toBe(true);
    }
  });

  it("类型不匹配报错（integer 传字符串 / number 传 NaN）", () => {
    expect(() => validateParams(manifest, { prompt: "x", steps: "30" })).toThrow(/Expected number/);
    expect(() => validateParams(manifest, { prompt: "x", steps: 1.5 })).toThrow(/Expected int/);
  });

  it("范围与步长：min/max/step（消息含实际值）", () => {
    expect(() => validateParams(manifest, { prompt: "x", steps: 0 })).toThrow(/须在 \[1, 100\] 区间（实际: 0）/);
    expect(() => validateParams(manifest, { prompt: "x", steps: 101 })).toThrow(/须在 \[1, 100\] 区间（实际: 101）/);
    expect(() => validateParams(manifest, { prompt: "x", cfg: 3.3 })).toThrow(/步长/);
    expect(() => validateParams(manifest, { prompt: "x", cfg: 3.5 })).not.toThrow();
  });

  it("enum 之外的值报错并给出合法清单", () => {
    expect(() => validateParams(manifest, { prompt: "x", model: "nope.safetensors" })).toThrow(/nope\.safetensors|enum/);
  });

  it("未知键被拒并列出全部合法参数名（白名单语义）", () => {
    try {
      validateParams(manifest, { prompt: "x", sampler_name: "euler" });
      expect.unreachable();
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("sampler_name");
      expect(msg).toContain("prompt, steps, cfg, seed, model, tiled");
    }
  });
});

describe("参数映射（applyParams）", () => {
  it("定点覆写且原始模板零修改", () => {
    const r = applyParams(template, manifest, { prompt: "a cat", steps: 30, model: "b.safetensors", tiled: true });
    expect(r.graph["4"]!.inputs["text"]).toBe("a cat");
    expect(r.graph["7"]!.inputs["steps"]).toBe(30);
    expect(r.graph["1"]!.inputs["ckpt"]).toBe("b.safetensors");
    expect(r.graph["8"]!.inputs["tiled"]).toBe(true);
    expect(template).toEqual(templateSnapshot); // 原模板不被污染
  });

  it("未提供的参数保留模板值", () => {
    const r = applyParams(template, manifest, { prompt: "x" });
    expect(r.graph["7"]!.inputs["cfg"]).toBe(7); // 模板原值
    expect(r.resolved["cfg"]).toBeUndefined();
  });

  it("seed：-1 → 随机并记录实际值；固定值原样", () => {
    const a = applyParams(template, manifest, { prompt: "x", seed: -1 });
    const b = applyParams(template, manifest, { prompt: "x", seed: -1 });
    expect(a.graph["7"]!.inputs["seed"]).toBe(a.resolved["seed"]);
    expect(a.resolved["seed"]).toBeGreaterThanOrEqual(0);
    expect(a.resolved["seed"]).toBeLessThanOrEqual(4294967295);
    expect(a.resolved["seed"]).not.toBe(b.resolved["seed"]); // 两次随机不同（概率上）
    const fixed = applyParams(template, manifest, { prompt: "x", seed: 12345 });
    expect(fixed.graph["7"]!.inputs["seed"]).toBe(12345);
    expect(fixed.resolved["seed"]).toBe(12345);
  });

  it("seed 未提供且 default=-1 → 仍随机（每 job 独立）", () => {
    const a = applyParams(template, manifest, { prompt: "x" });
    const b = applyParams(template, manifest, { prompt: "x" });
    expect(a.resolved["seed"]).not.toBe(b.resolved["seed"]);
  });

  it("返回的图是深拷贝（修改结果不影响模板）", () => {
    const r = applyParams(template, manifest, { prompt: "x" });
    (r.graph["7"]!.inputs as Record<string, unknown>)["steps"] = 999;
    expect(template["7"]!.inputs["steps"]).toBe(20);
  });
});
