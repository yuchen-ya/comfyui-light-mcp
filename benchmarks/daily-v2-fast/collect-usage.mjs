// Reuse the v1 metadata whitelist without changing its frozen pilot implementation.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const source = await readFile(path.resolve(here, '../daily-v1/observers/collect-host-usage.mjs'), 'utf8');
const selection = 'pilot_|preflight$|task_materials$|validators$';
if (!source.includes(selection)) throw new Error('Unexpected frozen metadata collector');
const directory = path.join(root, '.analysis/daily-v2-fast');
await mkdir(directory, { recursive: true });
const script = path.join(directory, 'usage-collector.mjs');
await writeFile(script, source.replace(selection, 'fast_'));
const result = spawnSync(process.execPath, [script, ...process.argv.slice(2)], { stdio: 'inherit', windowsHide: true });
process.exitCode = result.status ?? 1;
