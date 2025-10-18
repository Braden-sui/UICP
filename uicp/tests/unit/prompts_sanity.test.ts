import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const normalize = (input: string): string =>
  input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

describe('prompts sanity', () => {
  it('actor prompt forbids placeholder values', () => {
    const text = readFileSync(join(__dirname, '../../src/prompts/actor.txt'), 'utf8');
    expect(normalize(text)).toContain(normalize('never use placeholders like todo xxx lorem'));
  });

  it('planner prompt forbids visible placeholder filler text', () => {
    const text = readFileSync(join(__dirname, '../../src/prompts/planner.txt'), 'utf8');
    expect(normalize(text)).toContain(
      normalize('no placeholders you must not include todo xxx lorem or other placeholder text in any user visible strings'),
    );
  });
});
