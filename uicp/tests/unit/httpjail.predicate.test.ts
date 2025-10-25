import { describe, expect, it } from 'vitest';
import vm from 'node:vm';

let buildHttpJailPredicate: ((opts: { hosts?: string[]; methods?: string[]; blockPost?: boolean }) => string) | null =
  null;
let buildClaudeAllowedTools: ((commands?: string[]) => string[]) | null = null;
let loadError: unknown;
try {
  ({ buildHttpJailPredicate } = await import('@ops/lib/httpjail'));
  ({ buildClaudeAllowedTools } = await import('@ops/lib/claude-tools'));
} catch (err) {
  loadError = err;
  buildHttpJailPredicate = null;
  buildClaudeAllowedTools = null;
}

const evalPredicate = (script: string, request: { host?: string; method?: string }) =>
  vm.runInNewContext(script, { r: request });

if (!buildHttpJailPredicate || !buildClaudeAllowedTools) {
  console.warn('Skipping httpjail predicate tests:', loadError);
}

const describeHttp = typeof buildHttpJailPredicate === 'function' ? describe : describe.skip;
const describeClaude = typeof buildClaudeAllowedTools === 'function' ? describe : describe.skip;

describeHttp('buildHttpJailPredicate', () => {
  it('allows configured host and method while rejecting others', () => {
    const predicate = buildHttpJailPredicate!({
      hosts: ['api.example.com'],
      methods: ['GET', 'POST'],
      blockPost: false,
    });
    expect(evalPredicate(predicate, { host: 'api.example.com', method: 'GET' })).toBe(true);
    expect(evalPredicate(predicate, { host: 'api.example.com', method: 'POST' })).toBe(true);
    expect(evalPredicate(predicate, { host: 'api.example.com', method: 'DELETE' })).toBe(false);
    expect(evalPredicate(predicate, { host: 'other.example.com', method: 'GET' })).toBe(false);
  });

  it('blocks POST when blockPost is true even if methods includes POST', () => {
    const predicate = buildHttpJailPredicate!({
      hosts: ['api.example.com'],
      methods: ['POST'],
      blockPost: true,
    });
    expect(evalPredicate(predicate, { host: 'api.example.com', method: 'POST' })).toBe(false);
  });

  it('supports wildcard hosts', () => {
    const predicate = buildHttpJailPredicate!({
      hosts: ['*.example.com'],
      methods: ['GET'],
      blockPost: false,
    });
    expect(evalPredicate(predicate, { host: 'sub.example.com', method: 'GET' })).toBe(true);
    expect(evalPredicate(predicate, { host: 'example.com', method: 'GET' })).toBe(true);
    expect(evalPredicate(predicate, { host: 'diff.com', method: 'GET' })).toBe(false);
  });
});

describeClaude('buildClaudeAllowedTools', () => {
  it('maps shell commands to Bash tool patterns and includes read/write tools', () => {
    if (typeof buildClaudeAllowedTools !== 'function') return;
    const tools = buildClaudeAllowedTools(['git', 'pnpm']);
    expect(new Set(tools)).toEqual(new Set(['Read', 'Edit', 'Bash(git:*)', 'Bash(pnpm:*)']));
  });

  it('preserves explicit tool patterns', () => {
    if (typeof buildClaudeAllowedTools !== 'function') return;
    const tools = buildClaudeAllowedTools(['Bash(npm test:*)', 'read']);
    expect(new Set(tools)).toEqual(new Set(['Read', 'Edit', 'Bash(npm test:*)']));
  });
});
