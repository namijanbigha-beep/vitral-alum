import { Dec, round, type Currency } from '@vitral/shared';
import { sql } from 'kysely';
import type { Db, Trx } from '../../db/index.js';
import type { Row } from '../../db/schema.js';
import { lineAmount, prepayment, totalsByCurrency } from '../../rules/money.js';
import { estimatedBarsForKg, estimatedLineKg } from '../../rules/weights.js';

export type OrderRow = Row<'orders'>;
export type LineRow = Row<'order_lines'>;

/** Quantity used for pricing, per price basis. */
export function lineBasisQty(l: LineRow): string | null {
  switch (l.price_basis) {
    case 'per_kg': return l.qty_kg;
    case 'per_bar': return l.qty_bars;
    case 'per_meter': return l.qty_bars && l.length_m ? new Dec(l.qty_bars).mul(l.length_m).toFixed() : null;
    case 'per_piece': return l.qty_pieces === null ? null : String(l.qty_pieces);
  }
  return null;
}

/** Apply calc_mode (module 3): from_bars → kg by R02; from_weight → estimated bars; manual → as given. */
export function computeLineQty(l: Partial<LineRow>): { qty_kg: string | null; qty_bars: string | null; qty_is_estimate: boolean } {
  const gpm = l.weight_g_per_m ?? null;
  if (l.kind !== 'profile') return { qty_kg: l.qty_kg ?? null, qty_bars: l.qty_bars ?? null, qty_is_estimate: false };
  if (l.calc_mode === 'from_bars') {
    const est = estimatedLineKg(gpm, l.length_m ?? null, l.qty_bars ?? null);
    return { qty_kg: est?.kg ?? null, qty_bars: l.qty_bars ?? null, qty_is_estimate: true };
  }
  if (l.calc_mode === 'from_weight') {
    const est = estimatedBarsForKg(l.qty_kg ?? null, gpm, l.length_m ?? null);
    return { qty_kg: l.qty_kg ?? null, qty_bars: est?.exact ?? null, qty_is_estimate: true };
  }
  return { qty_kg: l.qty_kg ?? null, qty_bars: l.qty_bars ?? null, qty_is_estimate: !!l.qty_is_estimate };
}

export function presentLine(l: LineRow & { product_code?: string | null; product_name?: string | null; product_name_ar?: string | null; product_file_id?: string | null }): Record<string, unknown> {
  const amount = lineAmount(lineBasisQty(l), l.unit_price, l.currency as Currency, l.discount_amount, l.discount_percent);
  return {
    id: l.id, order_id: l.order_id, sort: l.sort, kind: l.kind, product_id: l.product_id, product_code: l.product_code ?? null, product_name: l.product_name ?? null, product_name_ar: l.product_name_ar ?? null, product_file_id: l.product_file_id ?? null,
    product_filler_id: l.product_filler_id, filler_mm: l.filler_mm, length_m: l.length_m, min_length_m: l.min_length_m, color: l.color, load_type_label: l.load_type_label,
    weight_g_per_m: l.weight_g_per_m, weight_unapproved: l.weight_unapproved, calc_mode: l.calc_mode, qty_bars: l.qty_bars, qty_kg: l.qty_kg, qty_is_estimate: l.qty_is_estimate, qty_pieces: l.qty_pieces,
    price_basis: l.price_basis, unit_price: l.unit_price, currency: l.currency, discount_amount: l.discount_amount, discount_percent: l.discount_percent, amount,
    supply_method: l.supply_method, die_id: l.die_id, material_kind: l.material_kind, coating_gain_estimate_percent: l.coating_gain_estimate_percent,
    estimated_coated_kg: l.qty_kg && l.coating_gain_estimate_percent ? round(new Dec(l.qty_kg).mul(new Dec(1).plus(new Dec(l.coating_gain_estimate_percent).div(100))), 'weight') : null,
    vat_rate: l.vat_rate, vat_amount: l.vat_amount, name_ar: l.name_ar, name_en: l.name_en, description: l.description, file_id: l.file_id, note: l.note, version: l.version,
  };
}

export interface OrderTotals {
  totals: Partial<Record<Currency, string>>;
  incomplete: boolean;
  total_kg: string;
  prepay: Partial<Record<Currency, string>>;
  paid: Partial<Record<Currency, string>>;
  remaining: Partial<Record<Currency, string>>;
}

export async function postedReceiptsForOrder(db: Db | Trx, orderId: string): Promise<Partial<Record<Currency, string>>> {
  // Receipts allocated to the order directly or to its invoices; posted only.
  const rows = await db
    .selectFrom('allocations')
    .innerJoin('documents as r', 'r.id', 'allocations.from_document_id')
    .leftJoin('documents as inv', 'inv.id', 'allocations.to_document_id')
    .select(['allocations.currency', sql<string>`SUM(allocations.amount)`.as('amount')])
    .where('r.kind', '=', 'receipt').where('r.status', '=', 'posted')
    .where((eb) => eb.or([eb('allocations.order_id', '=', orderId), eb('inv.order_id', '=', orderId)]))
    .groupBy('allocations.currency')
    .execute();
  const out: Partial<Record<Currency, string>> = {};
  for (const r of rows) out[r.currency as Currency] = round(r.amount, r.currency as Currency);
  return out;
}

