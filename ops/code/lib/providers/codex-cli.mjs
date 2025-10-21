import { spawnp } from "../utils.mjs";
import { buildHttpJailArgs } from "../httpjail.mjs";
import { err, Errors } from "../errors.mjs";

export async function runCodex({ prompt, model, containerCmd, allowlistCfg, extraArgs = [] }) {
  const baseArgs = ["exec", prompt];
  if (model) baseArgs.push("--model", model);
  baseArgs.push(...extraArgs);

  let cmd = "codex";
  let args = baseArgs;

  if (containerCmd) {
    cmd = containerCmd.cmd;
    args = [...containerCmd.args, ...wrapHttpJailArgs(allowlistCfg), "codex", ...baseArgs];
  } else if (allowlistCfg) {
    const { exe, args: ja } = await safeHttpJailArgs(allowlistCfg).catch(() => ({ exe: null, args: [] }));
    if (exe) {
      cmd = exe;
      args = [...ja, "codex", ...baseArgs];
    }
  }

  const { code, stdout, stderr } = await spawnp(cmd, args, { env: process.env });
  if (code !== 0) throw err(Errors.SpawnFailed, `codex exited with ${code}`, { stderr });
  return { stdout, stderr, code };
}

function wrapHttpJailArgs(cfg) { return []; }

async function safeHttpJailArgs(cfg) {
  const { exe, args } = await buildHttpJailArgs(cfg);
  return { exe, args };
}

