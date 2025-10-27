#!/usr/bin/env node
/*
  Extract error codes and environment variables from the codebase and write
  JSON inventories under docs/generated/.
*/
import { promises as fs } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, 'docs', 'generated');

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.turbo', '.pnpm-store', 'target', '.cache'
]);

const SRC_EXTS = new Set(['.ts', '.tsx', '.rs']);

const ERR_RE = /E-UICP-\d{4}/g;
const VITE_ENV_RE = /\bVITE_[A-Z0-9_]+\b/g;
const BACK_ENV_RE = /\bUICP_[A-Z0-9_]+\b/g;
const STRICT_RE = /\bSTRICT_MODULES_VERIFY\b/g;

async function walk(dir, out = []) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (IGNORE_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      await walk(p, out);
    } else if (e.isFile()) {
      const ext = path.extname(e.name);
      if (SRC_EXTS.has(ext)) out.push(p);
    }
  }
  return out;
}

async function main() {
  const files = await walk(ROOT, []);
  const errors = new Set();
  const errorsByFile = {};
  const envFrontend = new Set();
  const envBackend = new Set();
  const envByFile = {};

  for (const file of files) {
    const text = await fs.readFile(file, 'utf8');
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');

    const errs = new Set(text.match(ERR_RE) || []);
    if (errs.size) {
      errorsByFile[rel] = Array.from(errs).sort();
      for (const c of errs) errors.add(c);
    }

    const viteMatches = new Set(text.match(VITE_ENV_RE) || []);
    const backMatches = new Set(text.match(BACK_ENV_RE) || []);
    const strictMatches = new Set(text.match(STRICT_RE) || []);
    const envs = new Set([...viteMatches, ...backMatches, ...strictMatches]);
    if (envs.size) {
      envByFile[rel] = Array.from(envs).sort();
      for (const v of viteMatches) envFrontend.add(v);
      for (const v of backMatches) envBackend.add(v);
      for (const v of strictMatches) envBackend.add(v);
    }
  }

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(
    path.join(OUT_DIR, 'errors.json'),
    JSON.stringify({ codes: Array.from(errors).sort(), files: errorsByFile }, null, 2) + '\n'
  );
  await fs.writeFile(
    path.join(OUT_DIR, 'envs.json'),
    JSON.stringify({ frontend: Array.from(envFrontend).sort(), backend: Array.from(envBackend).sort(), files: envByFile }, null, 2) + '\n'
  );

  console.log('Docgen complete:', {
    errorCount: errors.size,
    viteEnvCount: envFrontend.size,
    backEnvCount: envBackend.size,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

