import { Dec, formatJalali, round, toPersianDigits, type JalaliDate } from '@vitral/shared';
import { sql } from 'kysely';
import type { Db, Trx } from '../../db/index.js';
import { jalaliDayRange, jalaliToDateKey } from '../../lib/dates.js';
import { bundleWeightPerMeter } from '../../rules/production.js';

export interface ReportBundleLine { product_id: string; product_name: string; weight_kg: string | null; bars: number | null; length_m: string | null; g_per_m: string | null }
export interface ReportBundleRow { id: string; code: string; code_is_temp: boolean; weight_kg: string; status: string; mixed: boolean; warnings: unknown; lines: ReportBundleLine[]; factory_name: string | null; run_number: string | null; note: string | null }
export interface ProductGroup { product_id: string; product_name: string; total_kg: string; bundles: Array<{ code: string; weight_kg: string; bars: number | null; g_per_m: string | null; note: string | null; mixed: boolean; status: string }> }

export interface DailyReport {
  date: string;
  generated_at: string;
  decisions: { quarantine: Array<Record<string, unknown>>; weight_warnings: Array<Record<string, unknown>>; incomplete_documents: Array<Record<string, unknown>>; pending_money: number };
  production: { groups: ProductGroup[]; total_kg: string; bundle_count: number; text: string; text_full: string; bundles: ReportBundleRow[] };
  transfers: Array<Record<string, unknown>>;
  filler_checks: Array<Record<string, unknown>>;
  money: Array<Record<string, unknown>> | null;
  free_notes: Array<Record<string, unknown>>;
  tasks: { closed: Array<Record<string, unknown>>; open: Array<Record<string, unknown>> };
}

const kg = (v: string | Dec): string => toPersianDigits(new Dec(v).toFixed(3).replace(/\.?0+$/, ''));

/** Section 2 text in the exact shape of the staff's Telegram message (spec §12-a). */
export function productionText(groups: ProductGroup[], totalKg: string, bundleCount: number, full = false): string {
  const lines: string[] = ['📋 گزارش موجودی تولید شده پروفیل خام', '🟥 کد بندیل » وزن بندیل 🟥'];
  for (const g of groups) {
    lines.push(`🔹 ${g.product_name}: ${kg(g.total_kg)} کیلو`);
    for (const b of g.bundles) {
      let line = `${toPersianDigits(b.code)} ◂ ${kg(b.weight_kg)}`;
      if (full) {
        const extra: string[] = [];
        if (b.bars) extra.push(`${toPersianDigits(String(b.bars))} شاخه`);
        if (b.g_per_m) extra.push(`${toPersianDigits(b.g_per_m)} گرم/متر`);
        if (b.mixed) extra.push('درهم');
        if (b.status !== 'ok') extra.push(b.status === 'damaged' ? 'خرابی' : b.status === 'wrong_product' ? 'اشتباه تولید' : 'نیازمند بررسی');
        if (b.note) extra.push(b.note);
        if (extra.length) line += ` (${extra.join('، ')})`;
      }
      lines.push(line);
    }
  }
  lines.push('━━━━━━━━━━', `✅ جمع کل: ${kg(totalKg)} کیلو`, `📦 تعداد بندیل: ${toPersianDigits(String(bundleCount))}`);
  return lines.join('\n');
}

