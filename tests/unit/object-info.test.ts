import { describe, expect, it } from "vitest";
import {
  DEFAULT_OBJECT_INFO_TTL_MS,
  ObjectInfoCache,
  classifyModelInput,
  normalizeInputSpec,
  normalizeObjectInfo,
  type ObjectInfoCacheOptions
} from "../../src/core/workflow/object-info.js";
import type { ObjectInfoNode } from "../../src/core/client/types.js";

/**
 * Task 010：/object_info 缓存与兼容解析。
 * - combo 双形状（ComfyUI API contract F8）+ COMBO+options/choices + 对象形状 + 普通类型 + 自定义引用类型
 * - 模型输入识别
 * - 缓存 TTL / stale 降级 / epoch 失效 / 并发去重
 */

describe("normalizeInputSpec combo 形状兼容", () => {
  it("旧形状 [类型名, 值数组]", () => {
    expect(normalizeInputSpec(["COMBO", ["euler", "ddim"]])).toEqual({ kind: "combo", choices: ["euler", "ddim"] });
  });

  it("0.41 新形状 [值数组, 配置对象]（ComfyUI API contract F8）", () => {
    expect(normalizeInputSpec([["euler", "ddim"], { tooltip: "采样器" }])).toEqual({
      kind: "combo",
      choices: ["euler", "ddim"]
    });
  });

  it("COMBO + options.choices / choices / combo.options", () => {
    expect(normalizeInputSpec(["COMBO", { options: { choices: ["a", "b"] } }])).toEqual({ kind: "combo", choices: ["a", "b"] });
    expect(normalizeInputSpec(["COMBO", { choices: ["a"] }])).toEqual({ kind: "combo", choices: ["a"] });
    expect(normalizeInputSpec(["COMBO", { combo: { options: ["a", "b"] } }])).toEqual({ kind: "combo", choices: ["a", "b"] });
  });

  it("对象形状 {type, options.choices} / {type, choices}", () => {
    expect(normalizeInputSpec({ type: "COMBO", options: { choices: ["x"] } })).toEqual({ kind: "combo", choices: ["x"] });
    expect(normalizeInputSpec({ type: "combo", choices: ["x", "y"] })).toEqual({ kind: "combo", choices: ["x", "y"] });
  });

  it("combo 带 string default 时保留", () => {
    expect(normalizeInputSpec([["euler"], { default: "euler" }])).toEqual({ kind: "combo", choices: ["euler"], default: "euler" });
  });

  it("空值清单保留为空 combo（区别于 ref/unknown）", () => {
    expect(normalizeInputSpec([[], {}])).toEqual({ kind: "combo", choices: [] });
    expect(normalizeInputSpec(["COMBO"])).toEqual({ kind: "combo", choices: [] });
  });

  it("非字符串项被过滤", () => {
    expect(normalizeInputSpec([[1, "a", null, "b"]])).toEqual({ kind: "combo", choices: ["a", "b"] });
    expect(normalizeInputSpec(["COMBO", [2, true]])).toEqual({ kind: "combo", choices: [] });
  });
});

describe("normalizeInputSpec 普通类型与引用类型", () => {
  it("INT/FLOAT/STRING/BOOLEAN", () => {
    expect(normalizeInputSpec(["INT", { default: 20, min: 1, max: 10000 }])).toEqual({
      kind: "int",
      default: 20,
      min: 1,
      max: 10000
    });
    expect(normalizeInputSpec(["FLOAT", { default: 8, min: 0, max: 100, step: 0.1 }])).toEqual({
      kind: "float",
      default: 8,
      min: 0,
      max: 100,
      step: 0.1
    });
    expect(normalizeInputSpec(["STRING", { multiline: true, default: "hi" }])).toEqual({
      kind: "string",
      default: "hi",
      multiline: true
    });
    expect(normalizeInputSpec(["BOOLEAN", { default: true }])).toEqual({ kind: "boolean", default: true });
  });

  it("对象形状的普通类型", () => {
    expect(normalizeInputSpec({ type: "INT", default: 5, min: 0 })).toEqual({ kind: "int", default: 5, min: 0 });
  });

  it("自定义引用类型：裸类型名 / 类型名+配置 / 对象形状", () => {
    expect(normalizeInputSpec(["MODEL"])).toEqual({ kind: "ref", type: "MODEL" });
    expect(normalizeInputSpec(["MyCustomType", { tooltip: "t" }])).toEqual({ kind: "ref", type: "MyCustomType" });
    expect(normalizeInputSpec({ type: "LATENT" })).toEqual({ kind: "ref", type: "LATENT" });
  });

  it("无法解析 → unknown（不得误判为任何具体类型）", () => {
    expect(normalizeInputSpec(42)).toEqual({ kind: "unknown" });
    expect(normalizeInputSpec(null)).toEqual({ kind: "unknown" });
    expect(normalizeInputSpec({})).toEqual({ kind: "unknown" });
    expect(normalizeInputSpec([true, ["a"]])).toEqual({ kind: "unknown" });
  });
});

