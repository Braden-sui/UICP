#!/usr/bin/env node
// Verify modules integrity and signatures.
// - Ensures each manifest entry exists and matches sha256 digest
// - When STRICT_MODULES_VERIFY is enabled, verifies Ed25519 signatures against a trust store
// - Trust store provided via UICP_TRUST_STORE_JSON (object of keyid -> pubkey in base64 or hex)
// Usage: node uicp/scripts/verify-modules.mjs --manifest uicp/src-tauri/modules/manifest.json --dir uicp/src-tauri/modules

import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';
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

function envBool(name, def = false) {
  const v = process.env[name];
  if (!v) return def;
  const s = String(v).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

function decodeB64OrHex(s) {
  if (!s || typeof s !== 'string') return null;
  try {
    return Buffer.from(s, 'base64');
  } catch {}
  try {
    return Buffer.from(s.replace(/^0x/, ''), 'hex');
  } catch {}
  return null;
}

function loadTrustStore() {
  const raw = process.env['UICP_TRUST_STORE_JSON'];
  if (!raw) return null;
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Invalid UICP_TRUST_STORE_JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const map = new Map();
  for (const [keyid, val] of Object.entries(obj)) {
    const buf = decodeB64OrHex(String(val));
    if (!buf || buf.length !== 32) {
      throw new Error(`Trust store entry ${keyid} must be 32-byte Ed25519 pubkey (base64 or hex)`);
    }
    map.set(keyid, buf);
  }
  return map;
}

function buildMessage(task, version, digestHex) {
  const digest = Buffer.from(digestHex, 'hex');
  if (digest.length !== 32) throw new Error('digest must be 32 bytes hex');
  const parts = [
    Buffer.from('UICP-MODULE\x00', 'latin1'),
    Buffer.from('task='),
    Buffer.from(task),
    Buffer.from([0]),
    Buffer.from('version='),
    Buffer.from(version),
    Buffer.from([0]),
    Buffer.from('sha256='),
    digest,
  ];
  return Buffer.concat(parts);
}

// Convert raw 32-byte Ed25519 public key to SPKI DER (RFC 8410)
function ed25519SpkiFromRaw(raw32) {
  const prefix = Buffer.from('302a300506032b6570032100', 'hex');
  return Buffer.concat([prefix, raw32]);
}

function requirePubkeyForEntry(entry, trust) {
  if (entry.keyid && trust) {
    const key = trust.get(entry.keyid);
    if (!key) throw new Error(`Trust store has no pubkey for keyid ${entry.keyid}`);
    return key;
  }
  if (entry.keyid && !trust) {
    throw new Error(`STRICT_MODULES_VERIFY: UICP_TRUST_STORE_JSON required for keyid ${entry.keyid}`);
  }
  // Fallback single-key mode for entries without keyid
  const single = process.env['UICP_MODULES_PUBKEY'];
  if (!single) throw new Error('STRICT_MODULES_VERIFY requires UICP_MODULES_PUBKEY or trust store');
  const buf = decodeB64OrHex(single);
  if (!buf || buf.length !== 32) throw new Error('UICP_MODULES_PUBKEY must be 32 bytes (base64 or hex)');
  return buf;
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
  const strict = envBool('STRICT_MODULES_VERIFY', false);
  const trust = loadTrustStore();
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
      if (strict) {
        if (!entry.signature) {
          failures.push({ filename: entry.filename, reason: 'signature_missing' });
        } else {
          try {
            const pubRaw = requirePubkeyForEntry(entry, trust);
            const spki = ed25519SpkiFromRaw(pubRaw);
            const keyObj = createPublicKey({ key: spki, format: 'der', type: 'spki' });
            // Decode signature (base64 preferred; fallback hex)
            let sig = decodeB64OrHex(entry.signature);
            if (!sig) throw new Error('invalid signature encoding');
            const msg = buildMessage(entry.task, entry.version, hex);
            const ok = edVerify(null, msg, keyObj, sig);
            if (!ok) {
              failures.push({ filename: entry.filename, reason: 'signature_invalid' });
            }
          } catch (e) {
            failures.push({ filename: entry.filename, reason: 'signature_error', error: e instanceof Error ? e.message : String(e) });
          }
        }
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
