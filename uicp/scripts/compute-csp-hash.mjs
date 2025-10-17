#!/usr/bin/env node
import { createHash } from 'crypto';
import { readFileSync } from 'fs';

// Extract inline <style> content from index.html
const html = readFileSync('index.html', 'utf-8');
const match = html.match(/<style>([\s\S]*?)<\/style>/);

if (!match) {
  console.error('No <style> tag found in index.html');
  process.exit(1);
}

const styleContent = match[1];
const hash = createHash('sha256').update(styleContent).digest('base64');
const cspHash = `'sha256-${hash}'`;

console.log('\n=== CSP Hash for inline <style> ===');
console.log(cspHash);
console.log('\nAdd to tauri.conf.json production CSP:');
console.log(`"style-src 'self' ${cspHash};"`);
console.log('\nStyle content length:', styleContent.length, 'bytes\n');
