import { spawnp, resolveEnvTemplate } from "./utils.mjs";
import path from "node:path";
import { err, Errors } from "./errors.mjs";

export async function detectRuntime() {
  const candidates = [
    { cmd: "docker", args: ["version", "--format", "{{.Server.Version}}"], label: "docker" },
    { cmd: "podman", args: ["version", "--format", "{{.Server.Version}}"], label: "podman" }
  ];
  for (const c of candidates) {
    const res = await spawnp(c.cmd, c.args).catch(() => null);
    if (res && res.code === 0) {
      const version = (res.stdout || "").trim();
      return { binary: c.cmd, label: c.label, version: version || "unknown" };
    }
  }
  return null;
}

export async function buildContainerCmd(providerCfg, { env = process.env, name, memoryMb, cpus, runtimeInfo } = {}) {
  const runtime = runtimeInfo ?? await detectRuntime();
  if (!runtime) throw err(Errors.ToolMissing, "container runtime not found (docker or podman)");
  const image = providerCfg.container?.image;
  if (!image) throw err(Errors.ConfigNotFound, "provider container.image missing");
  const workdir = providerCfg.container?.workdir || "/workspace";
  const wsHost = process.cwd();
  const env2 = { ...env, WORKSPACE_DIR: env?.WORKSPACE_DIR || wsHost };
  const net = providerCfg.container?.network === "none" ? ["--network", "none"] : [];
  const mounts = [];
  for (const m of providerCfg.container?.mounts || []) {
    const raw = m.source || wsHost;
    let src = resolveEnvTemplate(raw, env2).trim();
    if (!src) src = wsHost;
    if (!path.isAbsolute(src)) src = path.resolve(wsHost, src);
    const dst = m.target || workdir;
    const type = m.type || "bind";
    if (type === "bind") mounts.push("-v", `${src}:${dst}`);
  }
  const envs = [];
  for (const e of providerCfg.container?.env || []) {
    if (e.name) {
      const val = env2[e.from_env] ?? env2[e.name] ?? "";
      envs.push("-e", `${e.name}=${val}`);
    }
  }
  // Always pass through workspace dir for templates
  envs.push("-e", `WORKSPACE_DIR=${env2.WORKSPACE_DIR}`);
  // Hardening toggles: firewall and strict caps (defaults: firewall on, strict caps off)
  const cfgFirewallEnabled = providerCfg.hardening?.firewall?.enabled;
  const cfgStrictCaps = providerCfg.hardening?.caps?.strict;
  const envDisableFw = (env2.UICP_DISABLE_FIREWALL === "1");
  const envStrictCaps = (env2.UICP_STRICT_CAPS === "1");
  const firewallEnabled = (cfgFirewallEnabled === undefined ? true : !!cfgFirewallEnabled) && !envDisableFw;
  const strictCaps = (cfgStrictCaps === undefined ? false : !!cfgStrictCaps) || envStrictCaps;
  if (!firewallEnabled) {
    envs.push("-e", "DISABLE_FIREWALL=1");
  }

  const limits = [];
  if (typeof memoryMb === "number" && memoryMb > 0) {
    const mem = `${Math.floor(memoryMb)}m`;
    limits.push("--memory", mem, "--memory-swap", mem);
  }
  if (typeof cpus === "number" && cpus > 0) {
    limits.push("--cpus", String(cpus));
  }
  limits.push("--pids-limit", "256");
  limits.push("--read-only");
  limits.push("--cap-drop", "ALL");
  // MINIMAL required capabilities for firewall tooling to function.
  if (firewallEnabled && !strictCaps) {
    limits.push("--cap-add", "NET_ADMIN", "--cap-add", "NET_RAW");
  }
  limits.push("--security-opt", "no-new-privileges");
  const tmpfs = providerCfg.container?.tmpfs?.length
    ? providerCfg.container.tmpfs
    : [
        "/tmp:rw,size=64m,mode=1777",
        "/var/tmp:rw,size=64m,mode=1777",
        "/run:rw,size=16m,mode=0755",
        "/home/app:rw,size=64m,uid=10001,gid=10001,mode=0700",
      ];
  for (const entry of tmpfs) {
    limits.push("--tmpfs", entry);
  }

  const base = [
    runtime.binary,
    "run",
    "--rm",
    ...(name ? ["--name", name] : []),
    ...net,
    ...mounts,
    "-w",
    workdir,
    ...limits,
    ...envs,
    image
  ];
  return { cmd: base[0], args: base.slice(1), runtime };
}

export function shellWrap(commandArgs) {
  // Wrap as: sh -lc "<command>"
  const joined = commandArgs.map(quote).join(" ");
  return { cmd: "sh", args: ["-lc", joined] };
}

export function quote(s) {
  // Simple POSIX quoting
  if (/^[A-Za-z0-9_\-\.\/:=,]+$/.test(s)) return s;
  return `'${String(s).replace(/'/g, `'"'"'`)}'`;
}
