#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { spawnp, sha256Hex } from "./lib/utils.mjs";
import { readJson } from "./lib/utils.mjs";
import { err, Errors } from "./lib/errors.mjs";

function parseArgs(argv){
  const out = {};
  for (let i=2;i<argv.length;i++){
    const a=argv[i];
    if (a === "--spec") out.spec = argv[++i];
    else if (a === "--key") out.key = argv[++i];
  }
  return out;
}

async function main(){
  const args = parseArgs(process.argv);
  let cacheDir;
  if (args.key) {
    cacheDir = path.join(process.cwd(), "tmp", "codejobs", args.key);
  } else if (args.spec) {
    const spec = JSON.parse(await fs.readFile(args.spec, "utf8"));
    const specHash = sha256Hex(JSON.stringify(spec));
    // Conservative: scan tmp/codejobs for key that starts with specHash prefix
    const root = path.join(process.cwd(), "tmp", "codejobs");
    const dirs = await fs.readdir(root).catch(()=>[]);
    const key = dirs.find(k => k.startsWith(specHash.slice(0, 16))) || dirs[0];
    if (!key) throw err(Errors.CacheMiss, "no job cache found");
    cacheDir = path.join(root, key);
  } else {
    throw err(Errors.ConfigNotFound, "--spec or --key is required");
  }

  const stateFile = path.join(cacheDir, "state.json");
  const state = await readJson(stateFile).catch(()=>null);
  if (!state) throw err(Errors.ConfigNotFound, `state missing: ${stateFile}`);
  if (!state.container || !state.containerName) throw err(Errors.UnsupportedOS, "only container kill supported in this CLI");

  const runtime = await detectRuntime();
  const { code, stderr } = await spawnp(runtime, ["stop", state.containerName]);
  if (code !== 0) throw err(Errors.SpawnFailed, `failed to stop container ${state.containerName}`, { stderr });
  process.stdout.write(JSON.stringify({ ok: true, stopped: state.containerName }) + "\n");
}

async function detectRuntime(){
  for (const r of ["docker", "podman"]) {
    const { code } = await spawnp(r, ["ps"]).catch(()=>({code:1}));
    if (code === 0) return r;
  }
  throw err(Errors.ToolMissing, "container runtime not found");
}

main().catch(e=>{ process.stdout.write(JSON.stringify({ ok:false, error: { code: e.code||"E-UICP-0000", message: e.message, data: e.data } })+"\n"); process.exitCode=1; });

