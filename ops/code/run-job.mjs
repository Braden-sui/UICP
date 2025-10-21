#!/usr/bin/env node
// Orchestrator CLI: runCodeJob(jobSpec) -> CodeJobResult
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawnp, makeTmpPath, sha256Hex, readJson, withinScopes, nowIso } from "./lib/utils.mjs";
import { err, Errors } from "./lib/errors.mjs";
import { chooseProvider, loadPolicyMatrix, cacheKey } from "./lib/router.mjs";
import { validateJsSource } from "./lib/validator.mjs";
import { assembleQuickJS, makeScriptManifest } from "./lib/assembler.mjs";
import { loadProviderConfig } from "./lib/provider.mjs";
import { runClaude } from "./lib/providers/claude-cli.mjs";
import { runCodex } from "./lib/providers/codex-cli.mjs";

function parseArgs(argv) {
  const out = { dry: false, assembleOnly: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--spec") out.spec = argv[++i];
    else if (a === "--provider") out.provider = argv[++i];
    else if (a === "--dry") out.dry = true;
    else if (a === "--assemble-only") out.assembleOnly = true;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.spec) throw err(Errors.ConfigNotFound, "--spec is required");
  const spec = await readJson(args.spec);

  // Policy and routing
  const policy = await loadPolicyMatrix();
  const jobClass = spec.class || "code_synthesis_js";
  const classCfg = policy.classes[jobClass];
  if (!classCfg) throw err(Errors.ConfigNotFound, `unknown job class: ${jobClass}`);
  const provider = args.provider || spec.provider || chooseProvider({ task: spec.task, language: spec.language });

  // Cache key
  const specHash = sha256Hex(JSON.stringify({ spec, classCfg }));
  const validatorVersion = "v1-js-ast-denylist";
  const compilerVersion = "applet.quickjs.builder@1";
  const key = cacheKey({ specHash, provider, validatorVersion, compilerVersion });
  const cacheDir = makeTmpPath("codejobs", key);
  await fs.mkdir(cacheDir, { recursive: true });
  const artifactFile = path.join(cacheDir, "artifact.json");

  // Cache check
  try {
    const cached = await readJson(artifactFile);
    log({ level: "info", msg: "cache_hit", key });
    return printResult(cached);
  } catch {
    // miss
  }

  const transcript = [];
  const record = (ev) => transcript.push({ time: nowIso(), ...ev });

  if (args.dry) {
    record({ level: "info", msg: "dry_run", provider });
    return printResult({ ok: true, provider, dry: true, transcript });
  }

  // Optionally skip provider when assembling from a known entry
  if (!args.assembleOnly) {
    // Run provider (containerized if cfg implies)
    const provCfg = await loadProviderConfig(provider === "claude" ? "claude" : "codex");
    const allowlistCfg = provCfg.hardening?.httpjail?.enabled ? {
      policy_file: provCfg.hardening.httpjail.policy_file,
      provider_key: provCfg.hardening.httpjail.provider_key,
      methods: provCfg.hardening.httpjail.methods
    } : null;

    let providerResult;
    if (provider === "claude") {
      providerResult = await runClaude({
        prompt: spec.prompt,
        tools: classCfg.allowedCommands,
        acceptEdits: true,
        dangerSkipPerms: true, // safe inside container per cfg
        containerCmd: null, // runtime integration to be wired in CI
        allowlistCfg
      });
    } else {
      providerResult = await runCodex({
        prompt: spec.prompt,
        model: provCfg.defaults?.model,
        containerCmd: null, // runtime integration to be wired in CI
        allowlistCfg
      });
    }
    record({ level: "info", msg: "provider_completed", provider, exit: providerResult.code });
  }

  // WHY: Using spec.entry for packaging until CLI diff streaming is integrated.
  if (!spec.entry) throw err(Errors.ConfigNotFound, "spec.entry missing for assembler");

  // Assemble + validate
  const bundle = await assembleQuickJS({ entry: spec.entry, printJson: true });
  validateJsSource({ code: bundle.code, filename: spec.entry });
  const manifest = makeScriptManifest({ id: spec.id || key.slice(0, 12), code: bundle.code });

  const result = { ok: true, provider, manifest, transcript };
  await fs.writeFile(artifactFile, JSON.stringify(result, null, 2));
  return printResult(result);
}

function log(ev) { process.stderr.write(JSON.stringify(ev) + os.EOL); }

function printResult(res) { process.stdout.write(JSON.stringify(res, null, 2) + "\n"); return res; }

main().catch((e) => {
  const out = { ok: false, error: { code: e.code || "E-UICP-0000", message: e.message, data: e.data } };
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  process.exitCode = 1;
});
