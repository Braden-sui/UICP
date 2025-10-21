import { spawnp, spawnManaged } from "../utils.mjs";
import { buildHttpJailArgs, policyPredicateForProvider } from "../httpjail.mjs";
import { err, Errors } from "../errors.mjs";
import { buildContainerCmd, shellWrap } from "../container.mjs";
import { harvestCodexSession } from "../providers/codex.harvest.mjs";

export async function runCodex({ prompt, model, container, provCfg, allowlistCfg, extraArgs = [], timeoutMs, memoryMb }) {
  const baseArgs = ["exec", prompt];
  if (model) baseArgs.push("--model", model);
  baseArgs.push(...extraArgs);

  let cmd = "codex";
  let args = baseArgs;

  let containerName = null;
  let httpjailApplied = false;
  if (container) {
    containerName = `codejob-${Date.now().toString(36)}`;
    const containerCmd = await buildContainerCmd(provCfg, { name: containerName, memoryMb });
    let inner = ["codex", ...baseArgs];
    if (allowlistCfg) {
      const predicate = await policyPredicateForProvider({
        policyFile: allowlistCfg.policy_file,
        providerKey: allowlistCfg.provider_key,
        methods: allowlistCfg.methods,
        block_post: allowlistCfg.block_post
      });
      inner = ["httpjail", "--js", predicate, "--", ...inner];
      httpjailApplied = true;
    }
    const wrapped = shellWrap(inner);
    cmd = containerCmd.cmd;
    args = [...containerCmd.args, wrapped.cmd, ...wrapped.args];
  } else if (allowlistCfg) {
    const { exe, args: ja } = await safeHttpJailArgs(allowlistCfg).catch(() => ({ exe: null, args: [] }));
    if (exe) {
      cmd = exe;
      args = [...ja, "codex", ...baseArgs];
      httpjailApplied = true;
    }
  }

  const startedAt = Date.now();
  let stdout = ""; let stderr = ""; let code = -1;
  if (timeoutMs && timeoutMs > 0) {
    const { child, wait } = spawnManaged(cmd, args, { env: process.env });
    const t = setTimeout(() => { try { child.kill("SIGTERM"); } catch {} }, timeoutMs);
    const res = await wait();
    clearTimeout(t);
    stdout = res.stdout; stderr = res.stderr; code = res.code;
  } else {
    const res = await spawnp(cmd, args, { env: process.env });
    stdout = res.stdout; stderr = res.stderr; code = res.code;
  }
  if (code !== 0) throw err(Errors.SpawnFailed, `codex exited with ${code}`, { stderr });
  let session = null;
  try { session = await harvestCodexSession({ sinceMs: startedAt }); } catch {}
  return { stdout, stderr, code, session, containerName, httpjailApplied };
}

function wrapHttpJailArgs(cfg) { return []; }

async function safeHttpJailArgs(cfg) {
  const { exe, args } = await buildHttpJailArgs({
    policyFile: cfg.policy_file,
    providerKey: cfg.provider_key,
    methods: cfg.methods,
    block_post: cfg.block_post
  });
  return { exe, args };
}
