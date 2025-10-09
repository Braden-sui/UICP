import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('prompts sanity', () => {
  it('actor prompt forbids placeholder HTML', () => {
    const text = readFileSync(join(__dirname, '../../src/prompts/actor.txt'), 'utf8');
    expect(text.toLowerCase()).toContain('never leave `html` undefined or placeholder text'.toLowerCase());
  });

  it('planner prompt forbids visible placeholder filler text', () => {
    const text = readFileSync(join(__dirname, '../../src/prompts/planner.txt'), 'utf8');
    expect(text.toLowerCase()).toContain('do not use the literal word "placeholder" in any visible text'.toLowerCase());
  });
});

