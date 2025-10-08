#!/usr/bin/env node
// Simple WIT→TS IO generator for task worlds used in this repo.
// Supports: record fields, list<list<string>>, option<record{...}>
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const witDir = join(here, '..', 'docs', 'wit', 'tasks');
const out = join(here, '..', 'src', 'compute', 'types.gen.ts');

/** Camel-case a WIT identifier (dash/underscore to camel). */
function camel(s) {
  return s.replace(/[-_]+([a-zA-Z0-9])/g, (_, c) => c.toUpperCase());
}

/** Map WIT type to TS type (limited to shapes used here). */
function mapType(ty) {
  ty = ty.trim();
  if (ty === 'string') return 'string';
  if (ty === 'bool') return 'boolean';
  if (ty === 'u32') return 'number';
  if (ty.startsWith('list<list<string>>')) return 'string[][]';
  if (ty.startsWith('list<string>')) return 'string[]';
  if (ty.startsWith('list<u32>')) return 'number[]';
  if (/^record\s*\{/.test(ty)) return parseRecord(ty);
  if (/^option<record\s*\{/.test(ty) || /^option<\s*record/.test(ty)) {
    const inner = ty.replace(/^option<\s*/, '').replace(/>\s*$/, '');
    const rec = parseRecord(inner);
    return `${rec} | null`;
  }
  return 'unknown';
}

/** Parse a WIT record { a: t, b: t } into TS type literal. */
function parseRecord(src) {
  const m = src.match(/record\s*\{([\s\S]*)\}/);
  if (!m) return 'unknown';
  const body = m[1];
  const fields = body.split(',').map((s) => s.trim()).filter(Boolean);
  const props = [];
  for (const f of fields) {
    const mm = f.match(/([a-zA-Z0-9_\-]+)\s*:\s*([\s\S]+)/);
    if (!mm) continue;
    const name = camel(mm[1]);
    const ty = mapType(mm[2]);
    props.push(`${name}: ${ty}`);
  }
  return `{ ${props.join('; ')} }`;
}

async function parseTaskFile(file) {
  const text = await readFile(file, 'utf8');
  const nameMatch = text.match(/package\s+uicp:task-([a-z0-9\-]+)@([0-9.]+)/);
  if (!nameMatch) return null;
  const taskName = nameMatch[1].replace(/-/g, '.');
  const version = nameMatch[2];
  const inputMatch = text.match(/type\s+input\s*=\s*([\s\S]*?)\n/);
  const outputMatch = text.match(/type\s+output\s*=\s*([\s\S]*?)\n/);
  if (!inputMatch || !outputMatch) return null;
  const inputTy = inputMatch[1].trim();
  const outputTy = outputMatch[1].trim();
  const inputTs = mapType(inputTy);
  const outputTs = mapType(outputTy);
  return { taskName, version, inputTs, outputTs };
}

async function main() {
  const files = [
    join(witDir, 'uicp-task-csv-parse@1.2.0.wit'),
    join(witDir, 'uicp-task-table-query@0.1.0.wit'),
  ];
  const entries = [];
  for (const f of files) {
    const r = await parseTaskFile(f);
    if (r) entries.push(r);
  }
  let outSrc = `// Generated from WIT files. Do not edit by hand.\n`;
  for (const e of entries) {
    const inName = camel(`${e.taskName.replace(/\./g, '-')}-input`);
    const outName = camel(`${e.taskName.replace(/\./g, '-')}-output`);
    outSrc += `export type ${inName} = ${e.inputTs};\n`;
    outSrc += `export type ${outName} = ${e.outputTs};\n`;
  }
  // KnownTaskIO union
  outSrc += `\nexport type KnownTaskIO =\n`;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const inName = camel(`${e.taskName.replace(/\./g, '-')}-input`);
    const outName = camel(`${e.taskName.replace(/\./g, '-')}-output`);
    const line = `  | { task: \`${e.taskName}@\${'string'}\`; input: ${inName}; output: ${outName} }`;
    outSrc += (i === 0 ? '' : '\n') + line;
  }
  outSrc += `;\n`;
  await writeFile(out, outSrc);
  console.log('Wrote', out);
}

await main();
