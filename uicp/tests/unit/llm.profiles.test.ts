import { describe, it, expect } from 'vitest';
import { getPlannerProfile, getActorProfile } from '../../src/lib/llm/profiles';

describe('planner profile: deepseek', () => {
  it('emits system and user messages based on the planner prompt', () => {
    const profile = getPlannerProfile('deepseek');
    const messages = profile.formatMessages('Plan a dashboard');
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(typeof messages[0].content).toBe('string');
    expect(messages[1]).toEqual({ role: 'user', content: 'Plan a dashboard' });
  });
});

describe('actor profile: qwen', () => {
  it('emits system and user messages based on the actor prompt', () => {
    const profile = getActorProfile('qwen');
    const messages = profile.formatMessages('{"summary":"Do it","batch":[]}');
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(typeof messages[0].content).toBe('string');
    expect(messages[1]).toEqual({ role: 'user', content: '{"summary":"Do it","batch":[]}' });
  });
});
