import { exists, readJson } from "./utils.mjs";
import { err, Errors } from "./errors.mjs";

export async function buildHttpJailArgs({ policyFile, providerKey, methods }) {
  const exe = await findHttpJail();
  const policy = await readJson(policyFile);
  const prov = policy.providers?.[providerKey];
  if (!prov) throw err(Errors.ConfigNotFound, `provider '${providerKey}' not in ${policyFile}`);
  const allowed = prov.hosts || [];
  const allowMethods = methods?.length ? methods : prov.methods || ["GET", "HEAD", "OPTIONS"];
  const js = JSON.stringify({ hosts: allowed, methods: allowMethods, blockPost: prov.blockPost !== false });
  return { exe, args: ["--js", js, "--"] };
}

export async function findHttpJail() {
  const candidates = ["httpjail", "/usr/local/bin/httpjail", "/opt/homebrew/bin/httpjail"];
  for (const c of candidates) {
    if (await exists(c)) return c;
  }
  // If not found, raise structured error; callers may continue without it.
  throw err(Errors.ToolMissing, "httpjail not found on PATH");
}

export async function policyJsonForProvider({ policyFile, providerKey, methods }) {
  const policy = await readJson(policyFile);
  const prov = policy.providers?.[providerKey];
  if (!prov) throw err(Errors.ConfigNotFound, `provider '${providerKey}' not in ${policyFile}`);
  const allowed = prov.hosts || [];
  const allowMethods = methods?.length ? methods : prov.methods || ["GET", "HEAD", "OPTIONS"];
  return JSON.stringify({ hosts: allowed, methods: allowMethods, blockPost: prov.blockPost !== false });
}