export function orderTotals(order: OrderRow, lines: LineRow[], paid: Partial<Record<Currency, string>>): OrderTotals {
  const amounts = lines.map((l) => ({ amount: lineAmount(lineBasisQty(l), l.unit_price, l.currency as Currency, l.discount_amount, l.discount_percent), currency: l.currency as Currency }));
  const t = totalsByCurrency(amounts);
  const totalKg = lines.reduce((a, l) => (l.qty_kg ? a.plus(l.qty_kg) : a), new Dec(0));
  const prepay: Partial<Record<Currency, string>> = {};
  const remaining: Partial<Record<Currency, string>> = {};
  for (const [c, total] of Object.entries(t.totals) as Array<[Currency, string]>) {
    const p = prepayment(total, order.prepay_percent ?? '0', paid[c] ?? '0', c);
    prepay[c] = order.prepay_amount && c === order.currency ? round(order.prepay_amount, c) : p.prepay;
    remaining[c] = p.remaining;
  }
  return { totals: t.totals, incomplete: t.incomplete, total_kg: round(totalKg, 'weight'), prepay, paid, remaining };
}

export type SupplyStatus = 'unallocated' | 'partial' | 'full';
export type OpsStatus = 'none' | 'in_production' | 'raw_ready' | 'at_painter' | 'needs_fix' | 'ready_to_ship';
export type ShipStatus = 'not_shipped' | 'partial' | 'full' | 'delivered';
export type FinanceStatus = 'no_receipt' | 'prepaid' | 'partial' | 'settled' | 'credit';

export interface OrderStatuses { supply: SupplyStatus; operations: OpsStatus; shipping: ShipStatus; finance: FinanceStatus; next_action: string | null }

