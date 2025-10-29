import { describe, it, expect } from 'vitest';
import { isProblemDetail, mapProviderErrorToProblemDetail, type ProblemDetail, type ProviderError } from '../errors';

describe('ProblemDetail v1', () => {
  it('validates a proper ProblemDetail object', () => {
    const pd: ProblemDetail = {
      code: 'AuthMissing',
      category: 'auth',
      http_status: 401,
      retryable: false,
      detail: 'Missing API key',
      hint: 'Set OPENAI_API_KEY in keystore',
    };
    expect(isProblemDetail(pd)).toBe(true);
  });

  it('rejects invalid ProblemDetail objects', () => {
    expect(isProblemDetail(null)).toBe(false);
    expect(isProblemDetail({})).toBe(false);
    expect(isProblemDetail({ code: '', category: 'auth' })).toBe(false);
    expect(isProblemDetail({ code: 'X', category: 'nope' })).toBe(false);
  });

  it('maps ProviderError to ProblemDetail preserving context fields', () => {
    const err: ProviderError = {
      category: 'rate_limit',
      code: 'RateLimited',
      http_status: 429,
      retryable: true,
      upstream_code: 'rate_limit_exceeded',
      detail: 'Too many requests',
      hint: 'Honor Retry-After header and backoff',
    };
    const pd = mapProviderErrorToProblemDetail(err);
    expect(pd.code).toBe('RateLimited');
    expect(pd.category).toBe('rate_limit');
    expect(pd.http_status).toBe(429);
    expect(pd.retryable).toBe(true);
    expect(pd.upstream_code).toBe('rate_limit_exceeded');
    expect(pd.detail).toBe('Too many requests');
    expect(pd.hint).toContain('Retry-After');
  });
});
