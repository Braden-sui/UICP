import { describe, expect, it } from 'vitest';
import { collectToolArgs } from './collectToolArgs';
import type { StreamEvent } from './ollama';
import { LLMError, LLMErrorCode } from './errors';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('collectToolArgs', () => {
  it('times out with LLMErrorCode.ToolCollectionTimeout', async () => {
    async function* delayedStream(): AsyncIterable<StreamEvent> {
      await wait(50);
      yield { type: 'content', text: 'still running' };
    }

    await expect(collectToolArgs(delayedStream(), 'emit_plan', 10)).rejects.toMatchObject({
      code: LLMErrorCode.ToolCollectionTimeout,
    });
  });

  it('wraps JSON parse failures with LLMErrorCode.ToolArgsParseFailed', async () => {
    async function* stream(): AsyncIterable<StreamEvent> {
      yield {
        type: 'tool_call',
        index: 0,
        name: 'emit_plan',
        id: 'call-1',
        arguments: '{"summary": "oops"',
        isDelta: true,
      } satisfies StreamEvent;
      yield { type: 'done' } as StreamEvent;
    }

    await expect(collectToolArgs(stream(), 'emit_plan', 100)).rejects.toSatisfy(
      (err: unknown) => err instanceof LLMError && err.code === LLMErrorCode.ToolArgsParseFailed,
    );
  });
});
