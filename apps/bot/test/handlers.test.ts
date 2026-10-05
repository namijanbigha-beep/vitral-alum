import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type Api, type BotUser } from '../src/api.js';
import { Handlers } from '../src/handlers.js';
import type { Telegram, TgCallback, TgMessage } from '../src/telegram.js';

const STAFF: BotUser = { id: '11111111-1111-4111-8111-111111111111', name: 'کارمند انبار', short_name: 'علی', role: 'staff', permissions: [], finance: false };
const MANAGER: BotUser = { id: '22222222-2222-4222-8222-222222222222', name: 'مدیر', short_name: null, role: 'manager', permissions: ['finance.view'], finance: true };

/** Fake server client: every method is a spy; `request` is routed by a table the test fills. */
function fakeApi() {
  const routes = new Map<string, (opts: { user?: string | null; body?: unknown; idempotent?: boolean; query?: Record<string, string | undefined> }) => unknown>();
  const api = {
    routes,
    resolve: vi.fn(async (_chatId: string) => ({ user: null as BotUser | null })),
    link: vi.fn(async (_chatId: string, _code: string) => ({ user: STAFF })),
    log: vi.fn(async () => null),
    claimNotifications: vi.fn(async () => ({ items: [] })),
    reportRecipients: vi.fn(async () => ({ items: [] })),
    text: vi.fn(async (_user: string, _what: string, _query?: Record<string, string | undefined>): Promise<{ text: string; items?: Array<{ type: string; id: string; label: string }>; id?: string }> => ({ text: 'متن' })),
    request: vi.fn(async (method: string, path: string, opts: { user?: string | null; body?: unknown; idempotent?: boolean; query?: Record<string, string | undefined> } = {}) => {
      const h = routes.get(`${method} ${path}`);
      if (!h) throw new ApiError(404, 'not_found', `no fake route for ${method} ${path}`);
      return h(opts);
    }),
  };
  return api;
}

function fakeTg() {
  return {
    send: vi.fn(async (_chatId: number | string, _text: string, _keyboard?: unknown) => undefined),
    answerCallback: vi.fn(async (_id: string, _text?: string) => undefined),
    download: vi.fn(async (_fileId: string) => ({ data: Buffer.from('x'), path: 'voice/file_1.oga' })),
    getUpdates: vi.fn(async () => []),
    call: vi.fn(async () => undefined),
  };
}

const msg = (chatId: number, text: string, extra: Partial<TgMessage> = {}): TgMessage => ({ message_id: 1, chat: { id: chatId, type: 'private' }, date: 0, from: { id: chatId }, text, ...extra });
const cb = (chatId: number, data: string): TgCallback => ({ id: 'cb-1', from: { id: chatId }, message: msg(chatId, 'تأییدها'), data });
const sentText = (tg: ReturnType<typeof fakeTg>): string => tg.send.mock.calls.map((c) => String(c[1])).join('\n');

let api: ReturnType<typeof fakeApi>;
let tg: ReturnType<typeof fakeTg>;
let h: Handlers;
const log = vi.fn();

beforeEach(() => {
  api = fakeApi();
  tg = fakeTg();
  log.mockReset();
  h = new Handlers(api as unknown as Api, tg as unknown as Telegram, log);
});

describe('/start <code> — linking', () => {
  it('links the chat with the six-digit code (Persian digits accepted) and greets the user', async () => {
    await h.onMessage(msg(1001, '/start ۱۲۳۴۵۶'));
    expect(api.link).toHaveBeenCalledWith('1001', '123456');
    expect(api.resolve).not.toHaveBeenCalled();
    expect(api.log).toHaveBeenCalledWith('1001', 'linked', STAFF.id);
    expect(tg.send).toHaveBeenCalledTimes(1);
    expect(sentText(tg)).toContain('خوش آمدی علی');
  });
  it('without a code it explains where to get one and calls nothing on the server', async () => {
    await h.onMessage(msg(1001, '/start'));
    expect(api.link).not.toHaveBeenCalled();
    expect(sentText(tg)).toContain('/start 123456');
  });
  it('an invalid or expired code (404) is reported and logged as link_failed', async () => {
    api.link.mockRejectedValueOnce(new ApiError(404, 'not_found', 'کد نامعتبر یا منقضی است'));
    await h.onMessage(msg(1001, '/start 999999'));
    expect(api.log).toHaveBeenCalledWith('1001', 'link_failed', '999999');
    expect(sentText(tg)).toContain('کد نامعتبر یا منقضی است');
    expect(sentText(tg)).not.toContain('خوش آمدی');
  });
});

