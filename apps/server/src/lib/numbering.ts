import { jalaliOf } from '@vitral/shared';
import { sql } from 'kysely';
import type { Trx } from '../db/index.js';

/**
 * Principle 11: the server assigns document numbers, unique and gap-free, inside the caller's transaction.
 * Pattern tokens: {seq} or {seq:N} (zero-padded), {yy}, {yyyy}, {mm}, {dd}, {yymmdd} — Jalali, business time zone.
 * The counter period follows the pattern: a day token resets daily, a year token yearly, otherwise never.
 * The counter row is incremented with INSERT … ON CONFLICT DO UPDATE, which row-locks it until commit,
 * so a rolled-back transaction leaves no gap.
 */
export function renderPattern(pattern: string, seq: number, at: Date, timeZone: string): string {
  const j = jalaliOf(at, timeZone);
  const p2 = (n: number): string => String(n).padStart(2, '0');
  const yy = p2(j.jy % 100);
  return pattern
    .replace(/\{seq(?::(\d+))?\}/g, (_m, w: string | undefined) => String(seq).padStart(w ? Number(w) : 1, '0'))
    .replace(/\{yymmdd\}/g, `${yy}${p2(j.jm)}${p2(j.jd)}`)
    .replace(/\{yyyy\}/g, String(j.jy))
    .replace(/\{yy\}/g, yy)
    .replace(/\{mm\}/g, p2(j.jm))
    .replace(/\{dd\}/g, p2(j.jd));
}

export function counterPeriod(pattern: string, at: Date, timeZone: string): number {
  const j = jalaliOf(at, timeZone);
  if (/\{(yymmdd|dd)\}/.test(pattern)) return j.jy * 10000 + j.jm * 100 + j.jd;
  if (/\{(yy|yyyy)\}/.test(pattern)) return j.jy;
  return 0;
}

async function setting(trx: Trx, key: string): Promise<unknown> {
  const row = await trx.selectFrom('settings').select('value').where('key', '=', key).executeTakeFirst();
  return row?.value ?? null;
}

export async function nextNumber(trx: Trx, kind: string, at: Date = new Date()): Promise<string> {
  const patterns = ((await setting(trx, 'numbering_patterns')) ?? {}) as Record<string, string>;
  const pattern = patterns[kind] ?? ((await setting(trx, 'default_numbering_pattern')) as string | null) ?? 'VT-{seq:4}';
  const timeZone = ((await setting(trx, 'time_zone')) as string | null) ?? 'Asia/Tehran';
  const period = counterPeriod(pattern, at, timeZone);
  const row = await trx
    .insertInto('counters')
    .values({ kind, year: period, last_value: 1 })
    .onConflict((oc) => oc.columns(['kind', 'year']).doUpdateSet({ last_value: sql`counters.last_value + 1` }))
    .returning('last_value')
    .executeTakeFirstOrThrow();
  return renderPattern(pattern, row.last_value, at, timeZone);
}
