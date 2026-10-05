import { Api } from './api.js';
import { loadConfig } from './config.js';
import { Handlers } from './handlers.js';
import { Telegram } from './telegram.js';

const TEHRAN_OFFSET_MS = 3.5 * 60 * 60 * 1000;
const config = loadConfig();
const log = (o: unknown, m?: string) => { if (config.LOG_LEVEL !== 'silent') console.log(JSON.stringify({ t: new Date().toISOString(), m, ...(typeof o === 'object' && o ? o : { o }) })); };
const api = new Api(config.SERVER_URL, config.BOT_SERVICE_KEY);
const tg = new Telegram(config.TELEGRAM_BOT_TOKEN);
const handlers = new Handlers(api, tg, log, { publicUrl: config.PUBLIC_URL });
let running = true;

/** Long polling: one update at a time, in order; a failing update is logged and skipped so the queue never stalls. */
async function poll(): Promise<void> {
  let offset = 0;
  while (running) {
    try {
      const updates = await tg.getUpdates(offset);
      for (const u of updates) {
        offset = u.update_id + 1;
        try {
          if (u.message) await handlers.onMessage(u.message);
          else if (u.callback_query) await handlers.onCallback(u.callback_query);
        } catch (err) { log({ err: String(err), update: u.update_id }, 'update failed'); }
      }
    } catch (err) {
      log({ err: String(err) }, 'getUpdates failed');
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

/** Instant alerts: notifications the server queued for linked users (quarantine, weight warnings, pending money…). */
async function alerts(): Promise<void> {
  while (running) {
    try {
      const { items } = await api.claimNotifications();
      for (const n of items) await tg.send(n.chat_id, `🔔 ${n.title}`).catch((e) => log({ err: String(e), id: n.id }, 'alert send failed'));
    } catch (err) { log({ err: String(err) }, 'claim failed'); }
    await new Promise((r) => setTimeout(r, config.ALERT_POLL_SECONDS * 1000));
  }
}

/** Nightly report to managers at DAILY_REPORT_TIME Tehran (spec §16); once per day. */
async function nightly(): Promise<void> {
  let lastDay = '';
  while (running) {
    const tehran = new Date(Date.now() + TEHRAN_OFFSET_MS);
    const hhmm = `${String(tehran.getUTCHours()).padStart(2, '0')}:${String(tehran.getUTCMinutes()).padStart(2, '0')}`;
    const day = tehran.toISOString().slice(0, 10);
    if (hhmm >= config.DAILY_REPORT_TIME && day !== lastDay) {
      lastDay = day;
      try {
        const { items } = await api.reportRecipients();
        for (const r of items) {
          const t = await api.text(r.id, 'report', { full: 'true' });
          await tg.send(r.chat_id, `🌙 گزارش شب\n\n${t.text}`).catch((e) => log({ err: String(e), user: r.id }, 'nightly send failed'));
        }
        log({ recipients: items.length }, 'nightly report sent');
      } catch (err) { log({ err: String(err) }, 'nightly failed'); }
    }
    await new Promise((r) => setTimeout(r, 60_000));
  }
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { running = false; setTimeout(() => process.exit(0), 500); });
log({ server: config.SERVER_URL }, 'vitral bot starting');
await Promise.all([poll(), alerts(), nightly()]);
