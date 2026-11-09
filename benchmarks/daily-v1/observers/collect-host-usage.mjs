import { createReadStream } from 'node:fs';
import { readdir, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import process from 'node:process';
import { Buffer } from 'node:buffer';

const [sessionDirectory, parentId, outputFile] = process.argv.slice(2);
if (!sessionDirectory || !parentId || !outputFile) throw new Error('Usage: node collect-host-usage.mjs SESSION_DIR PARENT_THREAD_ID OUTPUT_FILE');
const numericUsage = value => Object.fromEntries(['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens']
  .filter(key => typeof value?.[key] === 'number').map(key => [key, value[key]]));
const sessions = [];
for (const file of (await readdir(sessionDirectory)).filter(name => name.endsWith('.jsonl'))) {
  let accepted = false;
  let metadata;
  const contexts = [];
  const requests = [];
  const hostTools = {};
  const boundaries = [];
  let argumentBytes = 0;
  let returnBytes = 0;
  let compactions = 0;
  let imageBlocks = 0;
  let previousTotal;
  let turnIndex = -1;
  const lines = createInterface({ input: createReadStream(path.join(sessionDirectory, file)), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    const row = JSON.parse(line);
    const payload = row.payload;
    if (row.type === 'session_meta') {
      const agentPath = payload.agent_path ?? payload.source?.subagent?.thread_spawn?.agent_path;
      const organizer = payload.id === parentId;
      accepted = organizer || (payload.parent_thread_id === parentId && typeof agentPath === 'string' && /^\/root\/(pilot_|preflight$|task_materials$|validators$)/.test(agentPath));
      if (!accepted) { lines.close(); break; }
      metadata = { run_label: organizer ? 'organizer_root_snapshot' : agentPath.slice('/root/'.length), client_version: payload.cli_version, provider: payload.model_provider };
    }
    if (!accepted) continue;
    if (row.type === 'turn_context') {
      turnIndex += 1;
      contexts.push({ turn_index: turnIndex, model: payload.model, effort: payload.effort });
    }
    if (row.type === 'event_msg' && payload.type === 'token_count' && payload.info?.total_token_usage) {
      const total = numericUsage(payload.info.total_token_usage);
      const current = numericUsage(payload.info.last_token_usage);
      const signature = JSON.stringify(total);
      if (signature !== previousTotal) {
        requests.push({ at: row.timestamp, turn_index: turnIndex, cumulative: total, request: current });
        previousTotal = signature;
      }
    }
    if (row.type === 'event_msg' && ['task_started', 'task_complete', 'turn_aborted'].includes(payload.type)) boundaries.push({ at: row.timestamp, type: payload.type });
    if (row.type === 'compacted') compactions += 1;
    if (row.type === 'response_item') {
      // Never export message text, reasoning, summaries, account data, or tool bodies.
      if (['function_call', 'custom_tool_call'].includes(payload.type)) {
        hostTools[payload.name] = (hostTools[payload.name] ?? 0) + 1;
        const args = payload.arguments ?? payload.input ?? '';
        argumentBytes += Buffer.byteLength(typeof args === 'string' ? args : JSON.stringify(args));
      }
      if (['function_call_output', 'custom_tool_call_output'].includes(payload.type)) {
        returnBytes += Buffer.byteLength(typeof payload.output === 'string' ? payload.output : JSON.stringify(payload.output ?? null));
      }
      if (payload.type === 'message' && Array.isArray(payload.content)) imageBlocks += payload.content.filter(block => ['input_image', 'image'].includes(block.type)).length;
    }
  }
  if (!metadata) continue;
  const last = requests.at(-1)?.cumulative ?? null;
  const sum = key => requests.reduce((total, row) => total + (row.request[key] ?? 0), 0);
  sessions.push({ ...metadata, contexts, boundaries, usage_source: last ? 'host_reported_token_count' : 'unavailable',
    totals: last, model_request_records: requests.length,
    last_usage_sums: Object.fromEntries(['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens'].map(key => [key, sum(key)])),
    request_sums_match_cumulative: last ? sum('input_tokens') === last.input_tokens && sum('output_tokens') === last.output_tokens : null,
    peak_request_input_tokens: requests.length ? Math.max(...requests.map(row => row.request.input_tokens ?? 0)) : null,
    compaction_records: compactions, visible_image_blocks: imageBlocks,
    host_tool_invocations: hostTools, host_tool_argument_utf8_bytes: argumentBytes, host_tool_return_utf8_bytes: returnBytes,
    request_records: requests,
  });
}
const result = { collected_at: new Date().toISOString(),
  source: 'Local host rollout metadata, restricted to this benchmark organizer and its selected direct child agents',
  privacy: 'Only numeric token usage, model/client settings, timing boundaries, tool names and byte counts are exported. No messages, reasoning text, tool bodies, file paths, account IDs, quotas or session IDs are copied.',
  counting: 'Deduplicate unchanged cumulative token_count snapshots. Cached input is part of input; reasoning output is part of output. Recorded last-request sums are cross-checked against cumulative totals. Host-tool byte counts measure rollout argument/output serialization, not token estimates or MCP wire bytes.',
  limitations: ['Usage is host-reported telemetry, not final billing.', 'Separate text/image token breakdown and actual injected tool-definition inventory are unavailable.', 'Organizer snapshot and preparation children are separately labeled and not attributed to either arm; the active organizer snapshot excludes subsequent reporting work.', 'Active sessions may have incomplete final usage; inspect task_complete boundaries.'],
  sessions: sessions.sort((a, b) => a.run_label.localeCompare(b.run_label)) };
await writeFile(outputFile, JSON.stringify(result, null, 2) + '\n');
process.stdout.write(JSON.stringify(sessions.map(row => ({ run_label: row.run_label, totals: row.totals, peak: row.peak_request_input_tokens, request_sums_match_cumulative: row.request_sums_match_cumulative }))) + '\n');
