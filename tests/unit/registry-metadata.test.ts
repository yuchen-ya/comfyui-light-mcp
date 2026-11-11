import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { loadConfig } from "../../src/config.js";

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
const server = JSON.parse(readFileSync(new URL("../../server.json", import.meta.url), "utf8"));
const entry = server.packages[0];

describe("Registry metadata and Magpie installation contract", () => {
  it("keeps the npm, executable, Registry identity and exact version in sync", () => {
    expect(server.$schema).toBe("https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json");
    expect(server.name).toBe(pkg.mcpName);
    expect(server.name).toBe("io.github.yuchen-ya/comfyui-light-mcp");
    expect(server.description.length).toBeLessThanOrEqual(100);
    expect(server.version).toBe(pkg.version);
    expect(entry).toMatchObject({ registryType: "npm", registryBaseUrl: "https://registry.npmjs.org", identifier: pkg.name, version: pkg.version, runtimeHint: "npx", transport: { type: "stdio" } });
    expect(pkg.bin).toEqual({ "comfyui-light-mcp": "dist/index.js" });
    expect(entry.runtimeArguments).toEqual([{ type: "named", name: "--package", value: `${pkg.name}@${pkg.version}` }]);
    expect(server._meta).toBeUndefined();
  });

  it("asks for four explicit installation values without fixed credentials or paths", () => {
    const required = entry.environmentVariables.filter((variable: { isRequired?: boolean }) => variable.isRequired);
    expect(required.map((variable: { name: string }) => variable.name)).toEqual(["COMFYUI_URL", "WORKFLOWS_DIR", "DATA_DIR", "OUTPUT_DIR"]);
    for (const variable of required) {
      expect(variable.value).toBeUndefined();
      expect(variable.default).toBeUndefined();
      expect(variable.isSecret).not.toBe(true);
    }
    expect(required.slice(1).every((variable: { format: string }) => variable.format === "filepath")).toBe(true);
  });

  it("documents optional defaults from the application instead of relying on host injection", () => {
    const defaults = loadConfig({});
    const optional = Object.fromEntries(entry.environmentVariables.filter((variable: { isRequired?: boolean }) => !variable.isRequired)
      .map((variable: { name: string; default: string }) => [variable.name, variable.default]));
    expect(optional).toEqual({ AUTO_SAVE_OUTPUTS: String(defaults.autoSaveOutputs), MAX_IN_FLIGHT: String(defaults.maxInFlight), MAX_QUEUED_JOBS: String(defaults.maxQueuedJobs), JOB_TIMEOUT_MS: String(defaults.jobTimeoutMs) });
    expect(pkg.files).toEqual(expect.arrayContaining(["server.json", "docs/magpie.md", "docs/magpie.zh-CN.md"]));
    expect(pkg.files.some((file: string) => file.includes(".analysis"))).toBe(false);
  });
});
