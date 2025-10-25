#!/usr/bin/env node
// Orchestrator CLI: runCodeJob(jobSpec) -> CodeJobResult
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawnp, makeTmpPath, sha256Hex, readJson, withinScopes, nowIso, resolveCodejobCachePath, writeJsonAtomic, writeFileAtomic, ensureCodejobCacheDir } from "./lib/utils.mjs";
import { err, Errors } from "./lib/errors.mjs";
import { chooseProvider, loadPolicyMatrix, cacheKey, buildProviderPlan } from "./lib/router.mjs";
// NOTE: validateJsSource is no longer imported here - it's now called internally by assembleQuickJS
import { assembleQuickJS, makeScriptManifest } from "./lib/assembler.mjs";
import { loadProviderConfig } from "./lib/provider.mjs";
import { runClaude } from "./lib/providers/claude-cli.mjs";
import { runCodex } from "./lib/providers/codex-cli.mjs";
import { extractApplyPatchBlocks, summarizeApplyPatch, applyWithGit } from "./lib/diff.mjs";
import { parseClaudeStream, parseStreamJson, extractPatchesFromEvents, usageFromEvents } from "./lib/providers/claude.parse.mjs";
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
  // Deterministic provider plan
  const plan = buildProviderPlan({ spec, classCfg });
  const provider = args.provider || spec.provider || plan.provider;

  // Cache key
  const specHash = sha256Hex(JSON.stringify({ spec, classCfg }));
  const validatorVersion = "v1-js-ast-denylist";
  const compilerVersion = "applet.quickjs.builder@1";
  const key = cacheKey({ specHash, provider, validatorVersion, compilerVersion });

  // Build rich logging context for all subsequent log/record calls
  const logCtx = buildLogContext({ provider, key, plan, jobClass, specId: spec.id });

  await ensureCodejobCacheDir();
  const cacheDir = resolveCodejobCachePath(key);
  log({ level: "info", msg: "cache_dir_ready", ...logCtx, path: cacheDir });
  const artifactFile = path.join(cacheDir, "artifact.json");
  const transcriptFile = path.join(cacheDir, "transcript.jsonl");
  const providerRawFile = path.join(cacheDir, "provider.raw.txt");
  const diagnosticsFile = path.join(cacheDir, "diagnostics.json");

  // Cache check
  try {
    const cached = await readJson(artifactFile);
    log({ level: "info", msg: "cache_hit", ...logCtx });
    return printResult(cached);
  } catch (e) {
    if (e && e.code === "ENOENT") {
      // miss
    } else {
      log({ level: "error", msg: "cache_read_failed", ...logCtx, error: e && e.message, code: e && e.code });
    }
  }

  const transcript = []; const jobStarted = Date.now();
  const record = (ev) => transcript.push({ time: nowIso(), ...ev });

  if (args.dry) {
    record({ level: "info", msg: "dry_run", ...logCtx });
    return printResult({ ok: true, provider, plan, dry: true, transcript });
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
    const claudeTools = buildClaudeAllowedTools(plan.allowedTools);

    // Container policy: start from plan.container, allow CLI overrides, and gate by runtime availability
    let useContainer = plan.container === "on";
    if (args.container) useContainer = true;
    if (args.devOverride) {
      useContainer = false;
      record({ level: "info", msg: "container_disabled", ...logCtx, reason: "dev_override" });
    } else if (useContainer) {
      try {
        const { detectRuntime } = await import("./lib/container.mjs");
        await detectRuntime();
        record({ level: "info", msg: "container_default_enabled", ...logCtx, reason: "runtime_available" });
      } catch (e) {
        useContainer = false;
        record({ level: "warn", msg: "container_default_disabled", ...logCtx, reason: "no_runtime", error: e.message });
      }
    }

    // Dual-shot optional: run both providers with small timeout, prefer valid patches
    let providerResult;
    const containerMemory = plan.memoryMb || undefined;
    const smallTimeout = Math.min(120000, Math.max(30000, (plan.timeBudgetMs || 180000) / 3));
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
        memoryMb: plan.memoryMb,
        cpus: plan.cpus
      }).then(r => ({ name: "claude", r })).catch((e) => {
        const errorMsg = e && e.message ? e.message : String(e);
        const errorCode = e && e.code ? e.code : undefined;
        const claudeCtx = { ...logCtx, provider: "claude" };
        log({ level: "error", msg: "provider_run_failed", ...claudeCtx, error: errorMsg, code: errorCode });
        record({ level: "error", msg: "provider_run_failed", ...claudeCtx, error: errorMsg, code: errorCode });
        return { name: "claude", e };
      });
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
        memoryMb: plan.memoryMb,
        cpus: plan.cpus
      }).then(r => ({ name: "codex", r })).catch((e) => {
        const errorMsg = e && e.message ? e.message : String(e);
        const errorCode = e && e.code ? e.code : undefined;
        const codexCtx = { ...logCtx, provider: "codex" };
        log({ level: "error", msg: "provider_run_failed", ...codexCtx, error: errorMsg, code: errorCode });
        record({ level: "error", msg: "provider_run_failed", ...codexCtx, error: errorMsg, code: errorCode });
        return { name: "codex", e };
      });
      const [a, b] = await Promise.all([claudeP, codexP]);

      const evalResult = (x) => {
        if (x.e) {
          return {
            name: x.name,
            ok: false,
            patches: 0,
            transcriptPatches: 0,
            totalPatches: 0,
            stdoutBytes: 0,
            exitCode: null,
            error: x.e
          };
        }
        const stdout = x.r.stdout || "";
        const stdoutBytes = Buffer.byteLength(stdout, "utf8");
        let patches = extractApplyPatchBlocks(stdout).length;
        let transcriptPatches = 0;
        if (patches === 0 && x.name === "claude") {
          const evts = parseStreamJson(stdout);
          transcriptPatches = extractPatchesFromEvents(evts).length;
        }
        const totalPatches = Math.max(patches, transcriptPatches);
        return {
          name: x.name,
          ok: true,
          patches,
          transcriptPatches,
          totalPatches,
          stdoutBytes,
          exitCode: typeof x.r.code === "number" ? x.r.code : null,
          result: x.r
        };
      };

      const ea = evalResult(a);
      const eb = evalResult(b);

      const candidateLog = (ev) => ({
        provider: ev.name,
        ok: ev.ok,
        totalPatches: ev.totalPatches,
        directPatches: ev.patches,
        transcriptPatches: ev.transcriptPatches,
        stdoutBytes: ev.stdoutBytes,
        exitCode: ev.exitCode,
        error: ev.ok ? undefined : (ev.error && ev.error.message ? ev.error.message : String(ev.error))
      });

      const chooseWinner = (x, y) => {
        if (x.ok && !y.ok) return x;
        if (y.ok && !x.ok) return y;
        if (x.totalPatches !== y.totalPatches) return x.totalPatches >= y.totalPatches ? x : y;
        if (x.stdoutBytes !== y.stdoutBytes) return x.stdoutBytes >= y.stdoutBytes ? x : y;
        return x; // deterministic tie-breaker (order: claude then codex)
      };

      const winnerEval = chooseWinner(ea, eb);
      log({ level: "info", msg: "dual_shot_evaluation", ...logCtx, candidates: [candidateLog(ea), candidateLog(eb)] });
      record({ level: "info", msg: "dual_shot_evaluation", ...logCtx, candidates: [candidateLog(ea), candidateLog(eb)] });

      if (!winnerEval.ok) throw winnerEval.error;
      providerResult = winnerEval.result;
      record({ level: "info", msg: "dual_shot_selected", ...logCtx, provider: winnerEval.name, totalPatches: winnerEval.totalPatches });
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
          timeoutMs: plan.timeBudgetMs,
          memoryMb: plan.memoryMb,
          cpus: plan.cpus
        });
      } else {
        providerResult = await runCodex({
          prompt: spec.prompt,
          model: provCfg.defaults?.model,
          container: !!useContainer,
          provCfg,
          allowlistCfg,
          timeoutMs: plan.timeBudgetMs,
          memoryMb: plan.memoryMb,
          cpus: plan.cpus
        });
      }
      record({ level: "info", msg: "provider_completed", ...logCtx, exit: providerResult.code });
    }
    // Persist run state for potential kill/inspect
    const state = {
      provider,
      container: !!useContainer,
      containerName: providerResult.containerName || null,
      startedAt: nowIso()
    };
    await writeJsonAtomic(path.join(cacheDir, "state.json"), state);

    // Persist raw stdout for debugging
    await writeFileAtomic(providerRawFile, providerResult.stdout || "", { encoding: "utf8" });

    // Build transcript
    let transcriptEvents = [];
    let claudeDiagnostics = null;
    if (provider === "claude") {
      const parsed = parseClaudeStream(providerResult.stdout || "");
      transcriptEvents = parsed.events;
      claudeDiagnostics = parsed.diagnostics;
    } else if (provider === "codex" && providerResult.session) {
      transcriptEvents = providerResult.session.lines.map((l) => { try { return JSON.parse(l); } catch { return { line: l }; } });
    }
    if (transcriptEvents.length) {
      const payload = transcriptEvents.map((ev) => JSON.stringify(ev)).join("\n") + "\n";
      await writeFileAtomic(transcriptFile, payload, { encoding: "utf8" });
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
      record({ level: "info", msg: "diff_detected", ...logCtx, blocks: patches.length });
      for (const p of patches) {
        const sum = summarizeApplyPatch(p);
        // Path allowlist check
        const allowed = classCfg.fsScope || [];
        const forbidden = sum.files.filter((f) => !allowed.some(a => f.replace(/\\\\/g, '/').startsWith(a.replace(/\\\\/g, '/'))));
        if (forbidden.length) throw err(Errors.ForbiddenPath, "patch touches forbidden paths", { forbidden, allowed });
        if (args.apply) {
          await applyWithGit(p);
          record({ level: "info", msg: "patch_applied", ...logCtx, files: sum.files });
        } else {
          record({ level: "info", msg: "patch_ready", ...logCtx, files: sum.files });
        }
      }
    } else {
      record({ level: "info", msg: "no_patch_in_output", ...logCtx });
    }
    // Persist diffs summary if any patches were found
    if (patches && patches.length) {
      const allFiles = [];
      for (const ptxt of patches) {
        const s = summarizeApplyPatch(ptxt);
        allFiles.push(...s.files);
      }
      const unique = Array.from(new Set(allFiles));
      await writeJsonAtomic(path.join(cacheDir, "diffs.json"), { files: unique });
    }
  }

  // Use deterministic provider plan
  const providerPlan = {
    provider: provider,
    plan: plan,
    transcript: transcript
  };

  // Assemble + validate (validation is now integrated into assembleQuickJS)
  const defaultCaps = { net: false, fs: false, dom: false };
  const caps = spec.caps || defaultCaps;
  const bundle = await assembleQuickJS({
    entry: spec.entry,
    printJson: true,
    filename: spec.entry,
    caps: caps
  });
  // assembleQuickJS now guarantees validation was performed as part of its contract
  record({ level: "info", msg: "assemble_ok", ...logCtx, bytes: (bundle.code || "").length, validated: bundle.validated });
  record({ level: "info", msg: "validation_ok", ...logCtx, caps: bundle.caps });
  const manifest = makeScriptManifest({ id: spec.id || key.slice(0, 12), code: bundle.code, caps: bundle.caps });
  record({ level: "info", msg: "manifest_ready", ...logCtx, id: manifest.id, caps: manifest.caps });

  const result = { ok: true, provider, plan, manifest, transcript };
  const jobFinished = Date.now();
  result.metrics = summarizeMetrics({ provider, transcriptEvents, startedAt: jobStarted, finishedAt: jobFinished });
  // Attach lightweight metrics
  result.metrics = result.metrics || {};
  result.metrics.provider = provider;
  if (provider === "claude") {
    if (transcriptEvents && transcriptEvents.length) {
      const usage = usageFromEvents(transcriptEvents);
      if (usage) result.metrics.usage = usage;
    }
    if (claudeDiagnostics) {
      result.diagnostics = result.diagnostics || {};
      result.diagnostics.claude = claudeDiagnostics;
    }
  }
  // Risk notes
  result.risk = result.risk || {};
  if (allowlistCfg) {
    const applied = !!(providerResult && providerResult.httpjailApplied);
    if (!applied) {
      const errorMsg = "httpjail enforcement required but not applied";
      log({ level: "error", msg: "httpjail_not_applied", ...logCtx, error: errorMsg });
      record({ level: "error", msg: "httpjail_not_applied", ...logCtx });
      throw err(Errors.PolicyViolation, errorMsg, { provider, key });
    }
  }
  // Normalized artifact at the boundary
  result.artifact = {
    text: (providerResult && typeof providerResult.stdout === "string") ? providerResult.stdout : "",
    code: undefined,
    language: spec.language || null,
    citations: [],
    trace: { transcriptFile: transcriptFile, providerRawFile },
    timings: { startedAt: new Date(jobStarted).toISOString(), finishedAt: new Date(jobFinished).toISOString() }
  };
  // Persist diagnostics separately as well
  try { await writeJsonAtomic(diagnosticsFile, { provider, plan, diagnostics: result.diagnostics || null }); } catch {}
  await writeJsonAtomic(artifactFile, result);
  return printResult(result);
}

// Helper to build rich logging context with provider, spec, and plan details
function buildLogContext({ provider, key, plan, jobClass, specId }) {
  const ctx = {};
  if (provider) ctx.provider = provider;
  if (key) ctx.key = key;
  if (specId) ctx.specId = specId;
  if (jobClass) ctx.jobClass = jobClass;
  if (plan) {
    ctx.plan = {
      timeBudgetMs: plan.timeBudgetMs,
      memoryMb: plan.memoryMb,
      cpus: plan.cpus,
      container: plan.container,
      allowedToolsCount: plan.allowedTools?.length
    };
  }
  return ctx;
}

function log(ev) { process.stderr.write(JSON.stringify(ev) + os.EOL); }

function printResult(res) { process.stdout.write(JSON.stringify(res, null, 2) + "\n"); return res; }

main().catch((e) => {
  const out = { ok: false, error: { code: e.code || "E-UICP-0000", message: e.message, data: e.data } };
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  process.exitCode = 1;
});



