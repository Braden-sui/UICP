export type ProblemDetailCategory = 'auth' | 'policy' | 'rate_limit' | 'transport' | 'schema';

export type ProviderError = {
  category: ProblemDetailCategory;
  code: string;
  retryable?: boolean;
  http_status?: number;
  upstream_code?: string | number;
  hint?: string;
  detail?: string;
};

export type ProblemDetail = {
  type?: string;
  title?: string;
  code: string;
  category: ProblemDetailCategory;
  http_status?: number;
  retryable?: boolean;
  upstream_code?: string | number;
  detail?: string;
  hint?: string;
};

export function isProblemDetail(value: unknown): value is ProblemDetail {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  const codeOk = typeof v.code === 'string' && v.code.trim().length > 0;
  const cat = v.category;
  const catOk = cat === 'auth' || cat === 'policy' || cat === 'rate_limit' || cat === 'transport' || cat === 'schema';
  return codeOk && catOk;
}

export function mapHttpStatusToCategory(status?: number): ProblemDetailCategory {
  if (status == null) return 'transport';
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'transport';
  if (status >= 400) return 'policy';
  return 'transport';
}

export function makeProblemDetailFromHttp(
  status: number,
  code: string,
  detail?: string,
  hint?: string,
  upstream_code?: string | number,
): ProblemDetail {
  const category = mapHttpStatusToCategory(status);
  const retryable = status === 429 || (status >= 500 && status < 600);
  return {
    code,
    category,
    http_status: status,
    retryable,
    upstream_code,
    detail,
    hint,
  };
}

export function mapProviderErrorToProblemDetail(err: ProviderError): ProblemDetail {
  return {
    type: undefined,
    title: undefined,
    code: err.code,
    category: err.category,
    http_status: err.http_status,
    retryable: err.retryable,
    upstream_code: err.upstream_code,
    detail: err.detail,
    hint: err.hint,
  };
}