describe("normalizeObjectInfo", () => {
  const raw: Record<string, ObjectInfoNode> = {
    KSampler: {
      input: {
        required: {
          seed: ["INT", { default: 0, min: 0, max: 4294967295 }],
          sampler_name: [["euler", "ddim"], {}]
        },
        optional: { control_after_generate: [["fixed", "random"], {}] }
      },
      output: ["LATENT", 1],
      output_node: false
    },
    SaveImage: { input: { required: { images: ["IMAGE"] } }, output: [], output_node: true },
    BrokenNode: { input: "not-an-object", output: ["IMAGE"], output_node: false } as unknown as ObjectInfoNode
  };

  it("导出 required/optional、输出类型数组、output_node 判定", () => {
    const nodes = normalizeObjectInfo(raw);
    const ks = nodes["KSampler"]!;
    expect(ks.required["seed"]).toEqual({ kind: "int", default: 0, min: 0, max: 4294967295 });
    expect(ks.required["sampler_name"]).toEqual({ kind: "combo", choices: ["euler", "ddim"] });
    expect(ks.optional["control_after_generate"]).toEqual({ kind: "combo", choices: ["fixed", "random"] });
    expect(ks.outputs).toEqual([]);
    expect(ks.outputsKnown).toBe(false); // 非字符串输出项使索引上界不可确认，不移位
    expect(ks.outputNode).toBe(false);
    expect(nodes["SaveImage"]!.outputNode).toBe(true);
    expect(nodes["SaveImage"]!.outputs).toEqual([]);
  });

  it("input 段结构异常 → malformed 标记（而非静默空规格）", () => {
    const nodes = normalizeObjectInfo(raw);
    expect(nodes["BrokenNode"]!.malformed).toBe(true);
    expect(nodes["BrokenNode"]!.outputs).toEqual(["IMAGE"]);
  });
});

describe("classifyModelInput", () => {
  it("明确可识别项", () => {
    expect(classifyModelInput("CheckpointLoaderSimple", "ckpt_name")).toBe("ckpt");
    expect(classifyModelInput("LoraLoader", "lora_name")).toBe("lora");
    expect(classifyModelInput("VAELoader", "vae_name")).toBe("vae");
    expect(classifyModelInput("UpscaleModelLoader", "model_name")).toBe("upscale");
    expect(classifyModelInput("UpscaleModelLoader", "upscale_name")).toBe("upscale");
    expect(classifyModelInput("ControlNetLoader", "control_net_name")).toBe("controlnet");
    expect(classifyModelInput("UNETLoader", "unet_name")).toBe("unet");
    expect(classifyModelInput("CLIPLoader", "clip_name")).toBe("clip");
    expect(classifyModelInput("CLIPVisionLoader", "clip_name")).toBe("clip");
  });

  it("不明确项返回 null（不臆测）", () => {
    expect(classifyModelInput("KSampler", "seed")).toBeNull();
    expect(classifyModelInput("CheckpointLoaderSimple", "text")).toBeNull();
    // model_name 只在 Upscale* 类上认定，其他节点不猜
    expect(classifyModelInput("SomeCustomNode", "model_name")).toBeNull();
  });
});

