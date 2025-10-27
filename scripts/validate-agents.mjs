#!/usr/bin/env node
/*
Tiny validator for agents YAML.
Usage:
  node scripts/validate-agents.mjs [--file path/to/agents.yaml]
Defaults to validating config/agents.yaml.template
Exit codes: 0 OK, 1 invalid, 2 runtime error
*/

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const parseArgs = () => {
  const out = { file: null };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if ((a === '--file' || a === '-f') && i + 1 < argv.length) {
      out.file = argv[++i];
    }
  }
  return out;
};

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isRecord = (v) => isObject(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;
const isHttpUrl = (v) => isNonEmptyString(v) && /^(https?:)\/\//i.test(v);
const isPositiveInt = (v) => Number.isInteger(v) && v > 0;

const failRuntime = (msg) => {
  console.error(`[validate-agents] ${msg}`);
  process.exit(2);
};

const loadYaml = async (filePath) => {
  let yamlMod;
  try {
    yamlMod = await import('yaml');
  } catch (err) {
    failRuntime('Missing dependency: yaml. Install with: pnpm add -D yaml');
  }
  const text = await fs.readFile(filePath, 'utf8');
  try {
    return yamlMod.parse(text);
  } catch (err) {
    console.error(`[validate-agents] YAML parse error in ${filePath}:`, err?.message ?? String(err));
    process.exit(1);
  }
};

const errors = [];
const addError = (msg) => errors.push(msg);
const addWarn = (msg) => console.warn(`[validate-agents] WARN: ${msg}`);

const validateListModels = (lm, ctx) => {
  if (!isObject(lm)) return `${ctx}.list_models must be an object`;
  const method = lm.method ?? 'GET';
  if (method !== 'GET' && method !== 'POST') return `${ctx}.list_models.method must be GET or POST`;
  if (!isHttpUrl(lm.url)) return `${ctx}.list_models.url must be http(s) URL`;
  if (!isNonEmptyString(lm.id_path)) return `${ctx}.list_models.id_path must be non-empty string`;
  return null;
};

const validateModelAliases = (aliases, ctx, providerKey) => {
  if (!isRecord(aliases)) return `${ctx}.model_aliases must be an object`;
  for (const [alias, entry] of Object.entries(aliases)) {
    if (typeof entry === 'string') {
      if (!isNonEmptyString(entry)) {
        return `${ctx}.model_aliases.${alias} must be a non-empty string or object`;
      }
      if (providerKey === 'openrouter' && !entry.includes('/')) {
        return `${ctx}.model_aliases.${alias} id must be provider-prefixed (e.g., openai/gpt-5)`;
      }
    } else if (isObject(entry)) {
      if (!isNonEmptyString(entry.id)) {
        return `${ctx}.model_aliases.${alias}.id must be a non-empty string`;
      }
      if (providerKey === 'openrouter' && !entry.id.includes('/')) {
        return `${ctx}.model_aliases.${alias}.id must be provider-prefixed (e.g., openai/gpt-5)`;
      }
      if (entry.limits) {
        if (!isObject(entry.limits)) return `${ctx}.model_aliases.${alias}.limits must be an object`;
        for (const [k, v] of Object.entries(entry.limits)) {
          if (!isPositiveInt(v)) return `${ctx}.model_aliases.${alias}.limits.${k} must be a positive integer`;
        }
      }
    } else {
      return `${ctx}.model_aliases.${alias} must be string or object`;
    }
  }
  return null;
};

const validateProviders = (providers) => {
  if (!isRecord(providers)) {
    addError('providers must be an object');
    return {};
  }
  const keys = Object.keys(providers);
  if (keys.length === 0) addError('providers must have at least one entry');
  const out = {};
  for (const [pkey, pval] of Object.entries(providers)) {
    const ctx = `providers.${pkey}`;
    if (!isObject(pval)) {
      addError(`${ctx} must be an object`);
      continue;
    }
    if (!isHttpUrl(pval.base_url)) addError(`${ctx}.base_url must be http(s) URL`);
    if (pval.headers && !isRecord(pval.headers)) addError(`${ctx}.headers must be an object`);
    const aliasErr = validateModelAliases(pval.model_aliases ?? {}, ctx, pkey);
    if (aliasErr) addError(aliasErr);
    if (pval.list_models) {
      const lmErr = validateListModels(pval.list_models, ctx);
      if (lmErr) addError(lmErr);
    }
    out[pkey] = pval;
  }
  return out;
};

const validateProfile = (name, profile, providers) => {
  const ctx = `profiles.${name}`;
  if (!isObject(profile)) {
    addError(`${ctx} must be an object`);
    return;
  }
  if (!isNonEmptyString(profile.provider)) addError(`${ctx}.provider must be non-empty string`);
  if (profile.provider && !providers[profile.provider]) addError(`${ctx}.provider '${profile.provider}' not found in providers`);

  const mode = profile.mode;
  if (mode !== 'preset' && mode !== 'custom') addError(`${ctx}.mode must be 'preset' or 'custom'`);

  if (mode === 'preset') {
    const alias = profile.preset_model;
    if (!isNonEmptyString(alias)) addError(`${ctx}.preset_model must be non-empty`);
    if (alias && profile.provider && providers[profile.provider]) {
      const aliases = providers[profile.provider].model_aliases || {};
      if (!Object.prototype.hasOwnProperty.call(aliases, alias)) {
        addError(`${ctx}.preset_model '${alias}' not found in providers.${profile.provider}.model_aliases`);
      }
    }
  }
  if (mode === 'custom') {
    const id = profile.custom_model;
    if (!isNonEmptyString(id)) addError(`${ctx}.custom_model must be non-empty`);
    if (profile.provider === 'openrouter' && isNonEmptyString(id) && !id.includes('/')) {
      addError(`${ctx}.custom_model must be provider-prefixed (e.g., openai/gpt-5)`);
    }
  }

  if (profile.fallbacks != null) {
    if (!Array.isArray(profile.fallbacks)) {
      addError(`${ctx}.fallbacks must be an array of strings`);
    } else {
      profile.fallbacks.forEach((fb, i) => {
        if (!isNonEmptyString(fb)) {
          addError(`${ctx}.fallbacks[${i}] must be non-empty string`);
          return;
        }
        const idx = fb.indexOf(':');
        if (idx === -1) {
          const activeProviderKey = profile.provider;
          const activeProvider = providers[activeProviderKey];
          if (!activeProvider) {
            addError(`${ctx}.fallbacks[${i}] cannot resolve bare alias without a valid provider`);
            return;
          }
          const aliases = activeProvider.model_aliases || {};
          if (!Object.prototype.hasOwnProperty.call(aliases, fb)) {
            addError(`${ctx}.fallbacks[${i}] alias '${fb}' not found in providers.${activeProviderKey}.model_aliases`);
          }
          return;
        }
        if (idx === 0 || idx === fb.length - 1) {
          addError(`${ctx}.fallbacks[${i}] must be 'provider:aliasOrId'`);
          return;
        }
        const p = fb.slice(0, idx);
        const m = fb.slice(idx + 1);
        if (!providers[p]) addError(`${ctx}.fallbacks[${i}] provider '${p}' not found in providers`);
        if (!isNonEmptyString(m)) addError(`${ctx}.fallbacks[${i}] aliasOrId must be non-empty`);
      });
    }
  }
};

const main = async () => {
  try {
    const { file } = parseArgs();
    const target = file ? path.resolve(process.cwd(), file) : path.join(repoRoot, 'config', 'agents.yaml.template');
    const data = await loadYaml(target);
    if (!isObject(data)) addError('root must be an object');

    if (!isNonEmptyString(data.version)) addError('version must be a non-empty string');

    const providers = validateProviders(data.providers ?? {});

    if (!isObject(data.profiles)) {
      addError('profiles must be an object with planner and actor');
    } else {
      validateProfile('planner', data.profiles.planner, providers);
      validateProfile('actor', data.profiles.actor, providers);
    }

    if (errors.length) {
      errors.forEach((e) => console.error(`[validate-agents] ${e}`));
      process.exit(1);
    } else {
      console.log('[validate-agents] OK');
    }
  } catch (err) {
    console.error('[validate-agents] runtime error:', err?.message ?? String(err));
    process.exit(2);
  }
};

// Run
await main();
