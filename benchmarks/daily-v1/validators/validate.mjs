import { readFileSync, statSync } from 'node:fs';
import { resolve, dirname, extname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import process from 'node:process';
import console from 'node:console';

// All paths in a manifest are relative to that manifest, unless absolute.
const [kind, manifestPath] = process.argv.slice(2);
if (!['production', 'catalog'].includes(kind) || !manifestPath) {
  console.error('Usage: node validate.mjs production|catalog manifest.json');
  process.exit(2);
}
const base = dirname(resolve(manifestPath));
const path = (p) => resolve(base, p);
const json = (p) => JSON.parse(readFileSync(path(p), 'utf8'));
const digest = (p) => createHash('sha256').update(readFileSync(path(p))).digest('hex');
const errors = [];
const check = (condition, message) => { if (!condition) errors.push(message); };
const own = (obj, key) => Object.hasOwn(obj, key);
const pointer = (obj, ptr) => {
  if (ptr === '') return obj;
  if (!ptr.startsWith('/')) throw new Error(`Invalid JSON pointer: ${ptr}`);
  return ptr.slice(1).split('/').reduce((value, part) => {
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
    if (value === null || typeof value !== 'object' || !own(value, key)) throw new Error(`Missing JSON pointer: ${ptr}`);
    return value[key];
  }, obj);
};
const compareGraph = (original, submitted, allowed, current = '') => {
  if (allowed.includes(current)) return;
  if (isDeepStrictEqual(original, submitted)) return;
  if (original && submitted && typeof original === 'object' && typeof submitted === 'object'
      && Array.isArray(original) === Array.isArray(submitted)) {
    const keys = new Set([...Object.keys(original), ...Object.keys(submitted)]);
    for (const key of keys) {
      const child = `${current}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`;
      if (!own(original, key) || !own(submitted, key)) check(false, `Graph key added or removed: ${child}`);
      else compareGraph(original[key], submitted[key], allowed, child);
    }
  } else check(false, `Unallowed graph change: ${current}`);
};
const decode = (file) => {
  if (process.platform !== 'win32') return 'unavailable';
  const script = `$ErrorActionPreference = 'Stop'; try { Add-Type -AssemblyName System.Drawing } catch { exit 3 }; try { $i = [System.Drawing.Image]::FromFile($env:DAILY_IMAGE); try { $format = $i.RawFormat.Guid.ToString(); $b = New-Object System.Drawing.Bitmap $i.Width, $i.Height; try { $g = [System.Drawing.Graphics]::FromImage($b); try { $g.DrawImage($i, 0, 0, $i.Width, $i.Height) } finally { $g.Dispose() } } finally { $b.Dispose() } } finally { $i.Dispose() }; Write-Output $format; exit 0 } catch { exit 1 }`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, DAILY_IMAGE: path(file) }, encoding: 'utf8', windowsHide: true,
  });
  if (result.error || result.status === 3 || result.status === null) return 'unavailable';
  if (result.status !== 0) return 'invalid';
  const types = { 'b96b3caf-0728-11d3-9d7b-0000f81ef32e': 'png', 'b96b3cae-0728-11d3-9d7b-0000f81ef32e': 'jpeg' };
  return types[result.stdout.trim().toLowerCase()] ?? 'unavailable';
};

