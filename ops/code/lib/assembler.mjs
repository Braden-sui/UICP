import { spawnp, readJson } from "./utils.mjs";
import { err, Errors } from "./errors.mjs";
import { validateJsSource } from "./validator.mjs";

/**
 * Assemble TypeScript/JavaScript into a bundled JS string compatible with applet.quickjs@0.1.0.
 *
 * IMPORTANT: This function now includes mandatory validation as part of the assembly contract.
 * Validation cannot be skipped and ensures the assembled code meets security requirements.
 *
 * @param {Object} params - Assembly parameters
 * @param {string} params.entry - Entry point file path
 * @param {boolean} [params.printJson=true] - Whether to parse JSON output
 * @param {string} params.filename - Filename for validation error reporting
 * @param {Object} [params.caps] - Capability flags for validation (net, fs, dom)
 * @returns {Object} Validated bundle with kind, code, and validated flag
 */
export async function assembleQuickJS({ entry, printJson = true, filename, caps }) {
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

  // REQUIRED: Validation is now part of the assembly contract
  // This ensures all assembled code is validated before being returned
  const defaultCaps = { net: false, fs: false, dom: false };
  const effectiveCaps = caps || defaultCaps;
  const effectiveFilename = filename || entry;

  validateJsSource({
    code: bundle,
    filename: effectiveFilename,
    caps: effectiveCaps
  });

  return {
    kind: "quickjs-source",
    code: bundle,
    validated: true, // Explicitly indicates validation was performed
    caps: effectiveCaps
  };
}

export function makeScriptManifest({ id, code, caps = {} }) {
  // P1: Enhanced manifest with capability enforcement
  return {
    id,
    kind: "script.panel",
    module: "applet.quickjs@0.1.0",
    source: code,
    caps: {
      net: caps.net || false,
      fs: caps.fs || false,
      dom: caps.dom || false,
      ...caps
    },
    version: "1.0.0",
    timestamp: new Date().toISOString()
  };
}
