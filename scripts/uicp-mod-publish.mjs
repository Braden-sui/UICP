#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseArgs(argv) {
  const args = { flags: {}, positionals: [] };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a) continue;
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      const key = k.trim();
      const val = v != null ? v : argv[i + 1] && !String(argv[i + 1]).startsWith('--') ? argv[++i] : 'true';
      args.flags[key] = val;
    } else {
      args.positionals.push(a);
    }
  }
  return args;
}

async function readKeyObject(signPath) {
  const { createPrivateKey } = await import('node:crypto');
  const buf = await fs.readFile(signPath);
  // Try PEM first, then DER (pkcs8)
  const isPem = buf.includes(0x2d) && buf.toString('utf8').includes('BEGIN');
  if (isPem) {
    return createPrivateKey({ key: buf });
  }
  return createPrivateKey({ key: buf, format: 'der', type: 'pkcs8' });
}

async function main() {
  const parsed = parseArgs(process.argv);
  const [wasmPathArg, manifestPathArg] = parsed.positionals;
  if (!wasmPathArg || !manifestPathArg) {
    console.error('Usage: uicp-mod-publish <module.wasm> <manifest.json> [--sign <pkcs8.pem|der>] [--keyid <string>]');
    process.exit(1);
  }

  const wasmPath = path.resolve(wasmPathArg);
  const manifestPath = path.resolve(manifestPathArg);
  const wasmFile = await fs.readFile(wasmPath);
  const digest = crypto.createHash('sha256').update(wasmFile).digest('hex');

  const modulesDir = path.dirname(manifestPath);
  await fs.mkdir(modulesDir, { recursive: true });

  const filename = path.basename(wasmPath);
  const targetPath = path.join(modulesDir, filename);
  await fs.copyFile(wasmPath, targetPath);
  console.log(`Copied ${wasmPath} -> ${targetPath}`);

  const manifestRaw = await fs.readFile(manifestPath, 'utf8').catch(async () => {
    console.warn('Manifest missing, creating new manifest');
    await fs.writeFile(manifestPath, JSON.stringify({ entries: [] }, null, 2));
    return JSON.stringify({ entries: [] });
  });

  const manifest = JSON.parse(manifestRaw || '{"entries": []}');
  if (!Array.isArray(manifest.entries)) manifest.entries = [];

  const existingIndex = manifest.entries.findIndex((entry) => entry.filename === filename);
  const base = path.parse(filename).name;
  const [taskFromName, versionFromName] = base.includes('@') ? base.split('@', 2) : [base, '0.0.0'];
  const moduleEntry = {
    task: taskFromName,
    version: versionFromName,
    filename,
    digest_sha256: digest,
  };

  if (existingIndex >= 0) {
    manifest.entries[existingIndex] = { ...manifest.entries[existingIndex], ...moduleEntry };
  } else {
    manifest.entries.push(moduleEntry);
  }

  // Optional signing
  const signPath = parsed.flags.sign || process.env.UICP_MODULES_PRIVKEY;
  const keyid = parsed.flags.keyid || process.env.UICP_MODULES_KEYID;
  if (signPath) {
    try {
      const { sign, createPublicKey } = await import('node:crypto');
      const keyObj = await readKeyObject(path.resolve(signPath));
      // Build message: "UICP-MODULE\x00task=<task>\x00version=<version>\x00sha256=<digest_bytes>"
      const digestBytes = Buffer.from(digest, 'hex');
      const parts = [
        Buffer.from('UICP-MODULE\x00'),
        Buffer.from('task='),
        Buffer.from(moduleEntry.task),
        Buffer.from([0]),
        Buffer.from('version='),
        Buffer.from(moduleEntry.version),
        Buffer.from([0]),
        Buffer.from('sha256='),
        digestBytes,
      ];
      const message = Buffer.concat(parts);
      const sig = sign(null, message, keyObj);
      const signatureB64 = sig.toString('base64');
      moduleEntry.signature = signatureB64;
      if (keyid) moduleEntry.keyid = String(keyid);
      moduleEntry.signed_at = Math.floor(Date.now() / 1000);
      // Emit derived pubkey fingerprint for visibility when not provided
      if (!moduleEntry.keyid) {
        try {
          const pub = createPublicKey(keyObj);
          const spkiDer = pub.export({ format: 'der', type: 'spki' });
          const fp = crypto.createHash('sha256').update(spkiDer).digest('hex').slice(0, 16);
          moduleEntry.keyid = `fp:${fp}`;
        } catch {}
      }
      console.log(`Signed entry ${moduleEntry.task}@${moduleEntry.version} with keyid=${moduleEntry.keyid}`);
    } catch (err) {
      console.error('Signing failed:', err?.message || String(err));
      process.exit(1);
    }
  }

  manifest.entries.sort((a, b) => a.task.localeCompare(b.task) || a.version.localeCompare(b.version));
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Updated manifest ${manifestPath}`);
}

main().catch((error) => {
  console.error('uicp-mod-publish failed:', error);
  process.exit(1);
});
