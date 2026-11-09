import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import process from 'node:process';

const validator = join(dirname(fileURLToPath(import.meta.url)), 'validate.mjs');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aGQAAAAASUVORK5CYII=', 'base64');

function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), 'daily-validator-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const put = (name, value) => writeFileSync(join(dir, name), Buffer.isBuffer(value) ? value : JSON.stringify(value));
  const run = (kind) => {
    const result = spawnSync(process.execPath, [validator, kind, join(dir, 'manifest.json')], { encoding: 'utf8' });
    return { code: result.status, output: JSON.parse(result.stdout || result.stderr) };
  };
  return { dir, put, run };
}

function production(t) {
  const w = workspace(t);
  const expected = [];
  const index = [];
  const starts = [];
  w.put('before.json', { node: { seed: 0, fixed: 'model' } });
  w.put('after.json', { node: { seed: 0, fixed: 'model' } });
  for (let i = 0; i < 16; i++) {
    w.put(`graph-${i}.json`, { node: { seed: i, fixed: 'model' } });
    w.put(`output-${i}.png`, png);
    expected.push({ item_id: `i${i}`, params: { seed: i }, seed: i, graph_values: { '/node/seed': i } });
    index.push({ item_id: `i${i}`, params: { seed: i }, seed: i, prompt_id: `p${i}`, submitted_graph: `graph-${i}.json`, output_path: `output-${i}.png`, file_type: 'png', file_size: png.length, status: 'succeeded' });
    starts.push({ item_id: `i${i}`, prompt_id: `p${i}` });
  }
  w.put('index.json', index);
  w.put('observer.json', { complete: true, execution_starts: starts });
  w.put('manifest.json', { template_before: 'before.json', template_after: 'after.json', expected_count: 16, allowed_fields: ['/node/seed'], expected_items: expected, index: 'index.json', observer: 'observer.json' });
  return w;
}

test('production accepts only allowed graph changes and rejects corruption or missing observation', { skip: process.platform !== 'win32' }, (t) => {
  const w = production(t);
  let result = w.run('production');
  assert.equal(result.code, 0, JSON.stringify(result.output));

  w.put('graph-0.json', { node: { seed: 0, fixed: 'other model' } });
  result = w.run('production');
  assert.equal(result.code, 1);
  assert.ok(result.output.errors.some((error) => error.includes('Unallowed graph change')));
  w.put('graph-0.json', { node: { seed: 0, fixed: 'model' } });

  w.put('output-0.png', Buffer.alloc(png.length));
  result = w.run('production');
  assert.equal(result.code, 1);
  assert.ok(result.output.errors.some((error) => error.includes('Output decode/type invalid')));
  w.put('output-0.png', png);

  w.put('observer.json', { complete: false });
  result = w.run('production');
  assert.equal(result.code, 1);
  assert.equal(result.output.duplicate_executions, null);
});

test('A2 checks the frozen training and validation matrix', { skip: process.platform !== 'win32' }, (t) => {
  const w = production(t);
  const configs = Array.from({ length: 6 }, (_, i) => ({ config_id: `c${i}`, steps: 10 + Math.floor(i / 2), cfg: 2 + (i % 2), baseline: i === 0 }));
  const experiment = { parameter_candidates: configs, training_seeds: [1, 2], validation_seeds: [3, 4], fixed_prompt: 'subject' };
  const rows = [];
  for (const config of configs) for (const seed of experiment.training_seeds) rows.push({ phase: 'training', config, seed });
  for (const [phase, config] of [['validation_baseline', configs[0]], ['validation_candidate', configs[1]]]) {
    for (const seed of experiment.validation_seeds) rows.push({ phase, config, seed });
  }
  const manifest = JSON.parse(readFileSync(join(w.dir, 'manifest.json'), 'utf8'));
  const index = JSON.parse(readFileSync(join(w.dir, 'index.json'), 'utf8'));
  rows.forEach((row, i) => {
    const params = { steps: row.config.steps, cfg: row.config.cfg, prompt: 'subject' };
    Object.assign(manifest.expected_items[i], { phase: row.phase, config_id: row.config.config_id, seed: row.seed, params, graph_values: { '/node/seed': row.seed } });
    Object.assign(index[i], { seed: row.seed, params });
    w.put(`graph-${i}.json`, { node: { seed: row.seed, fixed: 'model' } });
  });
  Object.assign(manifest, { case_id: 'A2', experiment: 'experiment.json', selected_config_id: 'c1' });
  w.put('manifest.json', manifest);
  w.put('index.json', index);
  w.put('experiment.json', experiment);
  assert.equal(w.run('production').code, 0);
  manifest.expected_items[0].phase = 'validation_candidate';
  w.put('manifest.json', manifest);
  const result = w.run('production');
  assert.equal(result.code, 1);
  assert.ok(result.output.errors.some((error) => error.includes('A2 matrix mismatch')));
});

test('catalog checks all 20 retained originals against their frozen hashes', (t) => {
  const w = workspace(t);
  const truth = [];
  const catalog = [];
  for (let i = 0; i < 20; i++) {
    const name = `retained-${i}.json`;
    w.put(name, { original: i });
    const sha256 = createHash('sha256').update(readFileSync(join(w.dir, name))).digest('hex');
    truth.push({ old_path: `old-${i}`, sha256, classification: 'unique', group: { pair: `group-${i}`, relation: 'unique' }, disposition: 'keep' });
    catalog.push({ old_path: `old-${i}`, new_path: name, classification: 'unique', group: { pair: `group-${i}`, relation: 'unique' }, disposition: 'keep', purpose: 'test', inputs: [], outputs: [], dependencies: [], parameters: {}, source: 'fixture', validation_status: 'unverified' });
  }
  w.put('truth.json', truth);
  w.put('catalog.json', catalog);
  w.put('manifest.json', { ground_truth: 'truth.json', catalog: 'catalog.json' });
  assert.equal(w.run('catalog').code, 0);
  w.put('retained-0.json', { modified: true });
  const result = w.run('catalog');
  assert.equal(result.code, 1);
  assert.ok(result.output.errors.some((error) => error.includes('Original bytes not preserved: old-0')));
});
