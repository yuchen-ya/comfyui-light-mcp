// Reuse the existing metadata whitelist. Raw rollouts and private paths never enter the public output.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const [sessionDirectory, parentId, privateDirectory, publicOutput] = process.argv.slice(2);
if (!publicOutput) throw new Error("Usage: node scripts/task007-collect-usage.mjs SESSION_DIR PARENT_ID PRIVATE_DIR PUBLIC_OUTPUT");
const source = await readFile("benchmarks/daily-v1/observers/collect-host-usage.mjs", "utf8");
const selection = "pilot_|preflight$|task_materials$|validators$";
if (!source.includes(selection)) throw new Error("Unexpected metadata collector");
await mkdir(privateDirectory, { recursive: true });
const collector = path.resolve(privateDirectory, "usage-collector.mjs");
const raw = path.resolve(privateDirectory, "host-usage.json");
await writeFile(collector, source.replace(selection, "task007_(old|new)$"));
execFileSync(process.execPath, [collector, sessionDirectory, parentId, raw], { windowsHide: true });
const usage = JSON.parse(await readFile(raw, "utf8"));
const calls = JSON.parse(await readFile(path.join(privateDirectory, "calls-summary.json"), "utf8"));
const verification = JSON.parse(await readFile(path.join(privateDirectory, "verification.json"), "utf8"));
const arms = usage.sessions.filter(row => ["task007_old", "task007_new"].includes(row.run_label)).map(row => {
  if (!row.boundaries.some(item => item.type === "task_complete")) throw new Error("Agent session is incomplete");
  const arm = row.run_label.slice("task007_".length);
  const last = row.totals;
  const peak = key => Math.max(...row.request_records.map(item => item.request[key]));
  return {
    arm, model: row.contexts[0].model, effort: row.contexts[0].effort,
    mcp_tools_call: calls[arm].calls.length,
    mcp_calls_by_tool: Object.fromEntries([...new Set(calls[arm].calls)].map(name => [name, calls[arm].calls.filter(value => value === name).length])),
    backend_calls: calls[arm].backend_calls,
    host_model_request_records: row.model_request_records,
    cumulative: { input: last.input_tokens, cached_input: last.cached_input_tokens, uncached_input: last.input_tokens - last.cached_input_tokens, output: last.output_tokens },
    peak_request: { input: peak("input_tokens"), cached_input: peak("cached_input_tokens"),
      uncached_input: Math.max(...row.request_records.map(item => item.request.input_tokens - item.request.cached_input_tokens)), output: peak("output_tokens") },
    request_sums_match_cumulative: row.request_sums_match_cumulative,
    host_tool_invocations: row.host_tool_invocations
  };
}).sort((a, b) => a.arm.localeCompare(b.arm));
if (arms.length !== 2) throw new Error("Expected two completed agent sessions");
const report = {
  task: "Task007 result retrieval only", date: "2026-11-09", source: "host_reported_token_count",
  configuration: "Two fresh gpt-6.1-terra/high agents, same neutral task and generic file/script tools; independent copies of the same existing 20-job batch.",
  comparison: "Frozen legacy MCP schema/instructions at 6ca3b2a versus current index interface; both use the compatible current Engine. No generation or live ComfyUI connection.",
  limitations: ["One local pair; no inference about total workflow tokens, fees or quality.", "Host request records and usage are telemetry, not a billing statement.", "Downstream file reads, verification and coordination messages remain included in each agent's usage.", "Cached input is a subset of input; per-field peak values may belong to different requests.", "Bridge initialize and tools/list happen once per arm outside tools/call counts."],
  verification, arms
};
await mkdir(path.dirname(path.resolve(publicOutput)), { recursive: true });
await writeFile(publicOutput, JSON.stringify(report, null, 2) + "\n");
process.stdout.write(JSON.stringify(arms) + "\n");
