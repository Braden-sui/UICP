#!/usr/bin/env node
// Update a module manifest entry with the sha256 digest of a built wasm and optional copy.
// Usage:
//   node scripts/update-manifest.mjs \
//     --manifest uicp/src-tauri/modules/manifest.json \
//     --task csv.parse --version 1.2.0 \
//     --wasm path/to/csv.parse@1.2.0.wasm \
//     --filename csv.parse@1.2.0.wasm \
//     --copy --outdir uicp/src-tauri/modules

import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, cp } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    args[key] = val;
  }
  return args;
}

function sha256hex(buf) {
  const h = createHash('sha256');
  h.update(buf);
  return h.digest('hex');
}

async function main() {
  const args = parseArgs(process.argv);
  const { manifest, task, version, wasm } = args;
  const filename = args.filename || basename(wasm);
  const doCopy = args.copy === true || args.copy === 'true';
  const outdir = args.outdir || dirname(manifest);
  if (!manifest || !task || !version || !wasm) {
    console.error('Required: --manifest <path> --task <name> --version <semver> --wasm <path>');
    process.exit(1);
  }
  const wasmBytes = await readFile(wasm);
  const digest = sha256hex(wasmBytes);
  const text = await readFile(manifest, 'utf8').catch(async (e) => {
    if (e.code === 'ENOENT') {
      await mkdir(dirname(manifest), { recursive: true });
      await writeFile(manifest, JSON.stringify({ entries: [] }, null, 2) + '\n');
      return readFile(manifest, 'utf8');
    }
    throw e;
  });
  const json = JSON.parse(text);
  json.entries ||= [];
  let entry = json.entries.find((e) => e.task === task && e.version === version);
  if (!entry) {
    entry = { task, version, filename, digest_sha256: digest };
    json.entries.push(entry);
  }
  entry.filename = filename;
  entry.digest_sha256 = digest;
  if (doCopy) {
    await mkdir(outdir, { recursive: true });
    await cp(wasm, join(outdir, filename));
  }
  await writeFile(manifest, JSON.stringify(json, null, 2) + '\n');
  console.log(`Updated ${manifest} → ${task}@${version}`);
  console.log(`  filename: ${filename}`);
  console.log(`  digest_sha256: ${digest}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

