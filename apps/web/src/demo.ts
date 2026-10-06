/**
 * Demo build (VITE_DEMO=1): the whole app as one HTML file that opens with a double-click, no server.
 * Every API read is answered from responses recorded on a real server with sample data (embedded in
 * <script id="vitral-demo-data">); writes are refused with a clear message, so nothing pretends to be saved.
 */
type Rec = { s: number; t: string; b: string };

export const DEMO_MSG = 'این نسخه‌ی نمایشی است؛ تغییرات ذخیره نمی‌شود.';

/** Same normalisation as the recorder: path after /api/v1 plus the query sorted by key. */
export function demoKey(rel: string): string {
  const [path = '', query = ''] = rel.split('?');
  const params = new URLSearchParams(query);
  const pairs = [...params.entries()].filter(([, v]) => v !== '').sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return pairs.length ? `${path}?${new URLSearchParams(pairs).toString()}` : path;
}

const el = typeof document !== 'undefined' ? document.getElementById('vitral-demo-data') : null;
const data: Record<string, Rec> = el?.textContent ? (JSON.parse(el.textContent) as Record<string, Rec>) : {};
const keys = Object.keys(data);
// Printable documents share one embedded font, stored once next to the data.
const font = typeof document !== 'undefined' ? document.getElementById('vitral-demo-font')?.textContent ?? '' : '';
for (const r of Object.values(data)) if (font && r.t.startsWith('text/html')) r.b = r.b.split('__VITRAL_FONT__').join(font);

function lookup(rel: string): Rec | null {
  let key = demoKey(rel);
  // PDF/PNG buttons: the demo carries the printable HTML of each document instead.
  key = key.replace(/([?&])format=(pdf|png)/, '$1format=html');
  if (data[key]) return data[key]!;
  const path = key.split('?')[0]!;
  const noCursor = demoKey(key.replace(/([?&])cursor=[^&]*/, ''));
  if (data[noCursor]) return data[noCursor]!;
  if (data[path]) return data[path]!;
  const sibling = keys.find((k) => k.split('?')[0] === path);
  return sibling ? data[sibling]! : null;
}

const UUID_END = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function answer(rel: string): Response {
  const r = lookup(rel);
  if (r) return new Response(r.b, { status: r.s, headers: { 'content-type': r.t } });
  const path = rel.split('?')[0]!;
  if (!UUID_END.test(path) && !/\/(pdf|html|xlsx|zip|label|proforma|packing-list|commercial-invoice)$/.test(path)) return json(200, { items: [], next_cursor: null });
  return json(404, { error: { code: 'not_found', message: 'این مورد در داده‌ی نمونه‌ی نسخه‌ی نمایشی نیست.' } });
}

function relOf(url: string): string | null {
  const i = url.indexOf('api/v1');
  return i < 0 ? null : url.slice(i + 'api/v1'.length);
}

let loggedOut = false;

export function installDemo(): void {
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const rel = relOf(url);
    if (rel === null) return realFetch(input, init);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (loggedOut && rel.startsWith('/auth/me')) return json(401, { error: { code: 'unauthorized', message: 'وارد نشده‌اید' } });
    if (method === 'GET' || method === 'HEAD') return answer(rel);
    if (rel.startsWith('/auth/logout')) { loggedOut = true; return new Response(null, { status: 204 }); }
    // Any mobile/password logs back in as the sample manager.
    if (rel.startsWith('/auth/login')) { loggedOut = false; return json(200, {}); }
    return json(400, { error: { code: 'validation', message: DEMO_MSG } });
  };

  const realOpen = window.open.bind(window);
  window.open = (url?: string | URL, target?: string, features?: string) => {
    const rel = url ? relOf(String(url)) : null;
    if (rel === null) return realOpen(url, target, features);
    const r = lookup(rel);
    if (!r || !r.t.startsWith('text/html')) { window.alert('پیش‌نمایش این سند در نسخه‌ی نمایشی نیست.'); return null; }
    return realOpen(URL.createObjectURL(new Blob([r.b], { type: 'text/html' })), '_blank', features);
  };

  const bar = document.createElement('div');
  bar.textContent = 'نسخه‌ی نمایشی با داده‌ی نمونه — چیزی ذخیره نمی‌شود';
  bar.setAttribute('style', 'position:fixed;inset-inline:0;top:64px;z-index:9999;margin:0 auto;width:max-content;max-width:92vw;padding:4px 12px;border-radius:999px;background:#fff4ce;color:#5c4400;font-size:13px;box-shadow:0 1px 4px rgba(0,0,0,.15);pointer-events:none;opacity:.95');
  document.body.appendChild(bar);
}
