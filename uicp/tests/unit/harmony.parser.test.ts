import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parseHarmonyTurn } from '../../src/lib/llm/harmony';

type ExpectedEntry = {
  role: 'assistant' | 'tool';
  channel: string;
  content?: unknown;
  to?: string;
  name?: string;
  args?: unknown;
};

const DOC_PATH = resolve(process.cwd(), '..', 'docs/harmony-samples.md');

const DOC = readFileSync(DOC_PATH, 'utf8');

const HARMONY_REGEX = /```harmony name:([^\n]+)\n([\s\S]*?)```/g;

function parseExpected(caseName: string): ExpectedEntry[] | { error: unknown } {
  const escaped = caseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp('```expected name:' + escaped + '\\n([\\s\\S]*?)```').exec(DOC);
  if (!match) throw new Error(`Missing expected block for ${caseName}`);
  const text = match[1].trim();
  if (text.startsWith('{') && !text.startsWith('[')) {
    return { error: JSON.parse(text) };
  }
  return JSON.parse(text) as ExpectedEntry[];
}

function normalizeMessages(result: ReturnType<typeof parseHarmonyTurn>): unknown {
  if ('error' in result) return result.error;
  return result.messages.map((msg) => {
    const base: Record<string, unknown> = {
      role: msg.role,
      channel: msg.channel,
    };
    if (msg.role === 'assistant') {
      if (msg.to) base.to = msg.to;
      if (msg.args !== undefined) base.args = msg.args;
      if (msg.args === undefined && msg.content !== undefined) {
        base.content = msg.content.trim();
      }
    } else {
      if (msg.name) base.name = msg.name;
      if (msg.content !== undefined) {
        base.content = msg.content;
      }
    }
    if (msg.role === 'assistant' && msg.channel === 'commentary' && msg.args !== undefined) {
      base.args = msg.args;
    }
    return base;
  });
}

describe('Harmony parser synthetic samples', () => {
  const cases: Array<{ name: string; harmony: string; expected: ExpectedEntry[] | { error: unknown } }> = [];
  let match: RegExpExecArray | null;
  while ((match = HARMONY_REGEX.exec(DOC)) !== null) {
    const name = match[1].trim();
    const harmonyText = match[2];
    const expected = parseExpected(name);
    cases.push({ name, harmony: harmonyText, expected });
  }

  it('captures all documented cases', () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  for (const testCase of cases) {
    it(`parses ${testCase.name}`, () => {
      const result = parseHarmonyTurn(testCase.harmony);
      if (Array.isArray(testCase.expected)) {
        expect('error' in result).toBe(false);
        const normalized = normalizeMessages(result);
        expect(normalized).toEqual(testCase.expected);
      } else {
        expect('error' in result).toBe(true);
        if ('error' in result) {
          const expectedError = testCase.expected.error as { error: string };
          expect(result.error.code).toBe(expectedError.error);
        }
      }
    });
  }
});
