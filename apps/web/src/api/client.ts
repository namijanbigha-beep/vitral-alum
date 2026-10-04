import type { ApiError } from '@vitral/shared';

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiError['error'],
  ) {
    super(body.message);
  }
}

export const isOffline = (): boolean => typeof navigator !== 'undefined' && navigator.onLine === false;

export async function api<T>(
  method: string,
  url: string,
  opts: { body?: unknown; idempotencyKey?: string; form?: FormData } = {},
): Promise<T> {
  const headers: Record<string, string> = { 'X-Requested-With': 'vitral', Accept: 'application/json' };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  let res: Response;
  try {
    res = await fetch(`/api/v1${url}`, {
      method,
      headers,
      credentials: 'same-origin',
      body: opts.form ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
    });
  } catch {
    // Never a false success: the network failed before the server answered.
    throw new ApiRequestError(0, { code: 'validation', message: 'اتصال اینترنت برقرار نیست؛ ثبت نشد' });
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const err = (json as ApiError | null)?.error ?? { code: 'validation' as const, message: 'خطای ناشناخته' };
    throw new ApiRequestError(res.status, err);
  }
  return json as T;
}

export const newRequestId = (): string => crypto.randomUUID();
