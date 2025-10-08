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
    out: join(repoRoot, 'components', 'csv.parse', 'target', 'wasm32-wasi', 'release', 'uicp_task_csv_parse.wasm'),
    filename: 'csv.parse@1.2.0.wasm',
  },
  {
    name: 'table.query',
    version: '0.1.0',
    dir: join(repoRoot, 'components', 'table.query'),
    out: join(repoRoot, 'components', 'table.query', 'target', 'wasm32-wasi', 'release', 'uicp_task_table_query.wasm'),
    filename: 'table.query@0.1.0.wasm',
  },
];

function run(cmd, opts = {}) {
  console.log(`$ ${cmd}`);
  execSync(cmd, { stdio: 'inherit', ...opts });
}

function buildOne(c) {
  run('cargo component --version || true', { cwd: c.dir, shell: true });
  run('cargo component build --release -Zunstable-options', { cwd: c.dir, shell: true });
  if (!existsSync(c.out)) throw new Error(`Failed to find built wasm at ${c.out}`);
  const manifest = join(modulesDir, 'manifest.json');
  const script = join(repoRoot, 'scripts', 'update-manifest.mjs');
  run(`node ${script} --manifest ${manifest} --task ${c.name} --version ${c.version} --wasm ${c.out} --filename ${c.filename} --copy --outdir ${modulesDir}`, { shell: true });
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

