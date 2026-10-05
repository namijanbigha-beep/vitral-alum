import type { Db } from './db/index.js';
import type { Config } from './config.js';
import { TEHRAN_OFFSET_MS, jalaliDateArg } from './lib/dates.js';
import { snapshotDailyReport } from './modules/daily/report.js';
import { jalaliKey } from './lib/dates.js';

/** Nightly daily-report snapshot at DAILY_REPORT_TIME (Tehran). Checked every minute; one snapshot per Jalali day. */
export function startScheduler(db: Db, config: Config, log: { info: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void }): () => void {
  let lastDay = '';
  const tick = async () => {
    const tehran = new Date(Date.now() + TEHRAN_OFFSET_MS);
    const hhmm = `${String(tehran.getUTCHours()).padStart(2, '0')}:${String(tehran.getUTCMinutes()).padStart(2, '0')}`;
    if (hhmm < config.DAILY_REPORT_TIME) return;
    const today = jalaliDateArg(undefined);
    const key = jalaliKey(today);
    if (key === lastDay) return;
    try {
      await snapshotDailyReport(db, today, null);
      lastDay = key;
      log.info({ date: key }, 'daily report snapshot stored');
    } catch (err) {
      log.error({ err }, 'daily report snapshot failed');
    }
  };
  const timer = setInterval(() => void tick(), 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
