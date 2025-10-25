import { readJson, sha256Hex } from "./utils.mjs";

// Backward-compat shim. Prefer buildProviderPlan() for full policy routing.
export function chooseProvider({ task, language, classCfg, spec }) {
  try {
    const plan = buildProviderPlan({ spec: spec ?? { task, language }, classCfg });
    return plan.provider;
  } catch {
    const t = (task || "").toLowerCase();
    const lang = (language || "").toLowerCase();
    if (t.includes("shell") || t.includes("test") || t.includes("orchestrate")) return "claude";
    if (["js","ts","tsx","javascript","typescript","react"].some(k => t.includes(k) || lang.includes(k))) return "codex";
    return "claude"; // default
  }
}

export async function loadPolicyMatrix() {
  return await readJson("ops/code/policy/job-classes.json");
}

export function cacheKey({ specHash, provider, validatorVersion, compilerVersion }) {
  return sha256Hex([specHash, provider, validatorVersion, compilerVersion].join("|"));
}

// Deterministic, policy-driven router producing an explicit provider plan
// Input: spec (task, language, class, caps, etc.), classCfg from policy
// Output: { provider, allowedTools, timeBudgetMs, memoryMb, container: 'on'|'off', needsNetwork: boolean }
export function buildProviderPlan({ spec, classCfg }) {
  if (!spec) throw new Error("spec required");
  if (!classCfg) throw new Error("classCfg required");

  const language = (spec.language || "").toLowerCase();
  const task = (spec.task || "").toLowerCase();
  const allowedCommands = Array.isArray(classCfg.allowedCommands) ? classCfg.allowedCommands : [];
  const needsNetwork = (classCfg.network && classCfg.network !== "none") === true;
  const testsRequired = !!classCfg.testsRequired;
  const timeBudgetMs = Number(classCfg.timeBudgetMs) || 180000;
  const memoryMb = Number(classCfg.memoryMb) || 2048;
  const cpus = Number(classCfg.cpus) || 1;

  // Provider selection policy
  let provider = "claude";
  const isJsLike = ["js", "ts", "tsx", "javascript", "typescript", "react"].some(
    (k) => language.includes(k) || task.includes(k),
  );
  const classKey = (spec.class || "").toLowerCase();
  if (classKey === "code_synthesis_js" && isJsLike) {
    provider = "codex";
  } else if (classKey === "shell_heavy_test_loop" || testsRequired || needsNetwork) {
    provider = "claude";
  } else {
    provider = isJsLike ? "codex" : "claude";
  }

  // Container guidance: favor on when network/tests/shell tools are required
  const riskyTools = ["pnpm", "npm", "cargo", "git", "bash", "sh"];
  const needsShell = allowedCommands.some((c) => riskyTools.includes(String(c).toLowerCase()));
  const container = needsNetwork || testsRequired || needsShell ? "on" : "off";

  return {
    provider,
    allowedTools: allowedCommands.slice(),
    timeBudgetMs,
    memoryMb,
    cpus,
    container,
    needsNetwork,
  };
}

