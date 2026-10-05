/** Minimal Telegram Bot API client (long polling). No third-party dependency: fetch + JSON. */
export interface TgUser { id: number; first_name?: string; username?: string }
export interface TgChat { id: number; type: string }
export interface TgFile { file_id: string; file_unique_id: string; file_size?: number; mime_type?: string; duration?: number }
export interface TgMessage { message_id: number; from?: TgUser; chat: TgChat; date: number; text?: string; caption?: string; voice?: TgFile; audio?: TgFile; photo?: Array<TgFile & { width: number; height: number }>; document?: TgFile & { file_name?: string }; reply_to_message?: TgMessage }
export interface TgCallback { id: string; from: TgUser; message?: TgMessage; data?: string }
export interface TgUpdate { update_id: number; message?: TgMessage; callback_query?: TgCallback }
export interface InlineKeyboard { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }

export class Telegram {
  constructor(private readonly token: string, private readonly fetchImpl: typeof fetch = fetch) {}
  private url(method: string): string { return `https://api.telegram.org/bot${this.token}/${method}`; }

  async call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const res = await this.fetchImpl(this.url(method), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const json = (await res.json()) as { ok: boolean; result: T; description?: string };
    if (!json.ok) throw new Error(`telegram ${method}: ${json.description ?? res.status}`);
    return json.result;
  }
  getUpdates(offset: number, timeoutSeconds = 25): Promise<TgUpdate[]> {
    return this.call('getUpdates', { offset, timeout: timeoutSeconds, allowed_updates: ['message', 'callback_query'] });
  }
  /** Telegram caps a message at 4096 chars; long reports are split on line boundaries. */
  async send(chatId: number | string, text: string, keyboard?: InlineKeyboard): Promise<void> {
    const chunks: string[] = [];
    let cur = '';
    for (const line of text.split('\n')) {
      if (cur.length + line.length + 1 > 4000) { chunks.push(cur); cur = ''; }
      cur += (cur ? '\n' : '') + line;
    }
    if (cur) chunks.push(cur);
    for (let i = 0; i < chunks.length; i++) await this.call('sendMessage', { chat_id: chatId, text: chunks[i], ...(keyboard && i === chunks.length - 1 ? { reply_markup: keyboard } : {}) });
  }
  answerCallback(id: string, text?: string): Promise<unknown> { return this.call('answerCallbackQuery', { callback_query_id: id, text }); }
  async download(fileId: string): Promise<{ data: Buffer; path: string }> {
    const f = await this.call<{ file_path: string }>('getFile', { file_id: fileId });
    const res = await this.fetchImpl(`https://api.telegram.org/file/bot${this.token}/${f.file_path}`);
    if (!res.ok) throw new Error(`telegram download ${res.status}`);
    return { data: Buffer.from(await res.arrayBuffer()), path: f.file_path };
  }
}