/** Bundles reported in a range, grouped per product (R23: a mixed bundle counts once; its weight is split by lines). */
export async function productionSection(db: Db | Trx, start: Date, end: Date, runId?: string): Promise<DailyReport['production']> {
  let q = db.selectFrom('bundles').leftJoin('parties', 'parties.id', 'bundles.factory_party_id').leftJoin('production_runs', 'production_runs.id', 'bundles.production_run_id').selectAll('bundles').select(['parties.name as factory_name', 'production_runs.number as run_number']).where('bundles.draft', '=', false).where('bundles.source', '=', 'production').orderBy('bundles.reported_at');
  q = runId ? q.where('bundles.production_run_id', '=', runId) : q.where('bundles.reported_at', '>=', start).where('bundles.reported_at', '<', end);
  const bundles = await q.execute();
  const ids = bundles.map((b) => b.id);
  const lines = ids.length ? await db.selectFrom('bundle_lines').innerJoin('products', 'products.id', 'bundle_lines.product_id').selectAll('bundle_lines').select(['products.name_fa as product_name', 'products.code as product_code']).where('bundle_id', 'in', ids).orderBy('sort').execute() : [];
  const rows: ReportBundleRow[] = bundles.map((b) => {
    const bl = lines.filter((l) => l.bundle_id === b.id);
    return {
      id: b.id, code: b.code, code_is_temp: b.code_is_temp, weight_kg: b.weight_kg, status: b.status, mixed: bl.length > 1, warnings: b.warnings, factory_name: b.factory_name, run_number: b.run_number, note: b.note,
      lines: bl.map((l) => {
        const w = bl.length === 1 ? b.weight_kg : l.weight_kg;
        const gpm = bundleWeightPerMeter(w, bl.length === 1 ? b.packaging_kg : null, l.bars, l.length_m);
        return { product_id: l.product_id, product_name: l.product_name, weight_kg: w, bars: l.bars, length_m: l.length_m, g_per_m: gpm?.g_per_m ?? null };
      }),
    };
  });
  const groups = new Map<string, ProductGroup>();
  let total = new Dec(0);
  for (const r of rows) {
    total = total.plus(r.weight_kg);
    for (const l of r.lines) {
      if (l.weight_kg === null) continue;
      const g = groups.get(l.product_id) ?? { product_id: l.product_id, product_name: l.product_name, total_kg: '0', bundles: [] };
      g.total_kg = round(new Dec(g.total_kg).plus(l.weight_kg), 'weight');
      g.bundles.push({ code: r.code, weight_kg: l.weight_kg, bars: l.bars, g_per_m: l.g_per_m, note: r.note, mixed: r.mixed, status: r.status });
      groups.set(l.product_id, g);
    }
  }
  const gl = [...groups.values()].sort((a, b) => new Dec(b.total_kg).cmp(a.total_kg));
  const totalKg = round(total, 'weight');
  return { groups: gl, total_kg: totalKg, bundle_count: rows.length, text: productionText(gl, totalKg, rows.length), text_full: productionText(gl, totalKg, rows.length, true), bundles: rows };
}