describe("ObjectInfoCache", () => {
  const raw: Record<string, ObjectInfoNode> = {
    KSampler: { input: { required: { seed: ["INT", { default: 0 }] } }, output: ["LATENT"], output_node: false }
  };

  function setup(over: Partial<ObjectInfoCacheOptions> = {}) {
    let clock = 1_000_000;
    let epoch = 0;
    let calls = 0;
    const cache = new ObjectInfoCache({
      fetcher: async () => {
        calls += 1;
        // 每次调用返回可区分的 payload（default = 第几次调用）
        return { KSampler: { input: { required: { seed: ["INT", { default: calls }] } }, output: ["LATENT"], output_node: false } };
      },
      now: () => clock,
      epoch: () => epoch,
      ...over
    });
    return {
      cache,
      fetchCount: () => calls,
      advance: (ms: number) => {
        clock += ms;
      },
      setEpoch: (e: number) => {
        epoch = e;
      },
      get clock() {
        return clock;
      }
    };
  }

  it("首次获取 source=live，并带规范化 nodes 与 raw", async () => {
    const s = setup();
    const snap = await s.cache.get();
    expect(snap.source).toBe("live");
    expect(snap.raw).toBeTruthy();
    expect(snap.nodes["KSampler"]!.required["seed"]).toEqual({ kind: "int", default: 1 });
    expect(s.fetchCount()).toBe(1);
  });

  it("TTL 内命中 source=cache，不重复请求", async () => {
    const s = setup();
    await s.cache.get();
    const snap = await s.cache.get();
    expect(snap.source).toBe("cache");
    expect(s.fetchCount()).toBe(1);
  });

  it("默认 TTL 为 5 分钟：差 1ms 仍 cache，满 5 分钟刷新为 live", async () => {
    const s = setup();
    await s.cache.get();
    s.advance(DEFAULT_OBJECT_INFO_TTL_MS - 1);
    expect((await s.cache.get()).source).toBe("cache");
    s.advance(1);
    const snap = await s.cache.get();
    expect(snap.source).toBe("live");
    expect(s.fetchCount()).toBe(2);
  });

  it("force=true 在 TTL 内强制刷新", async () => {
    const s = setup();
    await s.cache.get();
    const snap = await s.cache.get({ force: true });
    expect(snap.source).toBe("live");
    expect(s.fetchCount()).toBe(2);
  });

  it("过期后刷新成功 → source=live 且缓存更新", async () => {
    const s = setup();
    await s.cache.get();
    s.advance(DEFAULT_OBJECT_INFO_TTL_MS + 10);
    const snap = await s.cache.get();
    expect(snap.source).toBe("live");
    expect(snap.fetchedAt).toBe(s.clock);
    expect(s.fetchCount()).toBe(2);
  });

  it("过期后刷新失败但有旧数据 → source=stale 带 warning，绝不当 live", async () => {
    let clock = 1_000_000;
    let fail = false;
    const cache = new ObjectInfoCache({
      fetcher: async () => {
        if (fail) throw new Error("connection refused");
        return raw;
      },
      now: () => clock,
      epoch: () => 0
    });
    const first = await cache.get();
    expect(first.source).toBe("live");
    clock += DEFAULT_OBJECT_INFO_TTL_MS + 10;
    fail = true;
    const stale = await cache.get();
    expect(stale.source).toBe("stale");
    expect(stale.warning).toBeTruthy();
    expect(stale.warning).toContain("刷新失败");
    expect(stale.nodes).toBe(first.nodes); // 旧数据原样返回
    expect(stale.nodes).toBeTruthy();
  });

  it("无任何数据且失败 → source=unavailable 带 error", async () => {
    const cache = new ObjectInfoCache({
      fetcher: () => Promise.reject(new Error("boom")),
      now: () => 1_000
    });
    const snap = await cache.get();
    expect(snap.source).toBe("unavailable");
    expect(snap.nodes).toBeNull();
    expect(snap.raw).toBeNull();
    expect(snap.error).toContain("boom");
  });

  it("首次失败、再次成功 → unavailable → live", async () => {
    let fail = true;
    const cache = new ObjectInfoCache({
      fetcher: async () => {
        if (fail) throw new Error("down");
        return raw;
      },
      now: () => 1_000
    });
    expect((await cache.get()).source).toBe("unavailable");
    fail = false;
    const snap = await cache.get();
    expect(snap.source).toBe("live");
    expect(snap.nodes).toBeTruthy();
  });

  it("连接 epoch 变化：TTL 内也强制刷新", async () => {
    const s = setup();
    await s.cache.get();
    s.setEpoch(1);
    const snap = await s.cache.get();
    expect(snap.source).toBe("live");
    expect(snap.epoch).toBe(1);
    expect(s.fetchCount()).toBe(2);
  });

  it("epoch 变化 + 刷新失败 → stale（不算 live 也不算 unavailable）", async () => {
    const clock = 1_000_000;
    let epoch = 0;
    let fail = false;
    const cache = new ObjectInfoCache({
      fetcher: async () => {
        if (fail) throw new Error("reconnecting");
        return raw;
      },
      now: () => clock,
      epoch: () => epoch
    });
    await cache.get();
    epoch = 2;
    fail = true;
    const snap = await cache.get();
    expect(snap.source).toBe("stale");
    expect(snap.warning).toContain("reconnecting");
  });

  it("连接 epoch 持续抖动时有界返回 stale，不递归制造请求风暴", async () => {
    let epoch = 0;
    let calls = 0;
    const cache = new ObjectInfoCache({
      fetcher: async () => {
        calls++;
        epoch++;
        return raw;
      },
      epoch: () => epoch
    });
    const snapshot = await cache.get();
    expect(calls).toBe(3);
    expect(snapshot.source).toBe("stale");
    expect(snapshot.warning).toContain("持续变化");
  });

  it("hidden 输入被保留；异常输出表不错位移位", () => {
    const normalized = normalizeObjectInfo({
      Node: {
        input: { required: {}, hidden: { control_after_generate: [["fixed", "randomize"], {}] } },
        output: ["LATENT", 1],
        output_node: false
      }
    });
    expect(normalized["Node"]!.hidden["control_after_generate"]).toMatchObject({ kind: "combo", choices: ["fixed", "randomize"] });
    expect(normalized["Node"]!.outputsKnown).toBe(false);
    expect(normalized["Node"]!.outputs).toEqual([]);
  });

  it("并发去重：空缓存并发 5 次 get 只请求 1 次，全部 live", async () => {
    const s = setup();
    const snaps = await Promise.all([s.cache.get(), s.cache.get(), s.cache.get(), s.cache.get(), s.cache.get()]);
    expect(s.fetchCount()).toBe(1);
    for (const snap of snaps) expect(snap.source).toBe("live");
  });

  it("并发去重：过期后并发 3 次 get 只请求 1 次", async () => {
    const s = setup();
    await s.cache.get();
    s.advance(DEFAULT_OBJECT_INFO_TTL_MS + 1);
    const snaps = await Promise.all([s.cache.get(), s.cache.get(), s.cache.get()]);
    expect(s.fetchCount()).toBe(2);
    for (const snap of snaps) expect(snap.source).toBe("live");
  });

  it("失败的并发刷新清掉在途标记：下一次 get 可重试", async () => {
    const clock = 1_000_000;
    let fail = true;
    const cache = new ObjectInfoCache({
      fetcher: async () => {
        if (fail) throw new Error("x");
        return raw;
      },
      now: () => clock,
      epoch: () => 0
    });
    const [a] = await Promise.all([cache.get(), cache.get()]);
    expect(a.source).toBe("unavailable");
    fail = false;
    const snap = await cache.get();
    expect(snap.source).toBe("live");
  });

  it("peek：无缓存 null；有缓存返回快照且不触发请求；过期标记 stale", async () => {
    const s = setup();
    expect(s.cache.peek()).toBeNull();
    await s.cache.get();
    const fresh = s.cache.peek();
    expect(fresh?.source).toBe("cache");
    expect(s.fetchCount()).toBe(1);
    s.advance(DEFAULT_OBJECT_INFO_TTL_MS + 1);
    const expired = s.cache.peek();
    expect(expired?.source).toBe("stale");
    expect(expired?.warning).toBeTruthy();
    expect(s.fetchCount()).toBe(1); // peek 不发请求
  });

  it("invalidate 后下次 get 重新请求", async () => {
    const s = setup();
    await s.cache.get();
    s.cache.invalidate();
    const snap = await s.cache.get();
    expect(snap.source).toBe("live");
    expect(s.fetchCount()).toBe(2);
    expect(s.cache.peek()?.source).toBe("cache");
  });
});
