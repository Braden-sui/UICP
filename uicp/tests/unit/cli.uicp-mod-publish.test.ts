import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import childProcess from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/uicp-mod-publish.mjs');

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'uicp-mod-publish-'));

const removeTempDir = (dir: string) => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
};

describe('uicp-mod-publish CLI', () => {
  let tempDir: string;
  afterEach(() => {
    if (tempDir) {
      removeTempDir(tempDir);
      tempDir = '';
    }
  });

  it('copies module, updates manifest, and signs entry', () => {
    tempDir = makeTempDir();
    const wasmPath = path.join(tempDir, 'demo@1.0.0.wasm');
    const manifestPath = path.join(tempDir, 'manifest.json');
    const wasmBytes = crypto.randomBytes(256);
    fs.writeFileSync(wasmPath, wasmBytes);

    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    const privPath = path.join(tempDir, 'signing-key.pem');
    fs.writeFileSync(privPath, privPem, 'utf8');

    const keyId = 'custom-key';
    const result = childProcess.spawnSync(process.execPath, [SCRIPT_PATH, wasmPath, manifestPath, '--sign', privPath, '--keyid', keyId], {
      stdio: 'inherit',
    });
    expect(result.status).toBe(0);

    const manifestRaw = fs.readFileSync(manifestPath, 'utf8');
    const manifest = JSON.parse(manifestRaw) as { entries: Array<Record<string, unknown>> };
    expect(Array.isArray(manifest.entries)).toBe(true);
    expect(manifest.entries).toHaveLength(1);

    const [entry] = manifest.entries;
    expect(entry.filename).toBe('demo@1.0.0.wasm');
    const digestHex = crypto.createHash('sha256').update(wasmBytes).digest('hex');
    expect(entry.digest_sha256).toBe(digestHex);
    expect(entry.signature).toEqual(expect.any(String));
    expect(entry.keyid).toBe(keyId);
    expect(typeof entry.signed_at).toBe('number');

    // Verify signature matches backend message format
    const digestBytes = Buffer.from(digestHex, 'hex');
    const message = Buffer.concat([
      Buffer.from('UICP-MODULE\x00'),
      Buffer.from('task='),
      Buffer.from('demo'),
      Buffer.from([0]),
      Buffer.from('version='),
      Buffer.from('1.0.0'),
      Buffer.from([0]),
      Buffer.from('sha256='),
      digestBytes,
    ]);
    const signatureBytes = Buffer.from(entry.signature as string, 'base64');
    const verified = crypto.verify(null, message, publicKey, signatureBytes);
    expect(verified).toBe(true);

    // Ensure module file copied alongside manifest
    const copiedPath = path.join(path.dirname(manifestPath), 'demo@1.0.0.wasm');
    expect(fs.existsSync(copiedPath)).toBe(true);
    const copiedBytes = fs.readFileSync(copiedPath);
    expect(Buffer.compare(copiedBytes, wasmBytes)).toBe(0);
  });
});
