#!/usr/bin/env node
import { execSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
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
      join(
        repoRoot,
        'components',
        'csv.parse',
        'target',
        'wasm32-wasi',
        'release',
        'uicp_task_csv_parse.wasm',
      ),
      join(
        repoRoot,
        'components',
        'csv.parse',
        'target',
        'wasm32-wasip1',
        'release',
        'uicp_task_csv_parse.wasm',
      ),
    ],
    filename: 'csv.parse@1.2.0.wasm',
  },
  {
    name: 'table.query',
    version: '0.1.0',
    dir: join(repoRoot, 'components', 'table.query'),
    outs: [
      join(
        repoRoot,
        'components',
        'table.query',
        'target',
        'wasm32-wasi',
        'release',
        'uicp_task_table_query.wasm',
      ),
      join(
        repoRoot,
        'components',
        'table.query',
        'target',
        'wasm32-wasip1',
        'release',
        'uicp_task_table_query.wasm',
      ),
    ],
    filename: 'table.query@0.1.0.wasm',
  },
  {
    name: 'applet.quickjs',
    version: '0.1.0',
    dir: join(repoRoot, 'components', 'applet.quickjs'),
    outs: [
      join(
        repoRoot,
        'components',
        'applet.quickjs',
        'target',
        'wasm32-wasi',
        'release',
        'applet_quickjs.wasm',
      ),
      join(
        repoRoot,
        'components',
        'applet.quickjs',
        'target',
        'wasm32-wasip1',
        'release',
        'applet_quickjs.wasm',
      ),
    ],
    filename: 'applet.quickjs@0.1.0.wasm',
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

function optimizeApplet(outPath) {
  const before = statSync(outPath).size;
  const tempDir = mkdtempSync(join(tmpdir(), 'uicp-wasm-opt-'));
  const optimized = join(tempDir, 'applet_quickjs.optimized.wasm');
  try {
    const result = spawnSync(
      'wasm-opt',
      [outPath, '-Oz', '--strip-debug', '--strip-dwarf', '--vacuum', '-o', optimized],
      { stdio: 'inherit' },
    );
    if (result.error) {
      if (result.error.code === 'ENOENT') {
        throw new Error(
          'E-UICP-0701: wasm-opt binary not found on PATH; install Binaryen (https://github.com/WebAssembly/binaryen) to optimize QuickJS applet artifacts.',
        );
      }
      throw result.error;
    }
    if (typeof result.status === 'number' && result.status !== 0) {
      throw new Error(`E-UICP-0702: wasm-opt exited with status ${result.status}`);
    }
    copyFileSync(optimized, outPath);
    const after = statSync(outPath).size;
    const delta = after - before;
    const pct = before === 0 ? 0 : (delta / before) * 100;
    const signedDelta = `${delta >= 0 ? '+' : ''}${delta}`;
    const signedPct = `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}`;
    console.log(
      `[applet.quickjs] wasm-opt applied (-Oz, strip debug). size ${before}B -> ${after}B (${signedDelta}B, ${signedPct}%)`,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
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
  if (c.name === 'applet.quickjs') {
    optimizeApplet(outPath);
  }
  const manifest = join(modulesDir, 'manifest.json');
  const script = join(repoRoot, 'scripts', 'update-manifest.mjs');
  // Quote paths to handle spaces on Windows
  run(
    `node "${script}" --manifest "${manifest}" --task ${c.name} --version ${c.version} --wasm "${outPath}" --filename ${c.filename} --copy --outdir "${modulesDir}"`,
    { shell: true },
  );
}

try {
  for (const c of components) buildOne(c);
  console.log('Components built and manifest updated in', modulesDir);
  console.log('Set UICP_MODULES_DIR to override destination.');
} catch (err) {
  console.error('\nBuild failed. Ensure Rust + cargo-component are installed.');
  console.error(
    'rustup: https://rustup.rs  cargo-component: https://github.com/bytecodealliance/cargo-component',
  );
  console.error(err?.message || err);
  process.exit(1);
}
