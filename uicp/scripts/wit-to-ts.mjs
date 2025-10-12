#!/usr/bin/env node
// Simple WIT→TS IO generator for task worlds used in this repo.
// Supports: record fields, list<list<string>>, option<record{...}>
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'src', 'compute', 'types.gen.ts');
const witFiles = [
  join(here, '..', '..', 'components', 'csv.parse', 'wit', 'world.wit'),
  join(here, '..', '..', 'components', 'table.query', 'wit', 'world.wit'),
];

/** Camel-case a WIT identifier (dash/underscore to camel). */
function camel(s) {
  return s.replace(/[-_]+([a-zA-Z0-9])/g, (_, c) => c.toUpperCase());
}

function pascal(s) {
  const c = camel(s);
  return c.charAt(0).toUpperCase() + c.slice(1);
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
  const body = m[1].replace(/\/\/.*$/gm, '');
  const fields = splitTopLevel(body);
  const props = [];
  for (const f of fields) {
    const line = f.trim();
    if (!line) continue;
    const mm = line.match(/([a-zA-Z0-9_\-]+)\s*:\s*([\s\S]+)/);
    if (!mm) continue;
    const name = camel(mm[1]);
    const ty = mapType(mm[2]);
    props.push(`${name}: ${ty}`);
  }
  return `{ ${props.join('; ')} }`;
}

function splitTopLevel(body) {
  const parts = [];
  let current = '';
  let depthBraces = 0;
  let depthAngles = 0;
  for (const ch of body) {
    if (ch === '{') depthBraces++;
    else if (ch === '}') depthBraces = Math.max(depthBraces - 1, 0);
    else if (ch === '<') depthAngles++;
    else if (ch === '>') depthAngles = Math.max(depthAngles - 1, 0);

    if (ch === ',' && depthBraces === 0 && depthAngles === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

async function parseTaskFile(file) {
  const text = await readFile(file, 'utf8');
  const nameMatch = text.match(/package\s+uicp:task-([a-z0-9\-]+)@([0-9.]+)/);
  if (!nameMatch) return null;
  const taskName = nameMatch[1].replace(/-/g, '.');
  const version = nameMatch[2];
  const inputMatch = text.match(/type\s+input\s*=\s*([\s\S]*?)\n\s*type\s+output/);
  const outputMatch = text.match(/type\s+output\s*=\s*([\s\S]*?)\n\s*run/);
  if (!inputMatch || !outputMatch) return null;
  const inputTy = inputMatch[1].trim();
  const outputTy = outputMatch[1].trim();
  const inputTs = mapType(inputTy);
  const outputTs = mapType(outputTy);
  return { taskName, version, inputTs, outputTs };
}

async function main() {
  const files = witFiles;
  const entries = [];
  for (const f of files) {
    const r = await parseTaskFile(f);
    if (r) entries.push(r);
  }
  let outSrc = `// Generated from WIT files. Do not edit by hand.\n`;
  for (const e of entries) {
    const base = e.taskName.replace(/\./g, '-');
    const inName = pascal(`${base}-input`);
    const outName = pascal(`${base}-output`);
    outSrc += `export type ${inName} = ${e.inputTs};\n`;
    outSrc += `export type ${outName} = ${e.outputTs};\n`;
  }
  // KnownTaskIO union
  outSrc += `\nexport type KnownTaskIO =\n`;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const base = e.taskName.replace(/\./g, '-');
    const inName = pascal(`${base}-input`);
    const outName = pascal(`${base}-output`);
    const line =
      '  | { task: `' +
      e.taskName +
      '@${string}`; input: ' +
      inName +
      '; output: ' +
      outName +
      ' }';
    outSrc += (i === 0 ? '' : '\n') + line;
  }
  outSrc += `;\n`;
  await writeFile(out, outSrc);
  console.log('Wrote', out);
}

await main();