describe('T55 — unregistered chat', () => {
  it('gets only a short "not linked" note, is logged, and no data endpoint is called', async () => {
    api.resolve.mockResolvedValueOnce({ user: null });
    await h.onMessage(msg(555, 'امروز'));
    expect(api.resolve).toHaveBeenCalledWith('555');
    expect(api.log).toHaveBeenCalledWith('555', 'unregistered', 'امروز');
    expect(api.text).not.toHaveBeenCalled();
    expect(api.request).not.toHaveBeenCalled();
    expect(tg.send).toHaveBeenCalledTimes(1);
    const text = sentText(tg);
    expect(text).toContain('متصل نیست');
    expect(text.length).toBeLessThan(200);
    expect(text).not.toMatch(/تومان|کیلو|بندیل/);
  });
  it('an unregistered callback tap is answered without acting', async () => {
    api.resolve.mockResolvedValueOnce({ user: null });
    await h.onCallback(cb(555, 'doc:post:abc'));
    expect(tg.answerCallback).toHaveBeenCalledWith('cb-1', 'این چت متصل نیست');
    expect(api.request).not.toHaveBeenCalled();
    expect(tg.send).not.toHaveBeenCalled();
  });
});

describe('امروز / گزارش — daily report text', () => {
  beforeEach(() => api.resolve.mockResolvedValue({ user: STAFF }));
  it('امروز fetches the report text for the linked user and forwards it verbatim', async () => {
    api.text.mockResolvedValueOnce({ text: 'گزارش تولید امروز\n• فریم ۳٬۱۲۴ کیلو' });
    await h.onMessage(msg(1001, 'امروز'));
    expect(api.text).toHaveBeenCalledWith(STAFF.id, 'report', { date: undefined, full: undefined });
    expect(tg.send).toHaveBeenCalledTimes(1);
    expect(tg.send.mock.calls[0]!.slice(0, 2)).toEqual(['1001', 'گزارش تولید امروز\n• فریم ۳٬۱۲۴ کیلو']);
    expect(tg.send.mock.calls[0]![2]).toBeUndefined();
  });
  it('/today works too, and «امروز کامل» asks for the full text', async () => {
    await h.onMessage(msg(1001, '/today'));
    expect(api.text).toHaveBeenLastCalledWith(STAFF.id, 'report', { date: undefined, full: undefined });
    await h.onMessage(msg(1001, 'امروز کامل'));
    expect(api.text).toHaveBeenLastCalledWith(STAFF.id, 'report', { date: undefined, full: 'true' });
  });
  it('گزارش ۱۴۰۵/۰۷/۱۰ passes the Jalali date in Latin digits', async () => {
    await h.onMessage(msg(1001, 'گزارش ۱۴۰۵/۰۷/۱۰'));
    expect(api.text).toHaveBeenCalledWith(STAFF.id, 'report', { date: '1405/07/10', full: undefined });
    await h.onMessage(msg(1001, '/report 1405-07-11'));
    expect(api.text).toHaveBeenLastCalledWith(STAFF.id, 'report', { date: '1405/07/11', full: undefined });
  });
  it('a server error becomes a short Persian message, never a stack trace', async () => {
    api.text.mockRejectedValueOnce(new ApiError(403, 'forbidden', 'x'));
    await h.onMessage(msg(1001, 'امروز'));
    expect(sentText(tg)).toBe('اجازهٔ این کار را نداری.');
    expect(log).toHaveBeenCalled();
  });
  it('مانده is refused locally for a user without finance, without calling the server', async () => {
    await h.onMessage(msg(1001, 'مانده احمدی'));
    expect(api.text).not.toHaveBeenCalled();
    expect(sentText(tg)).toContain('دسترسی مالی نداری');
  });
  it('a manager asking مانده reaches the balance endpoint', async () => {
    api.resolve.mockResolvedValue({ user: MANAGER });
    await h.onMessage(msg(2002, 'مانده احمدی'));
    expect(api.text).toHaveBeenCalledWith(MANAGER.id, 'balance', { q: 'احمدی' });
  });
});

