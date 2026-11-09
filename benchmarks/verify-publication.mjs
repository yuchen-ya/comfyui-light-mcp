import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';
const base = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(await readFile(path.join(base, 'publication-manifest.json'), 'utf8'));
const declared = new Set(manifest.files.map(file => file.path));
for (const file of manifest.files) {
  const target = path.resolve(base, file.path);
  if (!target.startsWith(base + path.sep)) throw new Error('Manifest path escaped the publication directory');
  const bytes = await readFile(target);
  const sha = createHash('sha256').update(bytes).digest('hex');
  if (bytes.length !== file.bytes || sha !== file.sha256) throw new Error('Published bytes differ: ' + file.path);
}
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Unexpected link in publication');
    if (entry.isDirectory()) await walk(target);
    else {
      const relative = path.relative(base, target).replaceAll(path.sep, '/');
      if (relative !== 'publication-manifest.json' && !declared.has(relative)) throw new Error('Unlisted file: ' + relative);
    }
  }
}
await walk(base);
process.stdout.write(`Verified ${manifest.files.length} published files. This checks package integrity, not the original experiment's scientific conclusions.\n`);
