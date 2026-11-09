import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

test('whitelist host usage, deduplicate snapshots, preserve nested token categories', t => {
  const directory = mkdtempSync(join(tmpdir(), 'daily-host-usage-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const usage = (input, output, cached, reasoning) => ({ input_tokens: input, output_tokens: output,
    cached_input_tokens: cached, reasoning_output_tokens: reasoning, total_tokens: input + output });
  const first = { type: 'event_msg', timestamp: 't1', payload: { type: 'token_count',
    info: { total_token_usage: usage(10, 3, 5, 1), last_token_usage: usage(10, 3, 5, 1) }, rate_limits: { private: 'DO_NOT_EXPORT' } } };
  const rows = [
    { type: 'session_meta', payload: { parent_thread_id: 'benchmark-parent', agent_path: '/root/pilot_a1_a', cli_version: 'test', creator_account_id: 'DO_NOT_EXPORT' } },
    { type: 'turn_context', payload: { model: 'test-model', effort: 'high', cwd: 'DO_NOT_EXPORT' } },
    first, first,
    { type: 'response_item', payload: { type: 'reasoning', content: 'DO_NOT_EXPORT' } },
    { type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: 'DO_NOT_EXPORT' } },
    { type: 'event_msg', timestamp: 't2', payload: { type: 'token_count', info: { total_token_usage: usage(15, 5, 8, 2), last_token_usage: usage(5, 2, 3, 1) } } },
  ];
  writeFileSync(join(directory, 'case.jsonl'), rows.map(row => JSON.stringify(row)).join('\n'));
  writeFileSync(join(directory, 'unrelated.jsonl'), JSON.stringify({ type: 'session_meta', payload: { parent_thread_id: 'other', agent_path: '/root/pilot_a1_b' } }));
  const output = join(directory, 'result.json');
  const result = spawnSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'collect-host-usage.mjs'), directory, 'benchmark-parent', output], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const raw = readFileSync(output, 'utf8');
  assert.equal(raw.includes('DO_NOT_EXPORT'), false);
  const records = JSON.parse(raw).sessions;
  assert.equal(records.length, 1);
  assert.equal(records[0].model_request_records, 2);
  assert.equal(records[0].totals.input_tokens, 15);
  assert.equal(records[0].totals.cached_input_tokens, 8);
  assert.equal(records[0].totals.output_tokens, 5);
  assert.equal(records[0].totals.reasoning_output_tokens, 2);
  assert.equal(records[0].peak_request_input_tokens, 10);
  assert.equal(records[0].request_sums_match_cumulative, true);
});