describe('callbacks — doc:post / doc:void', () => {
  const DOC = '33333333-3333-4333-8333-333333333333';
  beforeEach(() => {
    api.resolve.mockResolvedValue({ user: MANAGER });
    api.routes.set(`GET /documents/${DOC}`, () => ({ id: DOC, version: 3, number: 'RC-0007' }));
    api.routes.set(`POST /documents/${DOC}/post`, () => ({ id: DOC, status: 'posted' }));
    api.routes.set(`POST /documents/${DOC}/void`, () => ({ id: DOC, status: 'void' }));
  });
  it('doc:post does GET then POST with the current version and an idempotency key', async () => {
    await h.onCallback(cb(2002, `doc:post:${DOC}`));
    expect(api.request).toHaveBeenCalledTimes(2);
    const [get, post] = api.request.mock.calls;
    expect(get![0]).toBe('GET');
    expect(get![1]).toBe(`/documents/${DOC}`);
    expect(get![2]).toMatchObject({ user: MANAGER.id });
    expect(post![0]).toBe('POST');
    expect(post![1]).toBe(`/documents/${DOC}/post`);
    expect(post![2]).toMatchObject({ user: MANAGER.id, body: { version: 3 }, idempotent: true });
    expect(tg.answerCallback).toHaveBeenCalledWith('cb-1', 'قطعی شد ✅');
    expect(sentText(tg)).toContain('RC-۰۰۰۷');
    expect(sentText(tg)).toContain('قطعی شد');
  });
  it('doc:void sends a reason with the version', async () => {
    await h.onCallback(cb(2002, `doc:void:${DOC}`));
    const post = api.request.mock.calls[1]!;
    expect(post[1]).toBe(`/documents/${DOC}/void`);
    expect(post[2]).toMatchObject({ body: { version: 3, reason: expect.any(String) }, idempotent: true });
    expect(sentText(tg)).toContain('باطل شد');
  });
  it('a version conflict (409) is explained and the tap is answered as not done', async () => {
    api.routes.set(`POST /documents/${DOC}/post`, () => { throw new ApiError(409, 'conflict', 'تغییر کرده'); });
    await h.onCallback(cb(2002, `doc:post:${DOC}`));
    expect(tg.answerCallback).toHaveBeenCalledWith('cb-1', 'انجام نشد');
    expect(sentText(tg)).toContain('همزمان');
  });
  it('an unknown button is answered and nothing is called', async () => {
    await h.onCallback(cb(2002, 'what:ever'));
    expect(api.request).not.toHaveBeenCalled();
    expect(tg.answerCallback).toHaveBeenCalledWith('cb-1', 'دکمهٔ ناشناخته');
  });
});

describe('تأییدها — pending list with buttons', () => {
  it('builds approve/reject buttons for documents and accept/rework/scrap for bundles', async () => {
    api.resolve.mockResolvedValue({ user: MANAGER });
    api.text.mockResolvedValueOnce({ text: '⏳ در انتظار تأیید:', items: [{ type: 'document', id: 'd1', label: 'دریافت' }, { type: 'bundle', id: 'b1', label: 'بندیل' }] });
    await h.onMessage(msg(2002, 'تأییدها'));
    expect(api.text).toHaveBeenCalledWith(MANAGER.id, 'pending');
    const keyboard = tg.send.mock.calls[0]![2] as { inline_keyboard: Array<Array<{ callback_data: string }>> };
    expect(keyboard.inline_keyboard[0]!.map((b) => b.callback_data)).toEqual(['doc:post:d1', 'doc:void:d1']);
    expect(keyboard.inline_keyboard[1]!.map((b) => b.callback_data)).toEqual(['bundle:accept:b1', 'bundle:rework:b1', 'bundle:scrap:b1']);
  });
});

describe('free text and files → free note', () => {
  beforeEach(() => {
    api.resolve.mockResolvedValue({ user: STAFF });
    api.routes.set('POST /free-notes', (o) => ({ id: 'n1', ...(o.body as object) }));
    api.routes.set('POST /files', () => ({ id: 'f1' }));
  });
  it('plain text becomes a free note with the telegram message id and an idempotency key', async () => {
    await h.onMessage(msg(1001, 'رنگ خریدم و پولش را دادم'));
    const call = api.request.mock.calls.find((c) => c[1] === '/free-notes')!;
    expect(call[0]).toBe('POST');
    expect(call[2]).toMatchObject({ user: STAFF.id, idempotent: true, body: { text: 'رنگ خریدم و پولش را دادم', file_ids: [], telegram_message_id: '1001:1' } });
    expect(sentText(tg)).toContain('یادداشت ثبت شد');
  });
  it('a voice message is downloaded, uploaded as a voice file and attached to the note', async () => {
    await h.onMessage(msg(1001, '', { text: undefined, voice: { file_id: 'v1', file_unique_id: 'u1' } }));
    expect(tg.download).toHaveBeenCalledWith('v1');
    const upload = api.request.mock.calls.find((c) => c[1] === '/files')!;
    expect(upload[2]).toMatchObject({ user: STAFF.id, idempotent: true });
    expect((upload[2] as { form: FormData }).form.get('kind')).toBe('voice');
    const note = api.request.mock.calls.find((c) => c[1] === '/free-notes')!;
    expect(note[2]).toMatchObject({ body: { file_ids: ['f1'] } });
  });
});
