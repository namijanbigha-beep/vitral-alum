import { toLatinDigits, toPersianDigits } from '@vitral/shared';
import { Api, ApiError, type BotUser } from './api.js';
import type { InlineKeyboard, Telegram, TgCallback, TgMessage } from './telegram.js';

const HELP = [
  'دستورها (فارسی یا انگلیسی):',
  '• امروز — گزارش تولید امروز',
  '• گزارش ۱۴۰۵/۰۷/۱۲ — گزارش یک روز',
  '• بندیل VT-0012 — وضعیت یک بندیل',
  '• سفارش VT-0003 — وضعیت یک سفارش',
  '• انبار — موجودی به کیلو',
  '• تأییدها — موارد در انتظار تأیید (با دکمه تأیید/رد)',
  '• کار متن کار — ثبت کار برای خودت؛ «کار @علی متن» برای دیگری',
  '• کارها — کارهای باز من',
  '• مانده نام طرف — مانده حساب (فقط مالی)',
  '• هر متن دیگر، ویس یا عکس → یادداشت آزاد',
].join('\n');

const persianWords: Record<string, string> = { امروز: 'today', گزارش: 'report', بندیل: 'bundle', سفارش: 'order', انبار: 'stock', تأییدها: 'pending', تاییدها: 'pending', کار: 'task', کارها: 'tasks', مانده: 'balance', راهنما: 'help', یادداشت: 'note', today: 'today', report: 'report', bundle: 'bundle', order: 'order', stock: 'stock', pending: 'pending', task: 'task', tasks: 'tasks', balance: 'balance', help: 'help', note: 'note', start: 'start' };

function parse(text: string): { cmd: string | null; arg: string } {
  const t = text.trim().replace(/^\//, '');
  const [head = '', ...rest] = t.split(/\s+/);
  const cmd = persianWords[head.toLowerCase()] ?? null;
  return { cmd, arg: rest.join(' ').trim() };
}

function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 403) return 'اجازهٔ این کار را نداری.';
    if (e.status === 409) return 'این مورد همزمان توسط شخص دیگری تغییر کرده؛ دوباره «تأییدها» را بزن.';
    const d = e.details && typeof e.details === 'object' ? Object.entries(e.details as Record<string, string>).map(([k, v]) => `${k}: ${v}`).join('، ') : '';
    return `${e.message}${d ? ` (${d})` : ''}`;
  }
  return 'خطای غیرمنتظره؛ بعداً دوباره تلاش کن.';
}

export class Handlers {
  constructor(private readonly api: Api, private readonly tg: Telegram, private readonly log: (o: unknown, m?: string) => void) {}

  async onMessage(m: TgMessage): Promise<void> {
    const chatId = String(m.chat.id);
    const text = m.text ?? m.caption ?? '';
    const { cmd, arg } = parse(text);
    if (cmd === 'start') return this.start(chatId, arg);

    const { user } = await this.api.resolve(chatId);
    if (!user) {
      // T55: unregistered chats are logged and told how to link; nothing else leaks.
      await this.api.log(chatId, 'unregistered', text.slice(0, 200));
      await this.tg.send(chatId, 'این چت به حسابی متصل نیست. در برنامه، از «پروفایل → اتصال تلگرام» کد بگیر و بفرست:\n/start 123456');
      return;
    }
    try {
      if (m.voice || m.audio) return await this.noteWithFile(user, chatId, m, (m.voice ?? m.audio)!.file_id, 'voice', text);
      if (m.photo?.length) return await this.noteWithFile(user, chatId, m, m.photo[m.photo.length - 1]!.file_id, 'photo', text);
      if (m.document) return await this.noteWithFile(user, chatId, m, m.document.file_id, 'document', text);
      switch (cmd) {
        case 'help': return await this.tg.send(chatId, HELP);
        case 'today': return await this.report(user, chatId, undefined, /کامل|full/.test(arg));
        case 'report': return await this.report(user, chatId, arg ? toLatinDigits(arg.replace(/[-.]/g, '/')) : undefined, /کامل|full/.test(arg));
        case 'bundle': { if (!arg) return await this.tg.send(chatId, 'کد بندیل را بنویس: بندیل VT-0012'); const r = await this.api.text(user.id, 'bundle', { code: toLatinDigits(arg) }); return await this.tg.send(chatId, r.text); }
        case 'order': { if (!arg) return await this.tg.send(chatId, 'شمارهٔ سفارش را بنویس: سفارش VT-0003'); const r = await this.api.text(user.id, 'order', { number: toLatinDigits(arg) }); return await this.tg.send(chatId, r.text); }
        case 'stock': { const r = await this.api.text(user.id, 'stock'); return await this.tg.send(chatId, r.text); }
        case 'pending': return await this.pending(user, chatId);
        case 'task': return await this.task(user, chatId, arg);
        case 'tasks': return await this.tasks(user, chatId);
        case 'balance': { if (!user.finance) return await this.tg.send(chatId, 'دسترسی مالی نداری.'); if (!arg) return await this.tg.send(chatId, 'نام طرف حساب را بنویس: مانده احمدی'); const r = await this.api.text(user.id, 'balance', { q: arg }); return await this.tg.send(chatId, r.text); }
        case 'note': return await this.note(user, chatId, m, arg);
        default: return await this.note(user, chatId, m, text);
      }
    } catch (e) {
      this.log({ err: String(e), chatId, text: text.slice(0, 80) }, 'handler error');
      await this.tg.send(chatId, errorText(e));
    }
  }

