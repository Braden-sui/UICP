import assert from "node:assert/strict";
import { buildProviderPlan, loadPolicyMatrix } from "../lib/router.mjs";

(async () => {
  const policy = await loadPolicyMatrix();

  // JS synthesis should select codex with budgets and container guidance
  const specJs = {
    class: "code_synthesis_js",
    task: "code synthesis in TypeScript for UI panel",
    language: "ts",
    prompt: "...",
  };
  const planJs = buildProviderPlan({ spec: specJs, classCfg: policy.classes[specJs.class] });
  assert.equal(planJs.provider, "codex");
  assert.ok(planJs.timeBudgetMs > 0 && planJs.memoryMb > 0);
  assert.ok(planJs.cpus > 0);
  assert.deepEqual(planJs.allowedTools, policy.classes[specJs.class].allowedCommands);
  assert.equal(planJs.container, "on"); // risky tools include pnpm

  // Shell heavy loops should select claude and container on
  const specShell = {
    class: "shell_heavy_test_loop",
    task: "run tests and orchestrate shell commands",
    language: "ts",
    prompt: "...",
  };
  const planSh = buildProviderPlan({ spec: specShell, classCfg: policy.classes[specShell.class] });
  assert.equal(planSh.provider, "claude");
  assert.equal(planSh.container, "on");
  assert.equal(planSh.cpus, policy.classes[specShell.class].cpus);

  console.log("router.plan tests passed");
})().catch((e) => { console.error(e); process.exit(1); });
