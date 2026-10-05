import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { api, ApiRequestError, newRequestId } from '../api/client.js';

export interface Page<T> { items: T[]; next_cursor: string | null }

export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : '';
}

/** Cursor-paginated list with accumulated pages (spec §9 pagination). */
export function useList<T>(path: string, params: Record<string, string | number | boolean | null | undefined> = {}, opts: { enabled?: boolean; limit?: number } = {}) {
  const [cursors, setCursors] = useState<string[]>([]);
  const key = ['list', path, params, cursors];
  const q = useQuery({
    queryKey: key,
    queryFn: async () => {
      const pages: Page<T>[] = [];
      let cursor: string | undefined;
      for (let i = 0; i <= cursors.length; i++) {
        const p = await api<Page<T>>('GET', `${path}${qs({ ...params, limit: opts.limit ?? 50, cursor: i === 0 ? undefined : cursors[i - 1] })}`);
        pages.push(p);
        cursor = p.next_cursor ?? undefined;
        if (!cursor) break;
      }
      return { items: pages.flatMap((p) => p.items), next: pages[pages.length - 1]?.next_cursor ?? null };
    },
    enabled: opts.enabled ?? true,
    placeholderData: (prev) => prev,
  });
  const more = useCallback(() => { if (q.data?.next) setCursors((c) => [...c, q.data!.next!]); }, [q.data]);
  return { ...q, items: q.data?.items ?? [], hasMore: !!q.data?.next, more, reset: () => setCursors([]) };
}

export function useOne<T>(path: string | null, options: Partial<UseQueryOptions<T>> = {}) {
  return useQuery<T>({ queryKey: ['one', path], queryFn: () => api<T>('GET', path!), enabled: !!path, ...options } as UseQueryOptions<T>);
}

export interface ActResult { conflict?: Record<string, unknown>; message?: string; fields?: Record<string, string> }

/**
 * Definitive write: fresh Idempotency-Key per attempt (reused on retry of the same attempt), 409 → `conflict` carries the
 * server's current row so the form can show the diff instead of silently overwriting (spec principle 5).
 */
export function useAct<TBody = unknown, TRes = unknown>(method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string | ((body: TBody) => string), opts: { invalidate?: string[][]; onSuccess?: (r: TRes, body: TBody) => void } = {}) {
  const qc = useQueryClient();
  const [requestId, setRequestId] = useState(newRequestId);
  const [error, setError] = useState<ActResult | null>(null);
  const m = useMutation({
    mutationFn: (body: TBody) => api<TRes>(method, typeof path === 'function' ? path(body) : path, { body: method === 'DELETE' ? undefined : body, idempotencyKey: requestId }),
    onSuccess: (r, body) => {
      setRequestId(newRequestId()); setError(null);
      for (const k of opts.invalidate ?? [['list'], ['one']]) void qc.invalidateQueries({ queryKey: k });
      opts.onSuccess?.(r, body);
    },
    onError: (e) => {
      if (e instanceof ApiRequestError) {
        if (e.status === 409) { setError({ conflict: (e.body as { current?: Record<string, unknown> }).current ?? {}, message: e.body.message }); setRequestId(newRequestId()); }
        else if (e.status >= 400 && e.status < 500 && e.status !== 0) { setError({ message: e.body.message, fields: e.body.fields ?? {} }); setRequestId(newRequestId()); }
        else setError({ message: e.body.message });
      } else setError({ message: 'خطای ناشناخته' });
    },
  });
  return { ...m, error, clearError: () => setError(null) };
}

export async function downloadBlob(url: string, filename: string): Promise<void> {
  const res = await fetch(`/api/v1${url}`, { credentials: 'same-origin', headers: { 'X-Requested-With': 'vitral' } });
  if (!res.ok) throw new Error(`download ${res.status}`);
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

export function useLocalState<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => { try { const s = localStorage.getItem(key); return s ? (JSON.parse(s) as T) : initial; } catch { return initial; } });
  return [v, (n: T) => { setV(n); try { localStorage.setItem(key, JSON.stringify(n)); } catch { /* private mode */ } }];
}
export const newRequestIdSafe = (): string => crypto.randomUUID();