  private async start(chatId: string, code: string): Promise<void> {
    const c = toLatinDigits(code).replace(/\D/g, '');
    if (c.length !== 6) { await this.tg.send(chatId, 'سلام! برای اتصال، کد ۶ رقمی را از برنامه (پروفایل → اتصال تلگرام) بگیر و بفرست:\n/start 123456'); return; }
    try {
      const r = await this.api.link(chatId, c);
      await this.api.log(chatId, 'linked', r.user.id);
      await this.tg.send(chatId, `خوش آمدی ${r.user.short_name ?? r.user.name} ✅\n\n${HELP}`);
    } catch (e) {
      await this.api.log(chatId, 'link_failed', c);
      await this.tg.send(chatId, e instanceof ApiError && e.status === 404 ? 'کد نامعتبر یا منقضی است؛ کد تازه بگیر.' : errorText(e));
    }
  }

  private async report(user: BotUser, chatId: string, date: string | undefined, full: boolean): Promise<void> {
    const r = await this.api.text(user.id, 'report', { date, full: full ? 'true' : undefined });
    await this.tg.send(chatId, r.text);
  }

  private async pending(user: BotUser, chatId: string): Promise<void> {
    const r = await this.api.text(user.id, 'pending');
    const rows = (r.items ?? []).slice(0, 10);
    const keyboard: InlineKeyboard | undefined = rows.length ? { inline_keyboard: rows.map((it, i) => it.type === 'document' ? [{ text: `✅ تأیید ${toPersianDigits(String(i + 1))}`, callback_data: `doc:post:${it.id}` }, { text: `❌ رد ${toPersianDigits(String(i + 1))}`, callback_data: `doc:void:${it.id}` }] : [{ text: `✔ قبول ${toPersianDigits(String(i + 1))}`, callback_data: `bundle:accept:${it.id}` }, { text: `🔁 بازکاری ${toPersianDigits(String(i + 1))}`, callback_data: `bundle:rework:${it.id}` }, { text: `♻ ضایعات ${toPersianDigits(String(i + 1))}`, callback_data: `bundle:scrap:${it.id}` }]) } : undefined;
    await this.tg.send(chatId, r.text, keyboard);
  }

  /** Inline buttons → the same definitive endpoints the web uses, with a fresh Idempotency-Key per tap. */
  async onCallback(cb: TgCallback): Promise<void> {
    const chatId = cb.message ? String(cb.message.chat.id) : String(cb.from.id);
    const { user } = await this.api.resolve(chatId);
    if (!user) { await this.tg.answerCallback(cb.id, 'این چت متصل نیست'); return; }
    const [kind, action, id] = (cb.data ?? '').split(':');
    try {
      if (kind === 'task' && action === 'done' && id) return await this.onTaskDone(cb, user, id);
      if (kind === 'doc' && id) {
        const d = await this.api.request<{ version: number; number: string }>('GET', `/documents/${id}`, { user: user.id });
        if (action === 'post') { await this.api.request('POST', `/documents/${id}/post`, { user: user.id, body: { version: d.version }, idempotent: true }); await this.tg.answerCallback(cb.id, 'قطعی شد ✅'); await this.tg.send(chatId, `سند ${toPersianDigits(d.number)} قطعی شد ✅`); }
        else { await this.api.request('POST', `/documents/${id}/void`, { user: user.id, body: { version: d.version, reason: 'رد از تلگرام' }, idempotent: true }); await this.tg.answerCallback(cb.id, 'رد شد'); await this.tg.send(chatId, `سند ${toPersianDigits(d.number)} رد و باطل شد ❌`); }
        return;
      }
      if (kind === 'bundle' && id && (action === 'accept' || action === 'rework' || action === 'scrap')) {
        const b = await this.api.request<{ version: number; code: string }>('GET', `/bundles/${id}`, { user: user.id });
        await this.api.request('POST', `/bundles/${id}/decide`, { user: user.id, body: { version: b.version, decision: action, note: 'تصمیم از تلگرام' }, idempotent: true });
        await this.tg.answerCallback(cb.id, 'ثبت شد');
        await this.tg.send(chatId, `بندیل ${toPersianDigits(b.code)}: ${action === 'accept' ? 'قبول شد ✔' : action === 'rework' ? 'به بازکاری رفت 🔁' : 'به ضایعات رفت ♻'}`);
        return;
      }
      await this.tg.answerCallback(cb.id, 'دکمهٔ ناشناخته');
    } catch (e) {
      await this.tg.answerCallback(cb.id, 'انجام نشد');
      await this.tg.send(chatId, errorText(e));
    }
  }

