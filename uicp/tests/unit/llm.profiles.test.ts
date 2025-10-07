import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ToolSpec } from '../../src/lib/llm/ollama';
import { getPlannerProfile, getActorProfile } from '../../src/lib/llm/profiles';

const sampleTools: ToolSpec[] = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Fetches the current weather for a city.',
      parameters: {
        type: 'object',
        properties: {
          location: {
            type: 'string',
            description: 'City name, e.g. San Francisco, CA.',
          },
          format: {
            type: 'string',
            enum: ['celsius', 'fahrenheit'],
            default: 'celsius',
          },
        },
        required: ['location'],
      },
    },
  },
];

describe('gpt-oss profile formatting', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-02T03:04:05Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('planner system message mirrors Harmony guidance', () => {
    const profile = getPlannerProfile('gpt-oss');
    const messages = profile.formatMessages('Design a notepad app', { tools: sampleTools });
    expect(messages).toHaveLength(3);
    const [system, developer, user] = messages;

    expect(system.role).toBe('system');
    expect(system.content).toContain('You are ChatGPT, a large language model trained by OpenAI.');
    expect(system.content).toContain('Knowledge cutoff: 2024-06');
    expect(system.content).toContain('Current date: 2025-01-02');
    expect(system.content).toContain("Calls to these tools must go to the commentary channel: 'functions'.");

    expect(developer.role).toBe('developer');
    expect(developer.content).toContain('# Harmony Output Requirements');
    expect(developer.content).toContain('# Structured Output Format');
    expect(developer.content).toContain('namespace functions {');
    expect(developer.content).toContain('type get_weather');
    expect(developer.content).toContain('JSON object');

    expect(user.role).toBe('user');
    expect(user.content).toBe('Design a notepad app');
  });

  it('actor system message omits tool reminder when no tools are provided', () => {
    const profile = getActorProfile('gpt-oss');
    const messages = profile.formatMessages('{"summary":"stub","risks":[],"batch":[]}', {});
    expect(messages).toHaveLength(3);
    const [system, developer] = messages;

    expect(system.role).toBe('system');
    expect(system.content).toContain('# Valid channels: analysis, commentary, final');
    expect(system.content).not.toContain('Calls to these tools');

    expect(developer.role).toBe('developer');
    expect(developer.content).toContain('# Structured Output Format');
    expect(developer.content).toContain('Respond with JSON');
  });
});