try {
  const manifest = json(manifestPath && resolve(manifestPath));
  if (kind === 'production') {
    const originalBytes = readFileSync(path(manifest.template_before));
    check(originalBytes.equals(readFileSync(path(manifest.template_after))), 'Template changed');
    const original = JSON.parse(originalBytes.toString('utf8'));
    const index = json(manifest.index);
    check(Array.isArray(index) && Array.isArray(manifest.expected_items), 'Index and expected_items must be arrays');
    const expected = manifest.expected_items;
    check([16, 20, 50, 100].includes(manifest.expected_count) && expected.length === manifest.expected_count, 'Expected item count must match the declared task size (16, 20, 50, or 100)');
    if (manifest.case_id === 'A2') {
      const experiment = json(manifest.experiment);
      const configs = experiment.parameter_candidates;
      const baselines = configs.filter((config) => config.baseline === true);
      const selected = configs.find((config) => config.config_id === manifest.selected_config_id);
      check(configs.length === 6 && new Set(configs.map((config) => config.config_id)).size === 6 && baselines.length === 1 && !!selected, 'A2 requires six unique configurations, one baseline, and a selected configuration');
      check(new Set(configs.map((config) => config.steps)).size === 3 && new Set(configs.map((config) => config.cfg)).size === 2 && new Set(configs.map((config) => JSON.stringify([config.steps, config.cfg]))).size === 6, 'A2 configurations must form a 3x2 matrix');
      check(experiment.training_seeds.length === 2 && new Set(experiment.training_seeds).size === 2 && experiment.validation_seeds.length === 2 && new Set(experiment.validation_seeds).size === 2 && experiment.validation_seeds.every((seed) => !experiment.training_seeds.includes(seed)), 'A2 requires two distinct training and two independent validation seeds');
      check(manifest.expected_count === 16, 'A2 requires 16 expected items');
      if (baselines.length === 1 && selected) {
        const matrix = [];
        for (const config of configs) for (const seed of experiment.training_seeds) matrix.push({ phase: 'training', config, seed });
        for (const [phase, config] of [['validation_baseline', baselines[0]], ['validation_candidate', selected]]) {
          for (const seed of experiment.validation_seeds) matrix.push({ phase, config, seed });
        }
        for (const row of matrix) {
          const matches = expected.filter((item) => item.phase === row.phase && item.config_id === row.config.config_id && item.seed === row.seed && item.params?.steps === row.config.steps && item.params?.cfg === row.config.cfg && item.params?.prompt === experiment.fixed_prompt);
          check(matches.length === 1, `A2 matrix mismatch: ${row.phase} ${row.config.config_id} ${row.seed}`);
        }
      }
    }
    check(Array.isArray(manifest.allowed_fields) && manifest.allowed_fields.length > 0 && new Set(manifest.allowed_fields).size === manifest.allowed_fields.length, 'Allowed fields must be a nonempty unique pointer list');
    for (const field of manifest.allowed_fields) {
      const value = pointer(original, field);
      check(value === null || typeof value !== 'object', `Allowed field must address a scalar: ${field}`);
    }
    const ids = new Set(expected.map((item) => item.item_id));
    check(ids.size === expected.length && !ids.has(undefined), 'Expected item IDs must be unique and present');
    check(index.length === expected.length, 'Index item count differs from expected');
    const observed = new Set();
    const handles = new Set();
    const outputs = new Set();
    for (const item of index) {
      check(!observed.has(item.item_id), `Duplicate item: ${item.item_id}`);
      observed.add(item.item_id);
      const target = expected.find((entry) => entry.item_id === item.item_id);
      if (!target) { check(false, `Unexpected item: ${item.item_id}`); continue; }
      check(isDeepStrictEqual(item.params, target.params) && item.seed === target.seed, `Parameters or seed mismatch: ${item.item_id}`);
      check(typeof item.prompt_id === 'string' && item.prompt_id.length > 0 && !handles.has(item.prompt_id), `Missing or duplicate prompt_id: ${item.item_id}`);
      handles.add(item.prompt_id);
      check(item.status === 'succeeded', `Item not succeeded: ${item.item_id}`);
      const graph = json(item.submitted_graph);
      compareGraph(original, graph, manifest.allowed_fields);
      check(Object.keys(target.graph_values).length === manifest.allowed_fields.length && manifest.allowed_fields.every((field) => own(target.graph_values, field)), `Expected graph values must cover allowed fields: ${item.item_id}`);
      for (const [field, value] of Object.entries(target.graph_values)) {
        check(manifest.allowed_fields.includes(field), `Expected field is not allowed: ${field}`);
        check(isDeepStrictEqual(pointer(graph, field), value), `Submitted value mismatch: ${item.item_id} ${field}`);
      }
      check(typeof item.output_path === 'string' && !outputs.has(path(item.output_path)), `Missing or duplicate output: ${item.item_id}`);
      outputs.add(path(item.output_path));
      const size = statSync(path(item.output_path)).size;
      check(size > 0 && size === item.file_size, `Output size mismatch: ${item.item_id}`);
      check(typeof item.file_type === 'string' && item.file_type.toLowerCase() === extname(item.output_path).slice(1).toLowerCase(), `Output type mismatch: ${item.item_id}`);
      const result = decode(item.output_path);
      const type = item.file_type.toLowerCase().replace(/^jpg$/, 'jpeg');
      check(result === type, `Output decode/type ${result}, expected ${type}: ${item.item_id}`);
    }
    for (const id of ids) check(observed.has(id), `Missing item: ${id}`);
    let duplicateExecutions = null;
    let followupPosts = null;
    if (manifest.observer) {
      const observer = json(manifest.observer);
      if (observer.complete === true && Array.isArray(observer.execution_starts)
          && observer.execution_starts.every((event) => ids.has(event.item_id) && typeof event.prompt_id === 'string' && event.prompt_id)) {
        const counts = new Map();
        for (const event of observer.execution_starts) counts.set(event.item_id, (counts.get(event.item_id) ?? 0) + 1);
        duplicateExecutions = [...counts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);
        for (const item of index) check(observer.execution_starts.some((event) => event.item_id === item.item_id && event.prompt_id === item.prompt_id), `Missing observed execution: ${item.item_id}`);
        check(duplicateExecutions === 0, 'Duplicate executions observed');
      }
      if (observer.followup_complete === true && Number.isInteger(observer.followup_post_count) && observer.followup_post_count >= 0) followupPosts = observer.followup_post_count;
    }
    if (duplicateExecutions === null) errors.push('Duplicate executions unavailable: complete observer evidence is required');
    if (manifest.require_followup === true) check(followupPosts === 0, 'Follow-up POST count is nonzero or unavailable');
    console.log(JSON.stringify({ status: errors.length ? 'not_passed' : 'machine_checks_passed', duplicate_executions: duplicateExecutions, followup_posts: followupPosts, errors }, null, 2));
  } else {
    const truth = json(manifest.ground_truth);
    const catalog = json(manifest.catalog);
    check(Array.isArray(truth) && truth.length === 20 && Array.isArray(catalog), 'Expected 20 original records and an array catalog');
    const originals = new Set();
    const mappings = new Set();
    for (const source of truth) {
      check(!originals.has(source.old_path), `Duplicate ground truth path: ${source.old_path}`);
      originals.add(source.old_path);
      const matches = catalog.filter((entry) => entry.old_path === source.old_path);
      check(matches.length === 1, `Expected exactly one mapping: ${source.old_path}`);
      if (matches.length !== 1) continue;
      const entry = matches[0];
      check(typeof entry.new_path === 'string' && !mappings.has(path(entry.new_path)), `Missing or shared mapping: ${source.old_path}`);
      mappings.add(path(entry.new_path));
      check(digest(entry.new_path) === source.sha256, `Original bytes not preserved: ${source.old_path}`);
      check(isDeepStrictEqual(entry.classification, source.classification) && isDeepStrictEqual(entry.group, source.group), `Classification or group mismatch: ${source.old_path}`);
      check(entry.disposition === source.disposition, `Disposition mismatch: ${source.old_path}`);
      for (const field of ['purpose', 'inputs', 'outputs', 'dependencies', 'parameters', 'source']) {
        check(own(entry, field) && entry[field] !== null && entry[field] !== '', `Missing ${field}: ${source.old_path}`);
      }
      check(['unverified', 'static_validated', 'run_validated'].includes(entry.validation_status), `Invalid validation status: ${source.old_path}`);
      if (entry.validation_status === 'run_validated') check(typeof entry.run_evidence === 'string' && statSync(path(entry.run_evidence)).isFile(), `Run evidence missing: ${source.old_path}`);
      if (entry.validation_status === 'static_validated') check(typeof entry.static_evidence === 'string' && statSync(path(entry.static_evidence)).isFile(), `Static evidence missing: ${source.old_path}`);
    }
    for (const entry of catalog) check(originals.has(entry.old_path), `Unexpected original mapping: ${entry.old_path}`);
    console.log(JSON.stringify({ status: errors.length ? 'not_passed' : 'machine_checks_passed', errors }, null, 2));
  }
  process.exitCode = errors.length ? 1 : 0;
} catch (error) {
  console.error(JSON.stringify({ status: 'invalid_evidence', error: error.message }, null, 2));
  process.exitCode = 2;
}
