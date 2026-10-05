import type { Db, Trx } from '../db/index.js';

export async function getSetting<T = unknown>(db: Db | Trx, key: string): Promise<T | null> {
  const row = await db.selectFrom('settings').select('value').where('key', '=', key).executeTakeFirst();
  return (row?.value ?? null) as T | null;
}

export async function getSettings(db: Db | Trx, keys: string[]): Promise<Record<string, unknown>> {
  const rows = await db.selectFrom('settings').select(['key', 'value']).where('key', 'in', keys).execute();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}
