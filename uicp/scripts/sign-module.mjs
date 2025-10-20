#!/usr/bin/env node
// Sign a manifest entry with the Ed25519 seed in UICP_MODULES_SIGNING_SEED.
// Usage:
//   node scripts/sign-module.mjs \
//     --manifest uicp/src-tauri/modules/manifest.json \
//     --task applet.quickjs --version 0.1.0 \
//     [--keyid dev-seed]

import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { Buffer } from "node:buffer";
import { sign } from "@noble/ed25519";

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function loadSigningSeed(args) {
  const seedB64 = args.seed || process.env.UICP_MODULES_SIGNING_SEED;
  if (!seedB64) {
    console.error(
      "Missing signing seed. Provide --seed <base64> or set UICP_MODULES_SIGNING_SEED."
    );
    process.exit(2);
  }
  const seed = Buffer.from(seedB64.trim(), "base64");
  if (seed.length !== 32) {
    console.error(
      `Signing seed must decode to 32 bytes (got ${seed.length}). Check the base64 value.`
    );
    process.exit(2);
  }
  return seed;
}

function canonicalMessage(task, version, digestHex) {
  if (!/^[0-9a-f]{64}$/i.test(digestHex)) {
    throw new Error(
      `digest_sha256 must be 64 hex characters (got ${digestHex.length})`
    );
  }
  const digest = Buffer.from(digestHex, "hex");
  return Buffer.concat([
    Buffer.from("UICP-MODULE\0", "utf8"),
    Buffer.from(`task=${task}`, "utf8"),
    Buffer.from([0]),
    Buffer.from(`version=${version}`, "utf8"),
    Buffer.from([0]),
    Buffer.from("sha256=", "utf8"),
    digest,
  ]);
}

async function main() {
  const args = parseArgs(process.argv);
  const manifestPath = args.manifest;
  const task = args.task;
  const version = args.version;
  const keyid = args.keyid || "dev-seed";

  if (!manifestPath || !task || !version) {
    console.error(
      "Usage: node scripts/sign-module.mjs --manifest <path> --task <task> --version <version> [--keyid <id>]"
    );
    process.exit(1);
  }

  const seed = loadSigningSeed(args);
  const text = await readFile(manifestPath, "utf8");
  const manifest = JSON.parse(text);
  const entries = manifest.entries ?? [];
  const entry = entries.find(
    (e) => e.task === task && e.version === version
  );
  if (!entry) {
    console.error(
      `Manifest ${basename(manifestPath)} has no entry for ${task}@${version}`
    );
    process.exit(1);
  }
  if (!entry.digest_sha256) {
    console.error(
      `Manifest entry ${task}@${version} is missing digest_sha256`
    );
    process.exit(1);
  }

  const message = canonicalMessage(task, version, entry.digest_sha256);
  const signatureBytes = await sign(message, seed);
  const signatureB64 = Buffer.from(signatureBytes).toString("base64");

  entry.signature = signatureB64;
  entry.keyid = keyid;
  entry.signed_at = Math.floor(Date.now() / 1000);

  await writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8"
  );

  console.log(
    `Signed ${task}@${version} in ${manifestPath} (keyid=${keyid})`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
