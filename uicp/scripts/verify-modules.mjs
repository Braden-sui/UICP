#!/usr/bin/env node
// Verify that every manifest entry exists and matches its sha256 digest.
// Usage: node scripts/verify-modules.mjs --manifest uicp/src-tauri/modules/manifest.json --dir uicp/src-tauri/modules

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';

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
  const { manifest, dir } = parseArgs(process.argv);
  if (!manifest) {
    console.error('Missing --manifest <path>');
    process.exit(2);
  }
  const baseDir = dir || dirname(manifest);
  const text = await readFile(manifest, 'utf8');
  const json = JSON.parse(text);
  const failures = [];
  for (const entry of json.entries || []) {
    const p = join(baseDir, entry.filename);
    try {
      const buf = await readFile(p);
      const hex = sha256hex(buf);
      if (
        !entry.digest_sha256 ||
        !entry.digest_sha256.toLowerCase ||
        entry.digest_sha256.toLowerCase() !== hex
      ) {
        failures.push({
          filename: entry.filename,
          reason: 'digest_mismatch',
          expected: entry.digest_sha256,
          actual: hex,
        });
      }
    } catch (err) {
      failures.push({ filename: entry.filename, reason: 'missing', error: String(err) });
    }
  }
  if (failures.length) {
    console.error('Module verification failed:', failures);
    process.exit(1);
  }
  console.log('Module verification OK:', (json.entries || []).length, 'entries');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
