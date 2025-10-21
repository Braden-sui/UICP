import { spawnp, readJson } from "./utils.mjs";
import { err, Errors } from "./errors.mjs";

// Assemble TypeScript/JavaScript into a bundled JS string compatible with applet.quickjs@0.1.0.
export async function assembleQuickJS({ entry, printJson = true }) {
  const cmd = process.execPath; // node
  const args = ["uicp/scripts/build-applet.mjs", entry, ...(printJson ? ["--print-json"] : [])];
  const { code, stdout, stderr } = await spawnp(cmd, args);
  if (code !== 0) throw err(Errors.SpawnFailed, `build-applet failed (${code})`, { stderr });
  let bundle = stdout;
  if (printJson) {
    const obj = JSON.parse(stdout);
    bundle = obj.code || obj.bundle || stdout;
  }
  if (!bundle || bundle.length === 0) throw err(Errors.ValidationFailed, "empty bundle output");
  return { kind: "quickjs-source", code: bundle };
}

export function makeScriptManifest({ id, code, caps = {} }) {
  return {
    id,
    kind: "script.panel",
    module: "applet.quickjs@0.1.0",
    source: code,
    caps: { net: false, fs: false, ...caps }
  };
}
