import { describe, it, expect } from 'vitest';
import { getPlannerProfile, getActorProfile } from '../../src/lib/llm/profiles';

describe('planner profile: deepseek', () => {
  it('emits system and user messages based on the planner prompt', () => {
    const profile = getPlannerProfile('deepseek');
    const messages = profile.formatMessages('Plan a dashboard');
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(typeof messages[0].content).toBe('string');
    expect(messages[1]).toEqual({ role: 'user', content: 'User intent:\nPlan a dashboard' });
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

describe('kimi profiles', () => {
  it('planner defaults to kimi model and uses planner prompt', () => {
    const profile = getPlannerProfile('kimi');
    expect(profile.defaultModel).toBe('kimi-k2:1t');
    const messages = profile.formatMessages('Sketch a layout');
    expect(messages[0].role).toBe('system');
    expect(messages[1]).toEqual({ role: 'user', content: 'User intent:\nSketch a layout' });
  });

  it('actor defaults to kimi model and uses actor prompt', () => {
    const profile = getActorProfile('kimi');
    expect(profile.defaultModel).toBe('kimi-k2:1t');
    const messages = profile.formatMessages('{"summary":"Do it","batch":[]}');
    expect(messages[0].role).toBe('system');
    expect(messages[1]).toEqual({ role: 'user', content: '{"summary":"Do it","batch":[]}' });
  });
});
