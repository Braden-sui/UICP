import { spawnp } from "../utils.mjs";
import { buildHttpJailArgs } from "../httpjail.mjs";
import { err, Errors } from "../errors.mjs";

export async function runClaude({ prompt, tools, acceptEdits, dangerSkipPerms, containerCmd, allowlistCfg }) {
  const baseArgs = ["-p", prompt, "--output-format", "stream-json"];
  if (tools?.length) baseArgs.push("--allowedTools", tools.join(","));
  if (acceptEdits) baseArgs.push("--permission-mode", "acceptEdits");
  if (dangerSkipPerms) baseArgs.push("--dangerously-skip-permissions");

  let cmd = "claude";
  let args = baseArgs;

  if (containerCmd) {
    cmd = containerCmd.cmd;
    args = [...containerCmd.args, ...wrapHttpJailArgs(allowlistCfg), "claude", ...baseArgs];
  } else if (allowlistCfg) {
    // Local host run wrapped in httpjail if available
    const { exe, args: ja } = await safeHttpJailArgs(allowlistCfg).catch(() => ({ exe: null, args: [] }));
    if (exe) {
      cmd = exe;
      args = [...ja, "claude", ...baseArgs];
    }
  }

  const { code, stdout, stderr } = await spawnp(cmd, args, { env: process.env });
  if (code !== 0) throw err(Errors.SpawnFailed, `claude exited with ${code}`, { stderr });
  return { stdout, stderr, code };
}

function wrapHttpJailArgs(cfg) { return []; }

async function safeHttpJailArgs(cfg) {
  const { exe, args } = await buildHttpJailArgs(cfg);
  return { exe, args };
}

