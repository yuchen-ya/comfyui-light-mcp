import { describe, expect, it } from "vitest";
import { loadConfig, ConfigError } from "../../src/config.js";

describe("loadConfig", () => {
  it("默认值：本地 8188、串行窗口、自动落盘", () => {
    const c = loadConfig({});
    expect(c.comfyUiUrl).toBe("http://127.0.0.1:8188");
    expect(c.workflowsDir).toBe("./workflows");
    expect(c.dataDir).toBe("./data");
    expect(c.outputDir).toBe("./output");
    expect(c.autoSaveOutputs).toBe(true);
    expect(c.maxInFlight).toBe(1);
    expect(c.maxQueuedJobs).toBe(1);
  });

  it("环境变量覆盖与 URL 尾斜杠规范化", () => {
    const c = loadConfig({
      COMFYUI_URL: "http://192.0.2.10:8188/",
      WORKFLOWS_DIR: "C:/wf",
      MAX_IN_FLIGHT: "4",
      MAX_QUEUED_JOBS: "2",
      AUTO_SAVE_OUTPUTS: "false"
    });
    expect(c.comfyUiUrl).toBe("http://192.0.2.10:8188");
    expect(c.workflowsDir).toBe("C:/wf");
    expect(c.maxInFlight).toBe(4);
    expect(c.maxQueuedJobs).toBe(2);
    expect(c.autoSaveOutputs).toBe(false);
  });

  it("非 http(s) URL 拒绝", () => {
    expect(() => loadConfig({ COMFYUI_URL: "ftp://x" })).toThrow(ConfigError);
    expect(() => loadConfig({ COMFYUI_URL: "not-a-url" })).toThrow(ConfigError);
  });

  it("maxQueuedJobs > maxInFlight 拒绝（双窗口约束）", () => {
    expect(() => loadConfig({ MAX_IN_FLIGHT: "1", MAX_QUEUED_JOBS: "2" })).toThrow(/不能大于/);
  });

  it("窗口值非法（0/负数/非整数）拒绝", () => {
    expect(() => loadConfig({ MAX_IN_FLIGHT: "0" })).toThrow(ConfigError);
    expect(() => loadConfig({ MAX_IN_FLIGHT: "1.5" })).toThrow(ConfigError);
    expect(() => loadConfig({ MAX_QUEUED_JOBS: "-1" })).toThrow(ConfigError);
  });

  it("空串环境变量视为未设置（用默认值）", () => {
    const c = loadConfig({ COMFYUI_URL: "" });
    expect(c.comfyUiUrl).toBe("http://127.0.0.1:8188");
  });

  it("返回深冻结对象", () => {
    const c = loadConfig({}) as { maxInFlight: number };
    expect(() => (c.maxInFlight = 99)).toThrow();
  });
});
