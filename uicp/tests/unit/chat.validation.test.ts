import { describe, it, expect } from 'vitest';
import { UICPValidationError } from '../../src/lib/uicp/schemas';
import { formatValidationErrorMessage, getValidationHint } from '../../src/state/chat';

describe('chat validation error formatting', () => {
  it('includes pointer and a helpful hint for HTML errors', () => {
    const err = new UICPValidationError('Unsafe HTML detected', '/batch/0/params/html', []);
    const message = formatValidationErrorMessage(err);
    expect(message).toContain('/batch/0/params/html');
    expect(message.toLowerCase()).toContain('hint');
    expect(getValidationHint(err.pointer).toLowerCase()).toContain('safe html');
  });
});

