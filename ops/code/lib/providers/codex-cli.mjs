import { spawnp } from "../utils.mjs";
import { buildHttpJailArgs, policyJsonForProvider } from "../httpjail.mjs";
import { err, Errors } from "../errors.mjs";
import { buildContainerCmd, shellWrap } from "../container.mjs";
import { harvestCodexSession } from "../providers/codex.harvest.mjs";

export async function runCodex({ prompt, model, container, provCfg, allowlistCfg, extraArgs = [] }) {
  const baseArgs = ["exec", prompt];
  if (model) baseArgs.push("--model", model);
  baseArgs.push(...extraArgs);

  let cmd = "codex";
  let args = baseArgs;

  if (container) {
    const containerCmd = await buildContainerCmd(provCfg);
    let inner = ["codex", ...baseArgs];
    if (allowlistCfg) {
      const policy = await policyJsonForProvider({
        policyFile: allowlistCfg.policy_file,
        providerKey: allowlistCfg.provider_key,
        methods: allowlistCfg.methods
      });
      inner = ["httpjail", "--js", policy, "--", ...inner];
    }
    const wrapped = shellWrap(inner);
    cmd = containerCmd.cmd;
    args = [...containerCmd.args, wrapped.cmd, ...wrapped.args];
  } else if (allowlistCfg) {
    const { exe, args: ja } = await safeHttpJailArgs(allowlistCfg).catch(() => ({ exe: null, args: [] }));
    if (exe) {
      cmd = exe;
      args = [...ja, "codex", ...baseArgs];
    }
  }

  const startedAt = Date.now();
  const { code, stdout, stderr } = await spawnp(cmd, args, { env: process.env });
  if (code !== 0) throw err(Errors.SpawnFailed, `codex exited with ${code}`, { stderr });
  let session = null;
  try { session = await harvestCodexSession({ sinceMs: startedAt }); } catch {}
  return { stdout, stderr, code, session };
}

function wrapHttpJailArgs(cfg) { return []; }

async function safeHttpJailArgs(cfg) {
  const { exe, args } = await buildHttpJailArgs(cfg);
  return { exe, args };
}
