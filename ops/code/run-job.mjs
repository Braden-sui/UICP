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
import { extractApplyPatchBlocks, summarizeApplyPatch, applyWithGit } from "./lib/diff.mjs";
import { parseStreamJson, extractPatchesFromEvents, usageFromEvents } from "./lib/providers/claude.parse.mjs";
import { validateSpec } from "./lib/spec.mjs";
import { summarizeMetrics } from "./lib/metrics.mjs";
import { buildClaudeAllowedTools } from "./lib/claude-tools.mjs";

function parseArgs(argv) {
  const out = { dry: false, assembleOnly: false, container: false, apply: false, dual: false, devOverride: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--spec") out.spec = argv[++i];
    else if (a === "--provider") out.provider = argv[++i];
    else if (a === "--dry") out.dry = true;
    else if (a === "--assemble-only") out.assembleOnly = true;
    else if (a === "--container") out.container = true;
    else if (a === "--no-container") out.devOverride = true;
    else if (a === "--apply") out.apply = true;
    else if (a === "--dual" || a === "--dual-shot") out.dual = true;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.spec) throw err(Errors.ConfigNotFound, "--spec is required");
  const spec = await readJson(args.spec);
  validateSpec(spec);

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
  const transcriptFile = path.join(cacheDir, "transcript.jsonl");
  const providerRawFile = path.join(cacheDir, "provider.raw.txt");

  // Cache check
  try {
    const cached = await readJson(artifactFile);
    log({ level: "info", msg: "cache_hit", key });
    return printResult(cached);
  } catch {
    // miss
  }

  const transcript = []; const jobStarted = Date.now();
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
      methods: provCfg.hardening.httpjail.methods,
      block_post: provCfg.hardening.httpjail.block_post ?? provCfg.hardening.httpjail.blockPost
    } : null;
    const claudeTools = buildClaudeAllowedTools(classCfg.allowedCommands);

    // P1: Containerize by default when possible
    // Check if container runtime is available and no dev override is set
    let useContainer = args.container;
    if (!args.devOverride && !args.container) {
      try {
        const { detectRuntime } = await import("./lib/container.mjs");
        await detectRuntime();
        useContainer = true;
        record({ level: "info", msg: "container_default_enabled", reason: "runtime_available" });
      } catch (e) {
        useContainer = false;
        record({ level: "warn", msg: "container_default_disabled", reason: "no_runtime", error: e.message });
      }
    } else if (args.devOverride) {
      record({ level: "info", msg: "container_disabled", reason: "dev_override" });
    }

    // Dual-shot optional: run both providers with small timeout, prefer valid patches
    let providerResult;
    const containerMemory = classCfg.memoryMb || undefined;
    const smallTimeout = Math.min(120000, Math.max(30000, (classCfg.timeBudgetMs || 180000) / 3));
    if (args.dual) {
      const claudeCfg = await loadProviderConfig("claude");
      const codexCfg = await loadProviderConfig("codex");
      const claudeP = runClaude({
        prompt: spec.prompt,
        tools: claudeTools,
        acceptEdits: true,
        dangerSkipPerms: !!useContainer,
        container: !!useContainer,
        provCfg: claudeCfg,
        allowlistCfg: claudeCfg.hardening?.httpjail?.enabled ? {
          policy_file: claudeCfg.hardening.httpjail.policy_file,
          provider_key: claudeCfg.hardening.httpjail.provider_key,
          methods: claudeCfg.hardening.httpjail.methods,
          block_post: claudeCfg.hardening.httpjail.block_post ?? claudeCfg.hardening.httpjail.blockPost
        } : null,
        timeoutMs: smallTimeout,
        memoryMb: classCfg.memoryMb
      }).then(r => ({ name: "claude", r })).catch(e => ({ name: "claude", e }));
      const codexP = runCodex({
        prompt: spec.prompt,
        model: codexCfg.defaults?.model,
        container: !!useContainer,
        provCfg: codexCfg,
        allowlistCfg: codexCfg.hardening?.httpjail?.enabled ? {
          policy_file: codexCfg.hardening.httpjail.policy_file,
          provider_key: codexCfg.hardening.httpjail.provider_key,
          methods: codexCfg.hardening.httpjail.methods,
          block_post: codexCfg.hardening.httpjail.block_post ?? codexCfg.hardening.httpjail.blockPost
        } : null,
        timeoutMs: smallTimeout,
        memoryMb: classCfg.memoryMb
      }).then(r => ({ name: "codex", r })).catch(e => ({ name: "codex", e }));
      const [a, b] = await Promise.all([claudeP, codexP]);
      const evalResult = (x) => {
        if (x.e) return { ok: false, patches: 0, err: x.e };
        const stdout = x.r.stdout || "";
        let patches = extractApplyPatchBlocks(stdout).length;
        if (patches === 0 && x.name === "claude") {
          const evts = parseStreamJson(stdout);
          patches = extractPatchesFromEvents(evts).length;
        }
        return { ok: true, patches, r: x.r };
      };
      const ea = evalResult(a);
      const eb = evalResult(b);
      const winner = (ea.patches || 0) >= (eb.patches || 0) ? a : b;
      if (winner.e) throw winner.e;
      providerResult = winner.r;
      record({ level: "info", msg: "dual_shot_selected", provider: winner.name, patches: Math.max(ea.patches, eb.patches) });
    } else {
      if (provider === "claude") {
        providerResult = await runClaude({
          prompt: spec.prompt,
          tools: claudeTools,
          acceptEdits: true,
          dangerSkipPerms: !!useContainer, // safe only inside container
          container: !!useContainer,
          provCfg,
          allowlistCfg,
          timeoutMs: classCfg.timeBudgetMs,
          memoryMb: classCfg.memoryMb
        });
      } else {
        providerResult = await runCodex({
          prompt: spec.prompt,
          model: provCfg.defaults?.model,
          container: !!useContainer,
          provCfg,
          allowlistCfg,
          timeoutMs: classCfg.timeBudgetMs,
          memoryMb: classCfg.memoryMb
        });
      }
      record({ level: "info", msg: "provider_completed", provider, exit: providerResult.code });
    }
    // Persist run state for potential kill/inspect
    const state = {
      provider,
      container: !!useContainer,
      containerName: providerResult.containerName || null,
      startedAt: nowIso()
    };
    await fs.writeFile(path.join(cacheDir, "state.json"), JSON.stringify(state, null, 2));

    // Persist raw stdout for debugging
    await fs.writeFile(providerRawFile, providerResult.stdout || "");

    // Build transcript
    let transcriptEvents = [];
    if (provider === "claude") {
      transcriptEvents = parseStreamJson(providerResult.stdout || "");
    } else if (provider === "codex" && providerResult.session) {
      transcriptEvents = providerResult.session.lines.map((l) => { try { return JSON.parse(l); } catch { return { line: l }; } });
    }
    if (transcriptEvents.length) {
      const fd = await fs.open(transcriptFile, "w");
      try {
        for (const ev of transcriptEvents) {
          await fd.appendFile(JSON.stringify(ev) + "\n");
        }
      } finally { await fd.close(); }
    }

    // Extract and optionally apply diffs
    let patches = extractApplyPatchBlocks(providerResult.stdout || "");
    if (!patches.length && transcriptEvents.length) {
      patches = extractPatchesFromEvents(transcriptEvents);
    }
    // Fail safe when nothing changed: no patches and no transcript
    if (!patches.length && !transcriptEvents.length) {
      throw err(Errors.ValidationFailed, "no code edits detected from provider");
    }
    if (patches.length) {
      record({ level: "info", msg: "diff_detected", blocks: patches.length });
      for (const p of patches) {
        const sum = summarizeApplyPatch(p);
        // Path allowlist check
        const allowed = classCfg.fsScope || [];
        const forbidden = sum.files.filter((f) => !allowed.some(a => f.replace(/\\\\/g, '/').startsWith(a.replace(/\\\\/g, '/'))));
        if (forbidden.length) throw err(Errors.ForbiddenPath, "patch touches forbidden paths", { forbidden, allowed });
        if (args.apply) {
          await applyWithGit(p);
          record({ level: "info", msg: "patch_applied", files: sum.files });
        } else {
          record({ level: "info", msg: "patch_ready", files: sum.files });
        }
      }
    } else {
      record({ level: "info", msg: "no_patch_in_output" });
    }
    // Persist diffs summary if any patches were found
    if (patches && patches.length) {
      const allFiles = [];
      for (const ptxt of patches) {
        const s = summarizeApplyPatch(ptxt);
        allFiles.push(...s.files);
      }
      const unique = Array.from(new Set(allFiles));
      await fs.writeFile(path.join(cacheDir, 'diffs.json'), JSON.stringify({ files: unique }, null, 2));
    }
  }

  // WHY: Using spec.entry for packaging until CLI diff streaming is integrated.
  if (!spec.entry) throw err(Errors.ConfigNotFound, "spec.entry missing for assembler");

  // Assemble + validate
  const bundle = await assembleQuickJS({ entry: spec.entry, printJson: true });
  record({ level: "info", msg: "assemble_ok", bytes: (bundle.code || "").length });
  // P1: Pass capabilities to validator for enhanced safety checks
  const defaultCaps = { net: false, fs: false, dom: false };
  const caps = spec.caps || defaultCaps;
  validateJsSource({ code: bundle.code, filename: spec.entry, caps });
  record({ level: "info", msg: "validation_ok", caps });
  const manifest = makeScriptManifest({ id: spec.id || key.slice(0, 12), code: bundle.code, caps });
  record({ level: "info", msg: "manifest_ready", id: manifest.id, caps: manifest.caps });

  const result = { ok: true, provider, manifest, transcript }; const jobFinished = Date.now(); result.metrics = summarizeMetrics({ provider, transcriptEvents, startedAt: jobStarted, finishedAt: jobFinished });
  // Attach lightweight metrics
  result.metrics = result.metrics || {};
  result.metrics.provider = provider;
  if (provider === "claude" && transcriptEvents && transcriptEvents.length) {
    const usage = usageFromEvents(transcriptEvents);
    if (usage) result.metrics.usage = usage;
  }
  // Risk notes
  result.risk = result.risk || {};
  if (allowlistCfg) {
    const applied = (providerResult && providerResult.httpjailApplied) ? true : false;
    if (!applied) result.risk.httpjail_missed = true;
  }
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



