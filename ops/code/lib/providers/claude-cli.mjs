import { spawnp, spawnManaged } from "../utils.mjs";
import { buildHttpJailArgs, policyJsonForProvider } from "../httpjail.mjs";
import { err, Errors } from "../errors.mjs";
import { buildContainerCmd, shellWrap, quote } from "../container.mjs";

export async function runClaude({ prompt, tools, acceptEdits, dangerSkipPerms, container, provCfg, allowlistCfg, timeoutMs }) {
  const baseArgs = ["-p", prompt, "--output-format", "stream-json"];
  if (tools?.length) baseArgs.push("--allowedTools", tools.join(","));
  if (acceptEdits) baseArgs.push("--permission-mode", "acceptEdits");
  if (dangerSkipPerms) baseArgs.push("--dangerously-skip-permissions");

  let cmd = "claude";
  let args = baseArgs;

  let containerName = null;
  let httpjailApplied = false;
  if (container) {
    containerName = `codejob-${Date.now().toString(36)}`;
    const containerCmd = await buildContainerCmd(provCfg, { name: containerName });
    // Build inner command, optionally wrapped with httpjail
    let inner = ["claude", ...baseArgs];
    if (allowlistCfg) {
      const policy = await policyJsonForProvider({
        policyFile: allowlistCfg.policy_file,
        providerKey: allowlistCfg.provider_key,
        methods: allowlistCfg.methods
      });
      inner = ["httpjail", "--js", policy, "--", ...inner];
      httpjailApplied = true; // assume present in image; orchestrator will surface failures
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
      httpjailApplied = true;
    }
  }

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
  if (code !== 0) throw err(Errors.SpawnFailed, `claude exited with ${code}`, { stderr });
  return { stdout, stderr, code, containerName, httpjailApplied };
}

function wrapHttpJailArgs(cfg) { return []; }

async function safeHttpJailArgs(cfg) {
  const { exe, args } = await buildHttpJailArgs(cfg);
  return { exe, args };
}
