import { describe, expect, it } from "vitest";
import { preflightWorkflow, MAX_PREFLIGHT_ISSUES } from "../../src/core/workflow/preflight.js";
import { normalizeObjectInfo } from "../../src/core/workflow/object-info.js";
import { parseManifest } from "../../src/core/workflow/manifest.js";
import type { WorkflowManifest } from "../../src/core/workflow/manifest.js";
import type { WorkflowGraph } from "../../src/core/client/types.js";
import type { ObjectInfoNode } from "../../src/core/client/types.js";

/**
 * Task 010：preflight 纯只读静态检查。
 * 覆盖：合法图 / 未知节点 / 未知输入 / 坏连线 / 非法 output index / 缺 required /
 * 非法 combo / 模型 found-missing-unknown / manifest target·类型·default / 输出节点 /
 * schema 不可用降级 / run index / 截断。
 */

// ---------------------------------------------------------------------------
// 测试数据：schema（混合 0.41 combo、旧 combo、普通类型、引用类型）
// ---------------------------------------------------------------------------

const RAW_SCHEMA: Record<string, ObjectInfoNode> = {
  CheckpointLoaderSimple: {
    input: { required: { ckpt_name: [["qwen-image-2.1.safetensors", "sdxl-base.safetensors"], {}] } },
    output: ["MODEL", "CLIP", "VAE"],
    output_node: false
  },
  CLIPTextEncode: {
    input: {
      required: { text: ["STRING", { multiline: true }], clip: ["CLIP"] },
      optional: { noise_seed: ["INT", { default: 0, min: 0, max: 4294967295 }] }
    },
    output: ["CONDITIONING"],
    output_node: false
  },
  EmptyLatentImage: {
    input: {
      required: {
        width: ["INT", { default: 512, min: 16, max: 16384 }],
        height: ["INT", { default: 512, min: 16, max: 16384 }],
        batch_size: ["INT", { default: 1, min: 1, max: 64 }]
      }
    },
    output: ["LATENT"],
    output_node: false
  },
  KSampler: {
    input: {
      required: {
        seed: ["INT", { default: 0, min: 0, max: 4294967295 }],
        steps: ["INT", { default: 20, min: 1, max: 10000 }],
        cfg: ["FLOAT", { default: 8, min: 0, max: 100, step: 0.1 }],
        sampler_name: [["euler", "euler_ancestral", "dpmpp_2m"], {}],
        scheduler: [["karras", "normal", "sgm_uniform"], {}],
        denoise: ["FLOAT", { default: 1, min: 0, max: 1, step: 0.01 }],
        model: ["MODEL"],
        positive: ["CONDITIONING"],
        negative: ["CONDITIONING"],
        latent_image: ["LATENT"]
      }
    },
    output: ["LATENT"],
    output_node: false
  },
  VAEDecode: {
    input: { required: { samples: ["LATENT"], vae: ["VAE"] } },
    output: ["IMAGE"],
    output_node: false
  },
  SaveImage: {
    input: { required: { images: ["IMAGE"], filename_prefix: ["STRING", { default: "ComfyUI" }] } },
    output: [],
    output_node: true
  }
};

const SCHEMA = normalizeObjectInfo(RAW_SCHEMA);

// 合法图：Checkpoint → 双 CLIPTextEncode → EmptyLatent → KSampler → VAEDecode → SaveImage
const VALID_GRAPH: WorkflowGraph = {
  "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "qwen-image-2.1.safetensors" } },
  "2": { class_type: "CLIPTextEncode", inputs: { text: "a cute cat", clip: ["1", 1], noise_seed: 7 } },
  "3": { class_type: "CLIPTextEncode", inputs: { text: "", clip: ["1", 1] } },
  "4": { class_type: "EmptyLatentImage", inputs: { width: 1024, height: 1024, batch_size: 1 } },
  "5": {
    class_type: "KSampler",
    inputs: {
      seed: 42,
      steps: 20,
      cfg: 7,
      sampler_name: "euler",
      scheduler: "karras",
      denoise: 1,
      model: ["1", 0],
      positive: ["2", 0],
      negative: ["3", 0],
      latent_image: ["4", 0]
    }
  },
  "6": { class_type: "VAEDecode", inputs: { samples: ["5", 0], vae: ["1", 2] } },
  "7": { class_type: "SaveImage", inputs: { images: ["6", 0], filename_prefix: "ComfyUI" } }
};

