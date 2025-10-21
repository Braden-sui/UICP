// Provider interface and helpers
import { readFile } from "node:fs/promises";
import path from "node:path";
import { err, Errors } from "./errors.mjs";
import { readJson, resolveEnvTemplate } from "./utils.mjs";

export async function loadProviderConfig(name) {
  const file = path.join(process.cwd(), "ops/code/providers", `${name}-cli.yaml`);
  const txt = await readFile(file, "utf8").catch(() => null);
  if (!txt) throw err(Errors.ConfigNotFound, `provider config missing: ${file}`);
  const cfg = parseYaml(txt);
  // env template resolution in-place
  if (cfg.container?.image) cfg.container.image = resolveEnvTemplate(cfg.container.image);
  for (const m of cfg.container?.mounts ?? []) {
    if (m.source) m.source = resolveEnvTemplate(String(m.source));
    if (m.target) m.target = resolveEnvTemplate(String(m.target));
  }
  return cfg;
}

export async function loadAllowlist() {
  const policy = await readJson("ops/code/network/allowlist.json");
  return policy;
}

function parseYaml(txt) {
  // Minimal YAML subset parser for our config (key: value, nested objects, arrays)
  // For robustness, prefer a YAML lib in CI. Here, we support our files exactly.
  try {
    const yaml = require("yaml");
    return yaml.parse(txt);
  } catch {
    return naiveYamlParse(txt);
  }
}

function naiveYamlParse(txt) {
  const lines = txt.split(/\r?\n/);
  const root = {};
  const stack = [{ indent: -1, obj: root }];
  let current = root;
  for (const raw of lines) {
    const line = raw.replace(/\t/g, "  ");
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const indent = line.match(/^\s*/)[0].length;
    while (stack.length && indent <= stack[stack.length - 1].indent) stack.pop();
    current = stack[stack.length - 1].obj;
    const mList = line.trim().match(/^-\s+(.*)$/);
    if (mList) {
      if (!Array.isArray(current._list)) current._list = [];
      current._list.push(parseScalar(mList[1]));
      continue;
    }
    const m = line.trim().match(/^([A-Za-z0-9_\-]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const val = m[2];
    if (val === "") {
      const child = {};
      current[key] = child;
      stack.push({ indent, obj: child });
    } else {
      current[key] = parseScalar(val);
    }
  }
  // Post-process lists nested under keys
  function fix(obj) {
    for (const k of Object.keys(obj)) {
      if (obj[k] && typeof obj[k] === "object") fix(obj[k]);
    }
    if (obj._list) {
      return obj._list;
    }
    return obj;
  }
  return fix(root);
}

function parseScalar(s) {
  if (s === "true") return true;
  if (s === "false") return false;
  if (s.match(/^\[.*\]$/)) {
    try { return JSON.parse(s.replace(/([A-Za-z0-9_\-]+)/g, '"$1"')); } catch { return s; }
  }
  if (s.startsWith("[")) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(/,\s*/).map(x => x.replace(/^"|"$/g, ""));
  }
  if (s.startsWith("\"") && s.endsWith("\"")) return s.slice(1, -1);
  if (!isNaN(Number(s))) return Number(s);
  return s;
}

