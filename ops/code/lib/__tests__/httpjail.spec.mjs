import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

import { buildHttpJailPredicate } from "../httpjail.mjs";
import { buildClaudeAllowedTools } from "../claude-tools.mjs";

function evalPredicate(script, request) {
  return vm.runInNewContext(script, { r: request });
}

test("buildHttpJailPredicate enforces host and method allowlist", () => {
  const predicate = buildHttpJailPredicate({
    hosts: ["api.example.com"],
    methods: ["GET", "POST"],
    blockPost: false
  });
  assert.equal(evalPredicate(predicate, { host: "api.example.com", method: "GET" }), true);
  assert.equal(evalPredicate(predicate, { host: "api.example.com", method: "POST" }), true);
  assert.equal(evalPredicate(predicate, { host: "api.example.com", method: "DELETE" }), false);
  assert.equal(evalPredicate(predicate, { host: "other.example.com", method: "GET" }), false);
});

test("buildHttpJailPredicate blocks POST when blockPost is true", () => {
  const predicate = buildHttpJailPredicate({
    hosts: ["api.example.com"],
    methods: ["POST"],
    blockPost: true
  });
  assert.equal(evalPredicate(predicate, { host: "api.example.com", method: "POST" }), false);
});

test("buildHttpJailPredicate supports wildcard hosts", () => {
  const predicate = buildHttpJailPredicate({
    hosts: ["*.example.com"],
    methods: ["GET"],
    blockPost: false
  });
  assert.equal(evalPredicate(predicate, { host: "sub.example.com", method: "GET" }), true);
  assert.equal(evalPredicate(predicate, { host: "example.com", method: "GET" }), true);
  assert.equal(evalPredicate(predicate, { host: "other.com", method: "GET" }), false);
});

test("buildClaudeAllowedTools maps commands to Claude tool schema", () => {
  const tools = buildClaudeAllowedTools(["git", "pnpm"]);
  assert.deepEqual(new Set(tools), new Set(["Read", "Edit", "Bash(git:*)", "Bash(pnpm:*)"]));
});

test("buildClaudeAllowedTools keeps explicit tool entries and deduplicates", () => {
  const tools = buildClaudeAllowedTools(["Bash(npm test:*)", "read", "Edit", "git"]);
  assert.deepEqual(new Set(tools), new Set(["Read", "Edit", "Bash(npm test:*)", "Bash(git:*)"]));
});
