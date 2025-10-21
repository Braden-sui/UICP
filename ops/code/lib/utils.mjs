import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, constants as FS, readFile } from "node:fs/promises";
import path from "node:path";

export async function exists(p) {
  try { await access(p, FS.F_OK); return true; } catch { return false; }
}

export function sha256Hex(input) {
  return createHash("sha256").update(input).digest("hex");
}

export function spawnp(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", d => stdout += d.toString());
    child.stderr.on("data", d => stderr += d.toString());
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

export async function readJson(file) {
  const txt = await readFile(file, "utf8");
  return JSON.parse(txt);
}

export function nowIso() { return new Date().toISOString(); }

export function normalizePath(p) {
  return p.replace(/\\/g, "/");
}

export function withinScopes(file, scopes) {
  const nf = normalizePath(file);
  return scopes.some(s => nf.startsWith(normalizePath(s)));
}

export function detectRuntime() {
  const platform = process.platform;
  const isWSL = !!process.env.WSL_DISTRO_NAME;
  return { platform, isWSL };
}

export function resolveEnvTemplate(str, env = process.env) {
  return str.replace(/\$\{([^}]+)\}/g, (_, key) => {
    const [name, def] = key.split(":-");
    return env[name] ?? def ?? "";
  });
}

export function tryRequire(moduleName) {
  try { return require(moduleName); } catch { return null; }
}

export function makeTmpPath(...parts) {
  const base = path.join(process.cwd(), "tmp", ...parts);
  return base;
}

