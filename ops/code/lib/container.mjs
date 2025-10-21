import { spawnp, exists, resolveEnvTemplate } from "./utils.mjs";
import path from "node:path";
import os from "node:os";
import { err, Errors } from "./errors.mjs";

export async function detectRuntime() {
  const candidates = [
    { cmd: "docker", args: ["version", "--format", "{{.Server.Version}}"] },
    { cmd: "podman", args: ["version", "--format", "{{.Server.Version}}"] }
  ];
  for (const c of candidates) {
    const { code } = await spawnp(c.cmd, c.args).catch(() => ({ code: 1 }));
    if (code === 0) return c.cmd;
  }
  throw err(Errors.ToolMissing, "container runtime not found (docker or podman)");
}

export async function buildContainerCmd(providerCfg, { env = process.env, name, memoryMb } = {}) {
  const runtime = await detectRuntime();
  const image = providerCfg.container?.image;
  if (!image) throw err(Errors.ConfigNotFound, "provider container.image missing");
  const workdir = providerCfg.container?.workdir || "/workspace";
  const wsHost = process.cwd();
  const net = providerCfg.container?.network === "none" ? ["--network", "none"] : [];
  const mounts = [];
  for (const m of providerCfg.container?.mounts || []) {
    const src = resolveEnvTemplate(m.source || wsHost, env);
    const dst = m.target || workdir;
    const type = m.type || "bind";
    if (type === "bind") mounts.push("-v", `${src}:${dst}`);
  }
  const envs = [];
  for (const e of providerCfg.container?.env || []) {
    if (e.name) {
      const val = env[e.from_env] ?? env[e.name] ?? "";
      envs.push("-e", `${e.name}=${val}`);
    }
  }
  // Always pass through workspace dir for templates
  envs.push("-e", `WORKSPACE_DIR=${wsHost}`);

  const limits = [];
  if (typeof memoryMb === "number" && memoryMb > 0) limits.push("--memory", `${Math.floor(memoryMb)}m`);
  const base = [runtime, "run", "--rm", ...(name ? ["--name", name] : []), ...net, ...mounts, "-w", workdir, ...limits, ...envs, image];
  return { cmd: base[0], args: base.slice(1) };
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