  private async task(user: BotUser, chatId: string, arg: string): Promise<void> {
    if (!arg) { await this.tg.send(chatId, 'متن کار را بنویس: کار زنگ به کارخانه'); return; }
    let assignee = user.id;
    let title = arg;
    const m = arg.match(/^@(\S+)\s+(.+)$/s);
    if (m) {
      const users = await this.api.request<{ items: Array<{ id: string; name: string; short_name: string | null }> }>('GET', '/users/directory', { user: user.id });
      const found = users.items.find((u) => u.short_name === m[1] || u.name.includes(m[1]!)) ?? users.items[0];
      if (!found) { await this.tg.send(chatId, `کاربری با نام «${m[1]}» پیدا نشد.`); return; }
      assignee = found.id; title = m[2]!;
    }
    const t = await this.api.request<{ id: string; title: string }>('POST', '/tasks', { user: user.id, body: { title: title.slice(0, 200), assignee_user_id: assignee }, idempotent: true });
    await this.tg.send(chatId, `کار ثبت شد 📝 «${t.title}»`);
  }

  private async tasks(user: BotUser, chatId: string): Promise<void> {
    const r = await this.api.request<{ items: Array<{ id: string; title: string; due_at: string | null }> }>('GET', '/tasks', { user: user.id, query: { status: 'open', assignee_user_id: user.id, limit: '20' } });
    if (!r.items.length) { await this.tg.send(chatId, 'کار بازی نداری ✅'); return; }
    await this.tg.send(chatId, ['📝 کارهای باز:', ...r.items.map((t, i) => `${toPersianDigits(String(i + 1))}. ${t.title}`)].join('\n'), { inline_keyboard: r.items.slice(0, 8).map((t, i) => [{ text: `✅ انجام شد ${toPersianDigits(String(i + 1))}`, callback_data: `task:done:${t.id}` }]) });
  }

  /** Free text → free note (spec module 8); the reviewer converts it later. */
  private async note(user: BotUser, chatId: string, m: TgMessage, text: string, fileIds: string[] = []): Promise<void> {
    if (!text.trim() && !fileIds.length) { await this.tg.send(chatId, HELP); return; }
    const n = await this.api.request<{ id: string }>('POST', '/free-notes', { user: user.id, body: { text: text.trim() || (fileIds.length ? 'پیوست از تلگرام' : ''), file_ids: fileIds, telegram_message_id: `${m.chat.id}:${m.message_id}` }, idempotent: true });
    await this.tg.send(chatId, `یادداشت ثبت شد 🗒 (${fileIds.length ? 'با پیوست، ' : ''}بررسی می‌شود)`);
    void n;
  }

  private async noteWithFile(user: BotUser, chatId: string, m: TgMessage, fileId: string, kind: 'voice' | 'photo' | 'document', caption: string): Promise<void> {
    const { data, path } = await this.tg.download(fileId);
    const name = path.split('/').pop() ?? `${kind}.bin`;
    const form = new FormData();
    form.set('kind', kind === 'voice' ? 'voice' : 'other');
    form.set('owner_entity', 'free_notes');
    form.set('file', new Blob([new Uint8Array(data)]), name);
    const f = await this.api.request<{ id: string }>('POST', '/files', { user: user.id, form, idempotent: true });
    // A photo whose caption names a bundle code is attached to that bundle too (spec §16 photo flow).
    const code = toLatinDigits(caption).match(/\b(?:VT|TMP)-[A-Z0-9-]+\b/i)?.[0];
    if (kind === 'photo' && code) {
      const r = await this.api.text(user.id, 'bundle', { code });
      if (r.id) { await this.api.request('POST', `/bundles/${r.id}/files`, { user: user.id, body: { file_ids: [f.id] }, idempotent: true }); await this.tg.send(chatId, `عکس به بندیل ${toPersianDigits(code.toUpperCase())} پیوست شد 📷`); return; }
    }
    await this.note(user, chatId, m, caption, [f.id]);
  }

  async onTaskDone(cb: TgCallback, user: BotUser, id: string): Promise<void> {
    const t = await this.api.request<{ version: number; title: string }>('GET', `/tasks/${id}`, { user: user.id });
    await this.api.request('POST', `/tasks/${id}/done`, { user: user.id, body: { version: t.version }, idempotent: true });
    await this.tg.answerCallback(cb.id, 'انجام شد ✅');
  }
}