function mf(params: Array<Record<string, unknown>>): WorkflowManifest {
  return parseManifest(
    "t.manifest.json",
    JSON.stringify({ name: "t", description: "d", version: 1, workflowFile: "t.json", params })
  );
}

const VALID_MANIFEST = mf([
  { name: "steps", node: "5", input: "steps", type: "integer", min: 1, max: 100 },
  { name: "prompt", node: "2", input: "text", type: "string" },
  { name: "seed", node: "5", input: "seed", type: "integer", special: "seed" },
  { name: "sampler", node: "5", input: "sampler_name", type: "enum", enum: ["euler", "dpmpp_2m"] }
]);

function clone<T>(v: T): T {
  return structuredClone(v);
}

function codes(r: { issues: Array<{ code: string }> }): string[] {
  return r.issues.map((i) => i.code);
}

// ---------------------------------------------------------------------------
// 合法图与整体状态
// ---------------------------------------------------------------------------

describe("preflight 合法图", () => {
  it("完整合法图 + schema → passed，无 issue，模型 found=1", () => {
    const r = preflightWorkflow({ graph: VALID_GRAPH, manifest: VALID_MANIFEST, objectInfo: SCHEMA });
    expect(r.status).toBe("passed");
    expect(r.issues).toEqual([]);
    expect(r.truncated).toBe(false);
    expect(r.schemaAvailable).toBe(true);
    expect(r.models).toEqual({ found: 1, missing: 0, unknown: 0 });
  });

  it("合法图但无 object_info → warning（schema_unavailable），绝不 passed", () => {
    const r = preflightWorkflow({ graph: VALID_GRAPH, manifest: VALID_MANIFEST });
    expect(r.status).toBe("warning");
    expect(r.schemaAvailable).toBe(false);
    expect(codes(r)).toContain("schema_unavailable");
    // 模型无法确认 → unknown 计数（不臆测 found/missing）
    expect(r.models).toEqual({ found: 0, missing: 0, unknown: 1 });
  });

  it("objectInfo 传空对象等同不可用", () => {
    const r = preflightWorkflow({ graph: VALID_GRAPH, manifest: VALID_MANIFEST, objectInfo: {} });
    expect(r.schemaAvailable).toBe(false);
    expect(r.status).toBe("warning");
  });

  it("runIndex 附加到每个 issue", () => {
    const graph = clone(VALID_GRAPH);
    delete graph["5"]!.inputs["steps"];
    const r = preflightWorkflow({ graph, manifest: VALID_MANIFEST, objectInfo: SCHEMA, runIndex: 2 });
    expect(r.issues.length).toBeGreaterThan(0);
    for (const issue of r.issues) expect(issue.run).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 结构检查（无 schema 也执行）
// ---------------------------------------------------------------------------

describe("preflight 结构检查", () => {
  it("非法节点 id → invalid_node_id", () => {
    const graph = clone(VALID_GRAPH);
    graph["bad node!"] = { class_type: "SaveImage", inputs: { images: ["6", 0] } };
    const r = preflightWorkflow({ graph, manifest: VALID_MANIFEST, objectInfo: SCHEMA });
    expect(r.status).toBe("failed");
    const hit = r.issues.find((i) => i.code === "invalid_node_id");
    expect(hit?.node_id).toBe("bad node!");
  });

  it("class_type/inputs 结构非法 → invalid_node", () => {
    const graph = clone(VALID_GRAPH);
    graph["8"] = { class_type: "", inputs: {} };
    const r = preflightWorkflow({ graph, manifest: VALID_MANIFEST, objectInfo: SCHEMA });
    expect(codes(r)).toContain("invalid_node");
  });

  it("连线引用不存在节点 → unknown_node_ref", () => {
    const graph = clone(VALID_GRAPH);
    graph["6"]!.inputs["samples"] = ["99", 0];
    const r = preflightWorkflow({ graph, manifest: VALID_MANIFEST, objectInfo: SCHEMA });
    expect(r.status).toBe("failed");
    const hit = r.issues.find((i) => i.code === "unknown_node_ref");
    expect(hit?.node_id).toBe("6");
    expect(hit?.input).toBe("samples");
  });

  it("负数/非整数/非数字 output index → invalid_output_index", () => {
    for (const bad of [-1, 1.5, "0", null]) {
      const graph = clone(VALID_GRAPH);
      graph["6"]!.inputs["samples"] = ["5", bad];
      const r = preflightWorkflow({ graph, manifest: VALID_MANIFEST, objectInfo: SCHEMA });
      expect(codes(r)).toContain("invalid_output_index");
    }
  });

  it("output index 超出目标输出上界 → output_index_out_of_range", () => {
    const graph = clone(VALID_GRAPH);
    graph["6"]!.inputs["vae"] = ["1", 3]; // CheckpointLoaderSimple 只有 3 路输出（0-2）
    const r = preflightWorkflow({ graph, manifest: VALID_MANIFEST, objectInfo: SCHEMA });
    expect(r.status).toBe("failed");
    expect(codes(r)).toContain("output_index_out_of_range");
  });

  it("无 schema 时连线结构问题仍被检查（index/引用），上界不误报", () => {
    const graph = clone(VALID_GRAPH);
    graph["6"]!.inputs["samples"] = ["404", -2];
    const r = preflightWorkflow({ graph, manifest: VALID_MANIFEST });
    expect(codes(r)).toContain("invalid_output_index");
    // 合法上界的连线在无 schema 时不误报 out_of_range
    const ok = preflightWorkflow({ graph: VALID_GRAPH, manifest: VALID_MANIFEST });
    expect(codes(ok)).not.toContain("output_index_out_of_range");
  });
});

// ---------------------------------------------------------------------------
// schema 检查
// ---------------------------------------------------------------------------

describe("preflight schema 检查", () => {
  it("未知 class_type → unknown_class_type", () => {
    const graph = clone(VALID_GRAPH);
    graph["4"]!.class_type = "NotInstalledNode";
    const r = preflightWorkflow({ graph, manifest: VALID_MANIFEST, objectInfo: SCHEMA });
    expect(r.status).toBe("failed");
    const hit = r.issues.find((i) => i.code === "unknown_class_type");
    expect(hit?.node_id).toBe("4");
  });

  it("schema 规格无法解析 → schema_unparseable 警告而非误报", () => {
    const broken = normalizeObjectInfo({
      ...RAW_SCHEMA,
      KSampler: { input: "garbage", output: ["LATENT"], output_node: false } as unknown as ObjectInfoNode
    });
    const r = preflightWorkflow({ graph: VALID_GRAPH, manifest: VALID_MANIFEST, objectInfo: broken });
    expect(codes(r)).toContain("schema_unparseable");
    // KSampler 的输入不会被当作 unknown_input（规格按不可确认处理）
    expect(r.issues.find((i) => i.code === "unknown_input" && i.node_id === "5")).toBeUndefined();
    expect(r.status).toBe("warning");
  });

  it("未知输入 → unknown_input", () => {
    const graph = clone(VALID_GRAPH);
    graph["4"]!.inputs["typo_width"] = 512;
    const r = preflightWorkflow({ graph, manifest: VALID_MANIFEST, objectInfo: SCHEMA });
    expect(r.status).toBe("failed");
    const hit = r.issues.find((i) => i.code === "unknown_input");
    expect(hit?.node_id).toBe("4");
    expect(hit?.input).toBe("typo_width");
  });

  it("缺 required：无论规格是否带显示默认值均为 error", () => {
    const graph = clone(VALID_GRAPH);
    delete graph["2"]!.inputs["text"];
    delete graph["7"]!.inputs["filename_prefix"];
    const r = preflightWorkflow({ graph, manifest: VALID_MANIFEST, objectInfo: SCHEMA });
    const missing = r.issues.filter((i) => i.code === "missing_required");
    expect(missing).toHaveLength(2);
    expect(missing.every((i) => i.severity === "error")).toBe(true);
    expect(r.status).toBe("failed");
  });

  it("连线输入/输出类型不匹配 → type_mismatch（INT→FLOAT 兼容）", () => {
    const graph = clone(VALID_GRAPH);
    graph["5"]!.inputs["model"] = ["2", 0]; // CONDITIONING 接入 MODEL 输入
    const r = preflightWorkflow({ graph, manifest: VALID_MANIFEST, objectInfo: SCHEMA });
    expect(r.status).toBe("failed");
    const hit = r.issues.find((i) => i.code === "type_mismatch");
    expect(hit?.node_id).toBe("5");
    expect(hit?.input).toBe("model");
    expect(hit?.message).toContain("CONDITIONING");
  });

  it("非法 combo 值 → combo_value_invalid", () => {
    const graph = clone(VALID_GRAPH);
    graph["5"]!.inputs["sampler_name"] = "bogus_sampler";
    const r = preflightWorkflow({ graph, manifest: VALID_MANIFEST, objectInfo: SCHEMA });
    expect(r.status).toBe("failed");
    const hit = r.issues.find((i) => i.code === "combo_value_invalid");
    expect(hit?.node_id).toBe("5");
    expect(hit?.input).toBe("sampler_name");
  });

  it("字面值类型不符 → value_type_mismatch（INT 输入传字符串）", () => {
    const graph = clone(VALID_GRAPH);
    graph["4"]!.inputs["width"] = "1024";
    const r = preflightWorkflow({ graph, manifest: VALID_MANIFEST, objectInfo: SCHEMA });
    const hit = r.issues.find((i) => i.code === "value_type_mismatch");
    expect(hit?.node_id).toBe("4");
    expect(hit?.input).toBe("width");
  });

  it("畸形数组连线、数值范围和空 combo 均给出明确结果", () => {
    const malformed = clone(VALID_GRAPH);
    malformed["5"]!.inputs["model"] = ["1", 0, 2];
    expect(codes(preflightWorkflow({ graph: malformed, manifest: VALID_MANIFEST }))).toContain("invalid_link");

    const outOfRange = clone(VALID_GRAPH);
    outOfRange["4"]!.inputs["width"] = 8;
    expect(codes(preflightWorkflow({ graph: outOfRange, manifest: VALID_MANIFEST, objectInfo: SCHEMA })))
      .toContain("value_out_of_range");

    const noChoices = normalizeObjectInfo({
      ...RAW_SCHEMA,
      KSampler: {
        ...RAW_SCHEMA["KSampler"]!,
        input: { required: { ...RAW_SCHEMA["KSampler"]!["input"]!["required"]!, sampler_name: [[], {}] } }
      }
    });
    const r = preflightWorkflow({ graph: VALID_GRAPH, manifest: VALID_MANIFEST, objectInfo: noChoices });
    expect(codes(r)).toContain("combo_unverified");
    expect(r.status).toBe("warning");
  });

  it("schema 未提供输出表时 output index 只能 unknown，不能误报越界", () => {
    const raw = structuredClone(RAW_SCHEMA);
    delete raw["EmptyLatentImage"]!["output"];
    const r = preflightWorkflow({ graph: VALID_GRAPH, manifest: VALID_MANIFEST, objectInfo: normalizeObjectInfo(raw) });
    expect(codes(r)).toContain("output_index_unverified");
    expect(codes(r)).not.toContain("output_index_out_of_range");
    expect(r.status).toBe("warning");
  });

  it("图中无输出节点 → no_output_node；有未知 class 时不误报", () => {
    const noSave = clone(VALID_GRAPH);
    delete noSave["7"];
    const r = preflightWorkflow({ graph: noSave, manifest: VALID_MANIFEST, objectInfo: SCHEMA });
    expect(codes(r)).toContain("no_output_node");
    expect(r.status).toBe("failed");

    const unknownClass = clone(noSave);
    unknownClass["6"]!.class_type = "MysterySaver";
    const r2 = preflightWorkflow({ graph: unknownClass, manifest: VALID_MANIFEST, objectInfo: SCHEMA });
    expect(codes(r2)).not.toContain("no_output_node"); // 不能断言
  });
});

// ---------------------------------------------------------------------------
// 模型依赖
// ---------------------------------------------------------------------------

describe("preflight 模型依赖", () => {
  it("值在清单内 → found，无 issue", () => {
    const r = preflightWorkflow({ graph: VALID_GRAPH, manifest: VALID_MANIFEST, objectInfo: SCHEMA });
    expect(r.models.found).toBe(1);
    expect(codes(r)).not.toContain("model_missing");
  });

  it("值不在清单内 → missing 计数 + model_missing issue", () => {
    const graph = clone(VALID_GRAPH);
    graph["1"]!.inputs["ckpt_name"] = "not-installed.safetensors";
    const r = preflightWorkflow({ graph, manifest: VALID_MANIFEST, objectInfo: SCHEMA });
    expect(r.status).toBe("failed");
    expect(r.models).toEqual({ found: 0, missing: 1, unknown: 0 });
    const hit = r.issues.find((i) => i.code === "model_missing");
    expect(hit?.node_id).toBe("1");
    expect(hit?.input).toBe("ckpt_name");
    expect(hit?.message).toContain("checkpoint");
    expect(hit?.message).toContain("not-installed.safetensors");
    expect(hit?.message).not.toContain("sdxl-base.safetensors");
  });

  it("combo 清单为空 → unknown 计数 + model_unknown warning（不臆测 missing）", () => {
    const schema2 = normalizeObjectInfo({
      ...RAW_SCHEMA,
      CheckpointLoaderSimple: {
        input: { required: { ckpt_name: [[], {}] } }, // 模型目录为空
        output: ["MODEL", "CLIP", "VAE"],
        output_node: false
      }
    });
    const r = preflightWorkflow({ graph: VALID_GRAPH, manifest: VALID_MANIFEST, objectInfo: schema2 });
    expect(r.models).toEqual({ found: 0, missing: 0, unknown: 1 });
    expect(r.status).toBe("warning");
    expect(codes(r)).toContain("model_unknown");
  });

  it("schema 未知该节点 → unknown 计数，不给 missing/found", () => {
    const schema2 = normalizeObjectInfo({ ...RAW_SCHEMA });
    delete schema2["CheckpointLoaderSimple"];
    const r = preflightWorkflow({ graph: VALID_GRAPH, manifest: VALID_MANIFEST, objectInfo: schema2 });
    expect(r.models.unknown).toBe(1);
    expect(r.models.missing).toBe(0);
    expect(codes(r)).toContain("unknown_class_type");
  });

  it("模型输入但规格非 combo → unknown + warning（不臆测 missing）", () => {
    const schema2 = normalizeObjectInfo({
      ...RAW_SCHEMA,
      WeirdLoader: {
        input: { required: { ckpt_name: ["STRING", { default: "x" }] } }, // 模型输入但非 combo
        output: ["MODEL"],
        output_node: false
      }
    });
    const graph: WorkflowGraph = {
      "1": { class_type: "WeirdLoader", inputs: { ckpt_name: "whatever" } },
      "2": { class_type: "SaveImage", inputs: { images: ["1", 0] } }
    };
    const r = preflightWorkflow({
      graph,
      manifest: mf([{ name: "p", node: "1", input: "ckpt_name", type: "string" }]),
      objectInfo: schema2
    });
    // 非 combo 规格无法确认 → unknown + warning
    expect(r.models.unknown).toBe(1);
    expect(codes(r)).toContain("model_unknown");
  });
});

// ---------------------------------------------------------------------------
// manifest 交叉检查
// ---------------------------------------------------------------------------

describe("preflight manifest 检查", () => {
  it("target 节点不存在 → manifest_target_missing", () => {
    const manifest = mf([{ name: "p", node: "404", input: "text", type: "string" }]);
    const r = preflightWorkflow({ graph: VALID_GRAPH, manifest, objectInfo: SCHEMA });
    expect(r.status).toBe("failed");
    const hit = r.issues.find((i) => i.code === "manifest_target_missing");
    expect(hit?.param).toBe("p");
  });

  it("target 输入不存在（schema 已知）→ manifest_input_unknown；schema 不可用 → warning", () => {
    const manifest = mf([{ name: "p", node: "2", input: "typo", type: "string" }]);
    const r = preflightWorkflow({ graph: VALID_GRAPH, manifest, objectInfo: SCHEMA });
    const hit = r.issues.find((i) => i.code === "manifest_input_unknown");
    expect(hit?.severity).toBe("error");

    const r2 = preflightWorkflow({ graph: VALID_GRAPH, manifest });
    const hit2 = r2.issues.find((i) => i.code === "manifest_input_unverified");
    expect(hit2?.severity).toBe("warning");
  });

  it("白名单类型不兼容 → manifest_type_mismatch error（string 指向 INT）", () => {
    const manifest = mf([{ name: "p", node: "5", input: "steps", type: "string" }]);
    const r = preflightWorkflow({ graph: VALID_GRAPH, manifest, objectInfo: SCHEMA });
    const hit = r.issues.find((i) => i.code === "manifest_type_mismatch");
    expect(hit?.severity).toBe("error");
  });

  it("number 指向 INT 输入 → 降为 warning（须自行保证整数）", () => {
    const manifest = mf([{ name: "p", node: "5", input: "steps", type: "number" }]);
    const r = preflightWorkflow({ graph: VALID_GRAPH, manifest, objectInfo: SCHEMA });
    const hit = r.issues.find((i) => i.code === "manifest_type_mismatch");
    expect(hit?.severity).toBe("warning");
  });

  it("enum 集合含 combo 清单外的值 → manifest_enum_out_of_choices", () => {
    const manifest = mf([
      { name: "s", node: "5", input: "sampler_name", type: "enum", enum: ["euler", "bogus_sampler"] }
    ]);
    const r = preflightWorkflow({ graph: VALID_GRAPH, manifest, objectInfo: SCHEMA });
    const hit = r.issues.find((i) => i.code === "manifest_enum_out_of_choices");
    expect(hit?.severity).toBe("error");
    expect(hit?.message).toContain("bogus_sampler");
  });

  it("enum default 不在 combo 清单 → manifest_default_invalid", () => {
    const manifest = mf([
      { name: "s", node: "5", input: "sampler_name", type: "enum", enum: ["euler", "ddim"], default: "ddim" }
    ]);
    const r = preflightWorkflow({ graph: VALID_GRAPH, manifest, objectInfo: SCHEMA });
    expect(codes(r)).toContain("manifest_default_invalid");
  });

  it("数值 default 超出输入规格范围 → manifest_default_out_of_range error", () => {
    const manifest = mf([{ name: "steps2", node: "5", input: "steps", type: "integer", default: 99999 }]);
    const r = preflightWorkflow({ graph: VALID_GRAPH, manifest, objectInfo: SCHEMA });
    const hit = r.issues.find((i) => i.code === "manifest_default_out_of_range");
    expect(hit?.severity).toBe("error");
  });

  it("string 参数指向 combo 输入且 default 不在清单 → manifest_default_invalid", () => {
    const manifest = mf([{ name: "p", node: "5", input: "sampler_name", type: "string", default: "nope" }]);
    const r = preflightWorkflow({ graph: VALID_GRAPH, manifest, objectInfo: SCHEMA });
    expect(codes(r)).toContain("manifest_default_invalid");
  });

  it("合法 enum/数值 default 与 schema 一致 → 无额外 issue", () => {
    const manifest = mf([
      { name: "s", node: "5", input: "sampler_name", type: "enum", enum: ["euler", "dpmpp_2m"], default: "euler" },
      { name: "steps2", node: "5", input: "steps", type: "integer", default: 30 }
    ]);
    const r = preflightWorkflow({ graph: VALID_GRAPH, manifest, objectInfo: SCHEMA });
    expect(r.status).toBe("passed");
    expect(r.issues).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 有界输出
// ---------------------------------------------------------------------------

describe("preflight 有界输出", () => {
  it("issue 超过上限被截断（truncated=true）", () => {
    const graph: WorkflowGraph = {};
    for (let i = 0; i < MAX_PREFLIGHT_ISSUES + 10; i++) {
      graph[`n${i}`] = { class_type: "MissingNode", inputs: { x: 1 } };
    }
    const r = preflightWorkflow({ graph, manifest: VALID_MANIFEST, objectInfo: SCHEMA });
    expect(r.issues).toHaveLength(MAX_PREFLIGHT_ISSUES);
    expect(r.truncated).toBe(true);
    // 消息本身有界（clipTail 上限 200 + 截断标记 3）
    for (const issue of r.issues) expect(issue.message.length).toBeLessThanOrEqual(203);
  });

  it("报告不回传完整 graph/schema/模型清单（只有 issue 与计数）", () => {
    const r = preflightWorkflow({ graph: VALID_GRAPH, manifest: VALID_MANIFEST, objectInfo: SCHEMA });
    const keys = Object.keys(r);
    expect(keys.sort()).toEqual(["issues", "models", "schemaAvailable", "status", "truncated"].sort());
  });
});
