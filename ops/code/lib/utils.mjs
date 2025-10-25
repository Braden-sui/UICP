import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, constants as FS, readFile, writeFile, rename, rm, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function exists(p) {
  try { await access(p, FS.F_OK); return true; } catch { return false; }
}

export function sha256Hex(input) {
  return createHash("sha256").update(input).digest("hex");
}

export function spawnp(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const { input, ...rest } = opts;
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], ...rest });
    let stdout = ""; let stderr = "";
    if (input != null) {
      child.stdin.write(typeof input === "string" ? input : Buffer.from(input));
      child.stdin.end();
    } else {
      child.stdin.end();
    }
    child.stdout.on("data", d => stdout += d.toString());
    child.stderr.on("data", d => stderr += d.toString());
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

export function spawnManaged(cmd, args, opts = {}) {
  const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], ...opts });
  let stdout = ""; let stderr = "";
  child.stdout.on("data", d => stdout += d.toString());
  child.stderr.on("data", d => stderr += d.toString());
  const wait = () => new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  return { child, wait };
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

const CODEJOB_CACHE_ENV = "UICP_CODEJOB_CACHE_DIR";
const DEFAULT_CODEJOB_CACHE = path.join(os.homedir(), ".uicp", "codejobs");

export function resolveCodejobCachePath(...parts) {
  const base = process.env[CODEJOB_CACHE_ENV] && process.env[CODEJOB_CACHE_ENV].trim().length
    ? process.env[CODEJOB_CACHE_ENV]
    : DEFAULT_CODEJOB_CACHE;
  return path.join(base, ...parts);
}

export async function ensureCodejobCacheDir() {
  const base = resolveCodejobCachePath();
  await mkdir(base, { recursive: true });
  return base;
}

async function renameWithOverwrite(tmpPath, targetPath) {
  try {
    await rename(tmpPath, targetPath);
  } catch (err) {
    if (err && err.code === "EEXIST") {
      await rm(targetPath, { force: true }).catch(() => {});
      await rename(tmpPath, targetPath);
    } else {
      await rm(tmpPath, { force: true }).catch(() => {});
      throw err;
    }
  }
}

export async function writeFileAtomic(filePath, data, options = {}) {
  const dir = path.dirname(filePath);
  const baseName = path.basename(filePath);
  const tempName = `.${baseName}.${process.pid}.${Date.now()}.tmp`;
  const tempPath = path.join(dir, tempName);
  await writeFile(tempPath, data, options);
  await renameWithOverwrite(tempPath, filePath);
}

export async function writeJsonAtomic(filePath, value, spacing = 2) {
  const payload = typeof value === "string" ? value : JSON.stringify(value, null, spacing);
  await writeFileAtomic(filePath, payload, { encoding: "utf8" });
}
