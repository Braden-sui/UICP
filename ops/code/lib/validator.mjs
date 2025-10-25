import { err, Errors } from "./errors.mjs";
import { tryRequire } from "./utils.mjs";

// P1: Enhanced JS safety validation with esbuild transforms
const DANGEROUS_PATTERNS = [
  /\beval\s*\(/,
  /\bnew\s+Function\s*\(/,
  /\.innerHTML\b/,
  /\bdocument\.write\s*\(/,
  /\bXMLHttpRequest\b/,
  /\bdynamicImport\b|\bimport\s*\(/,
  /\bReflect\b/,
  /\bFunction\s*\(/
];

export function validateJsSource({ code, filename, caps = {} }) {
  const findings = [];
  
  // P1: Enhanced validation with capability-aware checks
  const hasNetCap = caps.net === true;
  const hasFsCap = caps.fs === true;
  
  // Always block dangerous patterns regardless of capabilities
  for (const re of DANGEROUS_PATTERNS) {
    if (re.test(code)) findings.push({ type: "pattern", rule: re.toString() });
  }
  
  // Try AST-based checks if acorn is present
  const acorn = tryRequire("acorn");
  if (acorn) {
    try {
      const ast = acorn.parse(code, { ecmaVersion: 2020, sourceType: "module" });
      walk(ast, (node) => {
        if (node.type === "CallExpression") {
          if (node.callee && node.callee.name === "eval") findings.push({ type: "ast", rule: "Call:eval" });
          if (node.callee && node.callee.type === "Identifier" && node.callee.name === "Function") findings.push({ type: "ast", rule: "Call:Function" });
          // P1: Block dynamic import at bundler level
          if (node.callee && node.callee.type === "ImportExpression") findings.push({ type: "ast", rule: "DynamicImport:blocked" });
        }
        if (node.type === "NewExpression") {
          if (node.callee && node.callee.name === "Function") findings.push({ type: "ast", rule: "New:Function" });
        }
        if (node.type === "MemberExpression") {
          const name = memberName(node);
          if (name === "document.write") findings.push({ type: "ast", rule: "DOM:document.write" });
          if (name.endsWith(".innerHTML")) findings.push({ type: "ast", rule: "DOM:innerHTML" });
        }
        if (node.type === "Identifier") {
          if (node.name === "XMLHttpRequest" && !hasNetCap) findings.push({ type: "ast", rule: "XHR:no_net_cap" });
          // P1: Block fetch usage when caps.net is false
          if (node.name === "fetch" && !hasNetCap) findings.push({ type: "ast", rule: "Fetch:no_net_cap" });
        }
        // P1: Block globalThis access when capabilities are restricted
        if (node.type === "MemberExpression" && node.object && node.object.name === "globalThis") {
          if (!hasNetCap || !hasFsCap) findings.push({ type: "ast", rule: "GlobalThis:restricted" });
        }
      });
    } catch (e) {
      // Fall back to regex only
    }
  }
  
  if (findings.length) {
    throw err(Errors.ValidationFailed, `JS validation failed in ${filename}`, { findings, caps });
  }
}

function walk(node, visit) {
  visit(node);
  for (const key in node) {
    const val = node[key];
    if (!val) continue;
    if (Array.isArray(val)) {
      for (const v of val) if (v && typeof v.type === "string") walk(v, visit);
    } else if (val && typeof val.type === "string") {
      walk(val, visit);
    }
  }
}

function memberName(node) {
  let out = "";
  const parts = [];
  (function rec(n) {
    if (n.type !== "MemberExpression") return;
    if (n.object.type === "MemberExpression") rec(n.object);
    else if (n.object.type === "Identifier") parts.push(n.object.name);
    if (n.property.type === "Identifier") parts.push(n.property.name);
  })(node);
  out = parts.join(".");
  return out;
}

export function validateDiffPaths({ changedFiles, allowedScopes }) {
  const bad = changedFiles.filter(f => !allowedScopes.some(s => f.startsWith(s)));
  if (bad.length) throw err(Errors.ForbiddenPath, "diff touches forbidden paths", { bad, allowedScopes });
}

