import { describe, it, expect, beforeEach, vi } from 'vitest';
import { loadFromText, resolveModel, resolveProfiles } from '../loader';

const baseYaml = `
version: "1"
defaults:
  temperature: 0.2
  top_p: 1.0
  max_tokens: 4096
  json_mode: true
  tools_enabled: true
providers:
  openai:
    base_url: https://api.openai.com/v1
    headers:
      Authorization: "Bearer \${OPENAI_API_KEY}"
    model_aliases:
      gpt_default: gpt-5
      gpt_mini: gpt-5-mini
  anthropic:
    base_url: https://api.anthropic.com
    headers:
      x-api-key: "\${ANTHROPIC_API_KEY}"
    model_aliases:
      claude_default:
        id: claude-sonnet-4-5-20250929
      claude_mini:
        id: claude-haiku-4-5
  openrouter:
    base_url: https://openrouter.ai/api/v1
    headers:
      Authorization: "Bearer \${OPENROUTER_API_KEY}"
    model_aliases:
      gpt_default: openai/gpt-5
      gpt_mini: openai/gpt-5-mini
profiles:
  planner:
    provider: openai
    model: gpt_default
    temperature: 0.2
    max_tokens: 4096
    fallbacks:
      - anthropic:claude_default
      - gpt_mini
  actor:
    provider: anthropic
    model: claude_default
    temperature: 0.2
    max_tokens: 4096
    fallbacks:
      - openai:gpt_default
      - claude_mini
codegen:
  engine: "cli"
  allow_paid_fallback: false
`;

describe('agents loader', () => {
  const OLD_ENV = process.env;
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...OLD_ENV };
  });

  it('performs ${ENV} interpolation for headers', () => {
    process.env.OPENAI_API_KEY = 'test-openai';
    process.env.ANTHROPIC_API_KEY = 'test-anthropic';
    process.env.OPENROUTER_API_KEY = 'test-or';
    const agents = loadFromText(baseYaml);
    expect(agents.providers.openai.headers.Authorization).toBe('Bearer test-openai');
    expect(agents.providers.anthropic.headers['x-api-key']).toBe('test-anthropic');
    expect(agents.providers.openrouter.headers.Authorization).toBe('Bearer test-or');
  });

  it('resolves model aliases per provider', () => {
    const agents = loadFromText(baseYaml);
    expect(resolveModel(agents, 'openai', 'gpt_default')).toBe('gpt-5');
    expect(resolveModel(agents, 'openrouter', 'gpt_mini')).toBe('openai/gpt-5-mini');
    // Unknown alias falls back to raw value
    expect(resolveModel(agents, 'openai', 'gpt-5')).toBe('gpt-5');
  });

  it('builds candidate lists with provider overrides and defaulting', () => {
    const agents = loadFromText(baseYaml);
    const resolved = resolveProfiles(agents);
    expect(resolved.planner[0]).toMatchObject({ provider: 'openai', model: 'gpt-5' });
    expect(resolved.planner[1]).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-4-5-20250929' });
    // fallback without provider uses primary's provider (openai)
    expect(resolved.planner[2]).toMatchObject({ provider: 'openai', model: 'gpt-5-mini' });

    expect(resolved.actor[0]).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-4-5-20250929' });
    expect(resolved.actor[1]).toMatchObject({ provider: 'openai', model: 'gpt-5' });
    // fallback without provider uses primary's provider (anthropic)
    expect(resolved.actor[2]).toMatchObject({ provider: 'anthropic', model: 'claude-haiku-4-5' });
  });

  it('throws on invalid schema (missing providers)', () => {
    const badYaml = `
version: "1"
profiles:
  planner: { provider: openai, model: gpt_default }
  actor: { provider: anthropic, model: claude_default }
codegen: { engine: cli, allow_paid_fallback: false }
`;
    expect(() => loadFromText(badYaml)).toThrow();
  });
});
