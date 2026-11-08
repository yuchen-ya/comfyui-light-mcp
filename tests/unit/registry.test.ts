import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WorkflowRegistry } from "../../src/core/workflow/registry.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "reg-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const GOOD_MANIFEST = {
  name: "good",
  description: "好工作流",
  version: 1,
  workflowFile: "good.json",
  params: [{ name: "prompt", node: "4", input: "text", type: "string", required: true }]
};
const GOOD_GRAPH = {
  "4": { class_type: "TextEncode", inputs: { text: "hi" } },
  "9": { class_type: "SaveImage", inputs: { images: ["8", 0] } }
};

async function put(sub: string, files: Record<string, unknown>): Promise<void> {
  const d = path.join(dir, sub);
  await mkdir(d, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(d, name), JSON.stringify(content));
  }
}

describe("WorkflowRegistry", () => {
  it("正常加载（含子目录）并摘要/详情查询", async () => {
    await put("examples", { "good.manifest.json": GOOD_MANIFEST, "good.json": GOOD_GRAPH });
    const reg = new WorkflowRegistry(dir);
    const report = await reg.load();
    expect(report.errors).toEqual([]);
    expect(report.loaded).toEqual([{ name: "good", description: "好工作流", version: 1, params: 1 }]);
    expect(reg.get("good")?.manifest.name).toBe("good");
    const detail = reg.paramDetail("good");
    expect(detail?.[0]?.["name"]).toBe("prompt");
  });

  it("坏 manifest 不阻断好 manifest（LoadReport 逐文件错误）", async () => {
    await put("a", {
      "good.manifest.json": GOOD_MANIFEST,
      "good.json": GOOD_GRAPH,
      "bad.manifest.json": { ...GOOD_MANIFEST, name: "bad", params: [] }
    });
    const reg = new WorkflowRegistry(dir);
    const report = await reg.load();
    expect(report.loaded.map((l) => l.name)).toEqual(["good"]);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]!.message).toMatch(/params/);
  });

  it("交叉校验：引用不存在的节点 / 不存在的 input / 连线输入", async () => {
    await put("x1", { "m.manifest.json": { ...GOOD_MANIFEST, params: [{ name: "p", node: "99", input: "text", type: "string" }] }, "good.json": GOOD_GRAPH });
    await put("x2", { "m.manifest.json": { ...GOOD_MANIFEST, params: [{ name: "p", node: "4", input: "nope", type: "string" }] }, "good.json": GOOD_GRAPH });
    await put("x3", { "m.manifest.json": { ...GOOD_MANIFEST, params: [{ name: "p", node: "9", input: "images", type: "string" }] }, "good.json": GOOD_GRAPH });
    const reg = new WorkflowRegistry(dir);
    const report = await reg.load();
    expect(report.loaded).toEqual([]);
    expect(report.errors).toHaveLength(3);
    expect(report.errors[0]!.message).toMatch(/节点 "99".*不存在/);
    expect(report.errors[1]!.message).toMatch(/输入 "4\.inputs\.nope" 不存在/);
    expect(report.errors[2]!.message).toMatch(/连线输入/);
  });

  it("workflowFile 指向缺失文件报错；目录不存在整体报错", async () => {
    await put("y", { "m.manifest.json": GOOD_MANIFEST });
    const reg = new WorkflowRegistry(dir);
    const r1 = await reg.load();
    expect(r1.errors[0]!.message).toMatch(/读取失败/);

    const reg2 = new WorkflowRegistry(path.join(dir, "no-such-dir"));
    const r2 = await reg2.load();
    expect(r2.errors[0]!.message).toMatch(/工作流目录不可读/);
  });

  it("重名工作流被拒（全局唯一）", async () => {
    await put("d1", { "m.manifest.json": GOOD_MANIFEST, "good.json": GOOD_GRAPH });
    await put("d2", { "m2.manifest.json": GOOD_MANIFEST, "good.json": GOOD_GRAPH });
    const reg = new WorkflowRegistry(dir);
    const report = await reg.load();
    expect(report.loaded).toHaveLength(1);
    expect(report.errors[0]!.message).toMatch(/重复/);
  });
});

// listWorkflowsView 不存在——防止误用 API 的哨兵（见 registry.list()）
describe("registry API 形状", () => {
  it("list() 返回摘要数组", async () => {
    await put("z", { "m.manifest.json": GOOD_MANIFEST, "good.json": GOOD_GRAPH });
    const reg = new WorkflowRegistry(dir);
    await reg.load();
    expect(reg.list()).toHaveLength(1);
  });
});
