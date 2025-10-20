#!/usr/bin/env node
/**
 * Bundle a TypeScript entry point into a single JS string suitable for the QuickJS applet runtime.
 *
 * Usage:
 *   node scripts/build-applet.mjs path/to/entry.ts --out bundle.js
 *   node scripts/build-applet.mjs path/to/entry.ts --print-json
 *
 * When --print-json is supplied, the bundled output is JSON-stringified (escaped) so it can be
 * embedded directly inside job payloads. Otherwise the raw JS (with U+2028/U+2029 escaped) is written.
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { build } from 'esbuild';

function usage() {
  console.error(`Usage: build-applet.mjs <entry.ts> [--out <file>] [--print-json]

Produces a single JS snippet that registers an applet on globalThis.__uicpApplet.
The entry module must export init/render/onEvent functions (named exports).`);
}

const args = process.argv.slice(2);
if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
  usage();
  process.exit(args.length === 0 ? 1 : 0);
}

let entry;
let outFile = null;
let printJson = false;

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (!entry && !arg.startsWith('--')) {
    entry = arg;
    continue;
  }
  if (arg === '--out') {
    if (i + 1 >= args.length) {
      console.error('--out expects a path argument');
      process.exit(1);
    }
    outFile = args[i + 1];
    i += 1;
    continue;
  }
  if (arg === '--print-json') {
    printJson = true;
    continue;
  }
  console.error(`Unknown argument: ${arg}`);
  usage();
  process.exit(1);
}

if (!entry) {
  console.error('Missing entry module path.');
  usage();
  process.exit(1);
}

const resolvedEntry = resolve(process.cwd(), entry);

const result = await build({
  entryPoints: [resolvedEntry],
  bundle: true,
  platform: 'neutral',
  target: 'es2020',
  format: 'cjs',
  minify: true,
  write: false,
  sourcemap: false,
  logLevel: 'silent',
});

if (!result.outputFiles?.length) {
  console.error('esbuild did not produce any output');
  process.exit(1);
}

const bundled = result.outputFiles[0].text;
const wrapper = `(() => {
  const exports = {};
  const module = { exports };
  ${bundled}
  const applet = module.exports?.default ?? module.exports;
  if (!applet || typeof applet !== 'object') {
    throw new Error('Applet bundle must export an object (default or module.exports).');
  }
  globalThis.__uicpApplet = applet;
})();`;

const sanitized = wrapper.replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
const output = printJson ? JSON.stringify(sanitized) : sanitized;

if (outFile) {
  writeFileSync(resolve(process.cwd(), outFile), output, 'utf8');
} else {
  process.stdout.write(output);
  if (!printJson) process.stdout.write('\n');
}
