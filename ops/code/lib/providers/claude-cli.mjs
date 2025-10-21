import { spawnp } from "../utils.mjs";
import { buildHttpJailArgs, policyJsonForProvider } from "../httpjail.mjs";
import { err, Errors } from "../errors.mjs";
import { buildContainerCmd, shellWrap, quote } from "../container.mjs";

export async function runClaude({ prompt, tools, acceptEdits, dangerSkipPerms, container, provCfg, allowlistCfg }) {
  const baseArgs = ["-p", prompt, "--output-format", "stream-json"];
  if (tools?.length) baseArgs.push("--allowedTools", tools.join(","));
  if (acceptEdits) baseArgs.push("--permission-mode", "acceptEdits");
  if (dangerSkipPerms) baseArgs.push("--dangerously-skip-permissions");

  let cmd = "claude";
  let args = baseArgs;

  if (container) {
    const containerCmd = await buildContainerCmd(provCfg);
    // Build inner command, optionally wrapped with httpjail
    let inner = ["claude", ...baseArgs];
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
