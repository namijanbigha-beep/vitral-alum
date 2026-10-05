import { randomUUID } from 'node:crypto';

export interface BotUser { id: string; name: string; short_name: string | null; role: string; permissions: string[]; finance: boolean }
export class ApiError extends Error { constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) { super(message); } }

/** Calls the Vitral server: internal bot endpoints with the service key, and the regular API as the linked user (X-Bot-User). */
export class Api {
  constructor(private readonly base: string, private readonly key: string, private readonly fetchImpl: typeof fetch = fetch) {}

  async request<T>(method: string, path: string, opts: { user?: string | null; body?: unknown; form?: FormData; idempotent?: boolean; query?: Record<string, string | undefined> } = {}): Promise<T> {
    const url = new URL(`/api/v1${path}`, this.base);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, v);
    const headers: Record<string, string> = { 'x-bot-key': this.key, 'x-requested-with': 'vitral' };
    if (opts.user) headers['x-bot-user'] = opts.user;
    if (opts.idempotent) headers['idempotency-key'] = randomUUID();
    let body: BodyInit | undefined;
    if (opts.form) body = opts.form;
    else if (opts.body !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(opts.body); }
    const res = await this.fetchImpl(url, { method, headers, body });
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const e = (json as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
      throw new ApiError(res.status, e?.code ?? 'error', e?.message ?? `HTTP ${res.status}`, e?.details);
    }
    return json as T;
  }

  resolve(chatId: string): Promise<{ user: BotUser | null }> { return this.request('GET', '/internal/bot/resolve', { query: { chat_id: chatId } }); }
  link(chatId: string, code: string): Promise<{ user: BotUser }> { return this.request('POST', '/internal/bot/link', { body: { chat_id: chatId, code } }); }
  log(chatId: string | null, kind: string, detail?: string): Promise<unknown> { return this.request('POST', '/internal/bot/log', { body: { chat_id: chatId, kind, detail } }).catch(() => null); }
  claimNotifications(): Promise<{ items: Array<{ id: string; kind: string; title: string; chat_id: string }> }> { return this.request('POST', '/internal/bot/notifications/claim', {}); }
  reportRecipients(): Promise<{ items: Array<{ id: string; chat_id: string }> }> { return this.request('GET', '/internal/bot/report-recipients'); }
  text(user: string, what: 'report' | 'bundle' | 'order' | 'stock' | 'pending' | 'balance', query: Record<string, string | undefined> = {}): Promise<{ text: string; items?: Array<{ type: string; id: string; label: string }>; id?: string }> {
    return this.request('GET', `/internal/bot/text/${what}`, { user, query });
  }
}
