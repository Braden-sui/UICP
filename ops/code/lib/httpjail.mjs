import { exists, readJson } from "./utils.mjs";
import { err, Errors } from "./errors.mjs";

export async function buildHttpJailArgs({ policyFile, providerKey, methods, block_post, blockPost, policy_file, provider_key }) {
  const file = policyFile ?? policy_file;
  const key = providerKey ?? provider_key;
  if (!file) throw err(Errors.ConfigNotFound, "httpjail policy file missing");
  if (!key) throw err(Errors.ConfigNotFound, "httpjail provider key missing");
  const exe = await findHttpJail();
  const predicate = await policyPredicateForProvider({
    policyFile: file,
    providerKey: key,
    methods,
    block_post,
    blockPost
  });
  return { exe, args: ["--js", predicate, "--"] };
}

export async function findHttpJail() {
  const candidates = ["httpjail", "/usr/local/bin/httpjail", "/opt/homebrew/bin/httpjail"];
  for (const c of candidates) {
    if (await exists(c)) return c;
  }
  // If not found, raise structured error; callers may continue without it.
  throw err(Errors.ToolMissing, "httpjail not found on PATH");
}

export async function policyPredicateForProvider({ policyFile, providerKey, policy_file, provider_key, methods, block_post, blockPost }) {
  const file = policyFile ?? policy_file;
  const key = providerKey ?? provider_key;
  if (!file) throw err(Errors.ConfigNotFound, "httpjail policy file missing");
  if (!key) throw err(Errors.ConfigNotFound, "httpjail provider key missing");
  const policy = await readJson(file);
  const prov = policy.providers?.[key];
  if (!prov) throw err(Errors.ConfigNotFound, `provider '${key}' not in ${file}`);
  const allowedHosts = Array.isArray(prov.hosts) ? prov.hosts : [];
  const allowMethods = normalizeMethods(methods?.length ? methods : prov.methods || ["GET", "HEAD", "OPTIONS"]);
  const blockSetting = block_post ?? blockPost ?? prov.blockPost ?? prov.block_post;
  const blockPostFinal = blockSetting === undefined ? true : Boolean(blockSetting);
  return buildHttpJailPredicate({ hosts: allowedHosts, methods: allowMethods, blockPost: blockPostFinal });
}

export function buildHttpJailPredicate({ hosts = [], methods = [], blockPost = true }) {
  const normalizedHosts = normalizeHosts(hosts);
  const normalizedMethods = normalizeMethods(methods);
  // WHY: Generate deterministic predicate so httpjail enforces host + method allowlists.
  return [
    "(()=>{",
    `const hosts=${JSON.stringify(normalizedHosts)};`,
    `const methods=${JSON.stringify(normalizedMethods)};`,
    `const blockPost=${blockPost ? "true" : "false"};`,
    "const reqHost=(r.host||\"\").toLowerCase();",
    "const reqMethod=(r.method||\"\").toUpperCase();",
    "const hostAllowed=hosts.length===0||hosts.some((pattern)=>{",
    "  if(pattern===\"*\") return true;",
    "  if(pattern.startsWith(\"*.\")){",
    "    const suffix=pattern.slice(1);",
    "    const bare=pattern.slice(2);",
    "    if(bare && reqHost===bare) return true;",
    "    return reqHost.endsWith(suffix);",
    "  }",
    "  return reqHost===pattern;",
    "});",
    "if(!hostAllowed) return false;",
    "if(blockPost && reqMethod===\"POST\") return false;",
    "if(methods.length && !methods.includes(reqMethod)) return false;",
    "return true;",
    "})()"
  ].join("");
}

function normalizeHosts(list) {
  return Array.from(new Set(list.filter(Boolean).map((h) => String(h).trim().toLowerCase())));
}

function normalizeMethods(list) {
  return Array.from(new Set(list.filter(Boolean).map((m) => String(m).trim().toUpperCase())));
}