/** The four computed axes (module 3). Everything derives from real records; nothing is stored. */
export async function computeStatuses(db: Db | Trx, order: OrderRow, lines: LineRow[], totals: OrderTotals): Promise<OrderStatuses> {
  const lineIds = lines.map((l) => l.id);
  const physical = lines.filter((l) => l.kind === 'profile' || l.kind === 'material');
  const needKg = physical.reduce((a, l) => (l.qty_kg ? a.plus(l.qty_kg) : a), new Dec(0));
  let supply: SupplyStatus = 'unallocated';
  let operations: OpsStatus = 'none';
  let shipping: ShipStatus = 'not_shipped';
  if (lineIds.length) {
    const alloc = await db
      .selectFrom('reservations').select(sql<string>`COALESCE(SUM(kg),0)`.as('kg'))
      .where('order_line_id', 'in', lineIds).where('status', 'in', ['active', 'consumed']).executeTakeFirstOrThrow();
    const produced = await db
      .selectFrom('bundle_lines').innerJoin('bundles', 'bundles.id', 'bundle_lines.bundle_id')
      .select(sql<string>`COALESCE(SUM(COALESCE(bundle_lines.weight_kg, bundles.weight_kg)),0)`.as('kg'))
      .where('bundle_lines.order_line_id', 'in', lineIds).where('bundles.draft', '=', false).executeTakeFirstOrThrow();
    const allocated = new Dec(alloc.kg).plus(produced.kg);
    supply = allocated.isZero() ? 'unallocated' : allocated.gte(needKg) && !needKg.isZero() ? 'full' : 'partial';

    const bundles = await db
      .selectFrom('bundles')
      .leftJoin('coating_run_items', 'coating_run_items.bundle_id', 'bundles.id')
      .select(['bundles.id', 'bundles.status', 'bundles.form', 'bundles.draft', sql<boolean>`bool_or(coating_run_items.id IS NOT NULL AND coating_run_items.returned_at IS NULL)`.as('at_painter')])
      .where((eb) => eb.or([eb('bundles.reserved_order_line_id', 'in', lineIds), sql<boolean>`EXISTS (SELECT 1 FROM bundle_lines bl WHERE bl.bundle_id = bundles.id AND bl.order_line_id = ANY(${lineIds}::uuid[]))`]))
      .where('bundles.status', '<>', 'consumed')
      .groupBy(['bundles.id', 'bundles.status', 'bundles.form', 'bundles.draft'])
      .execute();
    const openRuns = await db.selectFrom('production_run_lines').innerJoin('production_runs', 'production_runs.id', 'production_run_lines.run_id').select('production_runs.id').where('production_run_lines.order_line_id', 'in', lineIds).where('production_runs.status', '=', 'open').executeTakeFirst();
    const needsColor = physical.some((l) => l.color && !/خام|raw/i.test(l.color));
    if (bundles.some((b) => b.status !== 'ok')) operations = 'needs_fix';
    else if (bundles.some((b) => b.at_painter)) operations = 'at_painter';
    else if (bundles.length && bundles.every((b) => b.form !== 'raw' || !needsColor)) operations = 'ready_to_ship';
    else if (bundles.length) operations = 'raw_ready';
    else if (openRuns) operations = 'in_production';

    const ship = await db
      .selectFrom('transfer_lines').innerJoin('transfers', 'transfers.id', 'transfer_lines.transfer_id')
      .select([sql<string>`COALESCE(SUM(CASE WHEN transfers.status <> 'draft' THEN transfer_lines.kg ELSE 0 END),0)`.as('kg'), sql<boolean>`bool_and(transfers.status = 'delivered')`.as('all_delivered'), sql<number>`COUNT(*)::int`.as('n')])
      .where('transfers.kind', '=', 'to_customer').where('transfer_lines.order_id', '=', order.id).where('transfers.status', '<>', 'draft').executeTakeFirstOrThrow();
    const shippedKg = new Dec(ship.kg);
    if (ship.n > 0 && !shippedKg.isZero()) shipping = shippedKg.gte(needKg) ? (ship.all_delivered ? 'delivered' : 'full') : 'partial';
  }

  let finance: FinanceStatus = 'no_receipt';
  const cur = order.currency as Currency;
  const paid = new Dec(totals.paid[cur] ?? '0');
  const total = new Dec(totals.totals[cur] ?? '0');
  const invoiced = await db.selectFrom('documents').select(sql<string>`COALESCE(SUM(amount),0)`.as('a')).where('order_id', '=', order.id).where('kind', '=', 'invoice').where('status', '=', 'posted').where('currency', '=', cur).executeTakeFirstOrThrow();
  const inv = new Dec(invoiced.a);
  if (!paid.isZero()) {
    const basis = inv.isZero() ? total : inv;
    if (paid.gt(basis) && !basis.isZero()) finance = 'credit';
    else if (basis.isZero() || paid.lt(basis)) finance = inv.isZero() ? 'prepaid' : 'partial';
    else finance = 'settled';
  }

  let next_action: string | null = null;
  if (order.status_sales === 'draft') next_action = 'issue_proforma';
  else if (order.status_sales === 'proforma') next_action = 'approve';
  else if (order.status_sales === 'approved') {
    if (shipping === 'delivered' && finance !== 'settled' && inv.isZero()) next_action = 'issue_invoice';
    else if (shipping === 'delivered') next_action = null;
    else if (operations === 'ready_to_ship') next_action = 'pack_and_ship';
    else if (operations === 'at_painter') next_action = 'record_coating_return';
    else if (operations === 'raw_ready') next_action = physical.some((l) => l.color) ? 'send_to_coating' : 'pack_and_ship';
    else if (operations === 'needs_fix') next_action = 'decide_quarantine';
    else if (operations === 'in_production') next_action = 'record_bundles';
    else if (supply === 'unallocated') next_action = physical.some((l) => l.supply_method === 'stock') ? 'reserve_stock' : physical.some((l) => l.supply_method === 'buy_finished' || l.supply_method === 'buy_raw_then_paint') ? 'record_purchase' : 'send_ingot';
    else next_action = 'record_bundles';
  }
  return { supply, operations, shipping, finance, next_action };
}

export const NEXT_ACTION_LABELS: Record<string, string> = {
  issue_proforma: 'صدور پیش‌فاکتور', approve: 'تأیید سفارش', reserve_stock: 'انتخاب موجودی', send_ingot: 'ارسال شمش', record_purchase: 'ثبت خرید', record_bundles: 'ثبت بندیل',
  send_to_coating: 'ارسال به رنگ', record_coating_return: 'ثبت برگشت رنگ', decide_quarantine: 'تصمیم قرنطینه', pack_and_ship: 'بسته‌بندی و ارسال', issue_invoice: 'صدور فاکتور',
};

export async function loadLines(db: Db | Trx, orderId: string) {
  return db
    .selectFrom('order_lines')
    .leftJoin('products', 'products.id', 'order_lines.product_id')
    .selectAll('order_lines')
    .select(['products.code as product_code', 'products.name_fa as product_name', 'products.name_ar as product_name_ar', 'products.main_file_id as product_file_id'])
    .where('order_lines.order_id', '=', orderId)
    .orderBy('order_lines.sort').orderBy('order_lines.created_at')
    .execute();
}

export function snapshotOrder(order: OrderRow, lines: LineRow[]): Record<string, unknown> {
  return { order: { ...order }, lines: lines.map((l) => ({ ...l })) };
}