export async function buildDailyReport(db: Db | Trx, date: JalaliDate, opts: { finance: boolean; userId?: string | null }): Promise<DailyReport> {
  const { start, end } = jalaliDayRange(date);
  const production = await productionSection(db, start, end);
  const quarantine = await db.selectFrom('bundles').leftJoin('parties', 'parties.id', 'bundles.factory_party_id').select(['bundles.id', 'bundles.code', 'bundles.weight_kg', 'bundles.status', 'bundles.defect', 'bundles.qc_note', 'parties.name as factory_name', 'bundles.reported_at']).where('bundles.status', 'in', ['damaged', 'wrong_product', 'pending_review']).where('bundles.draft', '=', false).orderBy('bundles.reported_at', 'desc').limit(100).execute();
  const weightWarnings = production.bundles.filter((b) => Array.isArray(b.warnings) && (b.warnings as unknown[]).length).map((b) => ({ id: b.id, code: b.code, weight_kg: b.weight_kg, warnings: b.warnings }));
  const incompleteTickets = await db.selectFrom('scale_tickets').leftJoin('transfers', 'transfers.id', 'scale_tickets.transfer_id').select(['scale_tickets.id', 'scale_tickets.stage', 'transfers.number as transfer_number', 'scale_tickets.created_at']).where('scale_tickets.status', '=', 'needs_completion').orderBy('scale_tickets.created_at', 'desc').limit(50).execute();
  const incompleteDocs = opts.finance ? await db.selectFrom('documents').select(['id', 'number', 'kind', 'status', 'description', 'created_at']).where('status', '=', 'needs_completion').orderBy('created_at', 'desc').limit(50).execute() : [];
  const pendingMoney = opts.finance ? Number((await db.selectFrom('documents').select(sql<number>`COUNT(*)::int`.as('n')).where('status', '=', 'reported').executeTakeFirstOrThrow()).n) : 0;

  const transfers = await db.selectFrom('transfers').leftJoin('locations as f', 'f.id', 'transfers.from_location_id').leftJoin('locations as t', 't.id', 'transfers.to_location_id')
    .select(['transfers.id', 'transfers.number', 'transfers.kind', 'transfers.status', 'transfers.departed_at', 'transfers.received_at', 'transfers.plate', 'transfers.driver_name', 'f.name as from_name', 't.name as to_name',
      sql<string>`(SELECT COALESCE(SUM(kg),0) FROM transfer_lines l WHERE l.transfer_id = transfers.id)`.as('kg'), sql<string>`(SELECT COALESCE(SUM(received_kg),0) FROM transfer_lines l WHERE l.transfer_id = transfers.id)`.as('received_kg'),
      sql<number>`(SELECT COUNT(*)::int FROM scale_tickets s WHERE s.transfer_id = transfers.id)`.as('tickets')])
    .where((eb) => eb.or([eb.and([eb('transfers.departed_at', '>=', start), eb('transfers.departed_at', '<', end)]), eb.and([eb('transfers.received_at', '>=', start), eb('transfers.received_at', '<', end)])])).orderBy('transfers.departed_at').execute();

  const fillerChecks = await db.selectFrom('die_events').innerJoin('dies', 'dies.id', 'die_events.die_id').select(['die_events.id', 'dies.code as die_code', 'die_events.kind', 'die_events.measured_filler_mm', 'die_events.detail', 'die_events.at']).where('die_events.kind', 'in', ['filler_check', 'repair', 'damage']).where('die_events.at', '>=', start).where('die_events.at', '<', end).execute();

  let money: Array<Record<string, unknown>> | null = null;
  {
    let q = db.selectFrom('documents').leftJoin('parties', 'parties.id', 'documents.party_id').leftJoin('users', 'users.id', 'documents.reported_by').select(['documents.id', 'documents.number', 'documents.kind', 'documents.status', 'documents.amount', 'documents.currency', 'documents.method', 'parties.name as party_name', 'users.short_name as reported_by_name', 'documents.created_at']).where('documents.kind', 'in', ['receipt', 'payment']).where('documents.created_at', '>=', start).where('documents.created_at', '<', end);
    if (!opts.finance) q = opts.userId ? q.where('documents.reported_by', '=', opts.userId) : q.where(sql<boolean>`false`);
    money = opts.finance || opts.userId ? await q.execute() : null;
  }

  let notesQ = db.selectFrom('free_notes').leftJoin('users', 'users.id', 'free_notes.created_by').select(['free_notes.id', 'free_notes.text', 'free_notes.topic', 'free_notes.status', 'free_notes.sensitive', 'free_notes.kg', 'free_notes.qty', 'users.short_name as user_name', 'free_notes.created_at', ...(opts.finance ? ['free_notes.amount' as const, 'free_notes.currency' as const] : [])]).where('free_notes.created_at', '>=', start).where('free_notes.created_at', '<', end).orderBy('free_notes.created_at');
  if (!opts.finance) notesQ = opts.userId ? notesQ.where((eb) => eb.or([eb('free_notes.sensitive', '=', false), eb('free_notes.created_by', '=', opts.userId!)])) : notesQ.where('free_notes.sensitive', '=', false);
  const freeNotes = await notesQ.execute();

  const closed = await db.selectFrom('tasks').leftJoin('users', 'users.id', 'tasks.assignee_user_id').select(['tasks.id', 'tasks.title', 'tasks.done_at', 'tasks.done_note', 'users.short_name as assignee']).where('tasks.status', '=', 'done').where('tasks.done_at', '>=', start).where('tasks.done_at', '<', end).execute();
  const open = await db.selectFrom('tasks').leftJoin('users', 'users.id', 'tasks.assignee_user_id').select(['tasks.id', 'tasks.title', 'tasks.due_at', 'users.short_name as assignee']).where('tasks.status', '=', 'open').orderBy('tasks.due_at').limit(100).execute();

  return {
    date: formatJalali(date), generated_at: new Date().toISOString(),
    decisions: { quarantine, weight_warnings: weightWarnings, incomplete_documents: [...incompleteTickets.map((t) => ({ ...t, type: 'scale_ticket' })), ...incompleteDocs.map((d) => ({ ...d, type: 'document' }))], pending_money: pendingMoney },
    production, transfers, filler_checks: fillerChecks, money, free_notes: freeNotes, tasks: { closed, open },
  };
}

/** Nightly snapshot (21:00 Tehran); idempotent per date. Stored with the finance view; readers without finance.view get the stripped build. */
export async function snapshotDailyReport(db: Db, date: JalaliDate, userId: string | null = null): Promise<void> {
  const report = await buildDailyReport(db, date, { finance: true });
  await db.insertInto('daily_reports').values({ date: jalaliToDateKey(date), snapshot: JSON.stringify(report), created_by: userId }).onConflict((oc) => oc.column('date').doUpdateSet({ snapshot: JSON.stringify(report), generated_at: new Date() })).execute();
}
