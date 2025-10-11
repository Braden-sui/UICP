#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = resolve(fileURLToPath(import.meta.url), '..');
const repoRoot = resolve(here, '..');
const modulesDir = process.env.UICP_MODULES_DIR || join(repoRoot, 'src-tauri', 'modules');

const components = [
  {
    name: 'csv.parse',
    version: '1.2.0',
    dir: join(repoRoot, 'components', 'csv.parse'),
    outs: [
      join(repoRoot, 'components', 'csv.parse', 'target', 'wasm32-wasi', 'release', 'uicp_task_csv_parse.wasm'),
      join(repoRoot, 'components', 'csv.parse', 'target', 'wasm32-wasip1', 'release', 'uicp_task_csv_parse.wasm'),
    ],
    filename: 'csv.parse@1.2.0.wasm',
  },
  {
    name: 'table.query',
    version: '0.1.0',
    dir: join(repoRoot, 'components', 'table.query'),
    outs: [
      join(repoRoot, 'components', 'table.query', 'target', 'wasm32-wasi', 'release', 'uicp_task_table_query.wasm'),
      join(repoRoot, 'components', 'table.query', 'target', 'wasm32-wasip1', 'release', 'uicp_task_table_query.wasm'),
    ],
    filename: 'table.query@0.1.0.wasm',
  },
];

function run(cmd, opts = {}) {
  console.log(`$ ${cmd}`);
  execSync(cmd, { stdio: 'inherit', ...opts });
}

function firstExisting(paths) {
  for (const p of paths) {
    if (existsSync(p)) return p;
  }
  return null;
}

function buildOne(c) {
  try {
    run('cargo component --version', { cwd: c.dir, shell: true });
  } catch {}
  // Build the component (no unstable flags needed with cargo-component)
  run('cargo component build --release', { cwd: c.dir, shell: true });
  let outPath = firstExisting(c.outs);
  if (!outPath) {
    // Try explicit WASI-P1 target used by newer toolchains
    run('cargo component build --release --target wasm32-wasip1', { cwd: c.dir, shell: true });
    outPath = firstExisting(c.outs);
  }
  if (!outPath) throw new Error(`Failed to find built wasm at any of: \n  ${c.outs.join('\n  ')}`);
  const manifest = join(modulesDir, 'manifest.json');
  const script = join(repoRoot, 'scripts', 'update-manifest.mjs');
  // Quote paths to handle spaces on Windows
  run(
    `node "${script}" --manifest "${manifest}" --task ${c.name} --version ${c.version} --wasm "${outPath}" --filename ${c.filename} --copy --outdir "${modulesDir}"`,
    { shell: true }
  );
}

try {
  for (const c of components) buildOne(c);
  console.log('Components built and manifest updated in', modulesDir);
  console.log('Set UICP_MODULES_DIR to override destination.');
} catch (err) {
  console.error('\nBuild failed. Ensure Rust + cargo-component are installed.');
  console.error('rustup: https://rustup.rs  cargo-component: https://github.com/bytecodealliance/cargo-component');
  console.error(err?.message || err);
  process.exit(1);
}




