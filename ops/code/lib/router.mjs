import { readJson, sha256Hex } from "./utils.mjs";

export function chooseProvider({ task, language }) {
  const t = (task || "").toLowerCase();
  const lang = (language || "").toLowerCase();
  if (t.includes("shell") || t.includes("test") || t.includes("orchestrate")) return "claude";
  if (["js","ts","tsx","javascript","typescript","react"].some(k => t.includes(k) || lang.includes(k))) return "codex";
  return "claude"; // default
}

export async function loadPolicyMatrix() {
  return await readJson("ops/code/policy/job-classes.json");
}

export function cacheKey({ specHash, provider, validatorVersion, compilerVersion }) {
  return sha256Hex([specHash, provider, validatorVersion, compilerVersion].join("|"));
}

