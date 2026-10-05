import type { FastifyInstance } from 'fastify';
import { CURRENCIES, Dec, decimalString, round } from '@vitral/shared';
import { sql, type SqlBool } from 'kysely';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import type { Db, Trx } from '../../db/index.js';
import { audit } from '../../lib/audit.js';
import { can, requirePermission, requireUser } from '../../lib/auth.js';
import { idParam, optText, uuid } from '../../lib/crud.js';
import { AppError } from '../../lib/errors.js';
import { requireIdempotencyKey, withIdempotency } from '../../lib/idempotency.js';
import { decodeCursor, encodeCursor, listQuery } from '../../lib/pagination.js';
import { itemBalance, move, stockPositions, type ItemType, type StockState } from '../../lib/stock.js';
import { formState } from '../bundles/routes.js';
import { lotAverage, lotState } from '../materials/routes.js';

const bump = { updated_at: new Date(), version: sql<number>`version + 1` };

export interface PositionDetail { location_id: string; location_name: string; location_kind: string; party_id: string | null; item_type: ItemType; item_id: string; kg: string; state: string | null; owner_party_id: string | null; bundle?: Record<string, unknown>; lot?: Record<string, unknown> }

/** «Where is the weight»: every item at every location with its current state, from the ledger only (principle 8). */
export async function positionsDetailed(db: Db | Trx, filter: { location_id?: string; item_type?: ItemType; state?: string; party_id?: string; product_id?: string } = {}): Promise<PositionDetail[]> {
  const positions = await stockPositions(db, { location_id: filter.location_id, item_type: filter.item_type });
  if (!positions.length) return [];
  const locIds = [...new Set(positions.map((p) => p.location_id))];
  const locs = await db.selectFrom('locations').select(['id', 'name', 'kind', 'party_id']).where('id', 'in', locIds).execute();
  const bundleIds = positions.filter((p) => p.item_type === 'bundle').map((p) => p.item_id);
  const lotIds = positions.filter((p) => p.item_type === 'material_lot').map((p) => p.item_id);
  const bundles = bundleIds.length ? await db.selectFrom('bundles').select(['id', 'code', 'form', 'color', 'status', 'production_run_id', 'reserved_order_line_id', 'factory_party_id']).where('id', 'in', bundleIds).execute() : [];
  const blines = bundleIds.length ? await db.selectFrom('bundle_lines').innerJoin('products', 'products.id', 'bundle_lines.product_id').select(['bundle_lines.bundle_id', 'bundle_lines.product_id', 'products.code as product_code', 'products.name_fa as product_name', 'bundle_lines.length_m', 'bundle_lines.filler_mm', 'bundle_lines.bars']).where('bundle_id', 'in', bundleIds).execute() : [];
  const lots = lotIds.length ? await db.selectFrom('material_lots').leftJoin('parties', 'parties.id', 'material_lots.owner_party_id').select(['material_lots.id', 'material_lots.kind', 'material_lots.alloy', 'material_lots.description', 'material_lots.owner_party_id', 'material_lots.unit', 'parties.name as owner_name']).where('material_lots.id', 'in', lotIds).execute() : [];
  // Current state per (item, location): the latest inbound move's state_to.
  const states = await db.selectFrom('stock_moves').select(['item_type', 'item_id', 'to_location_id', 'state_to', 'owner_party_id']).where('to_location_id', 'in', locIds).where('item_id', 'in', positions.map((p) => p.item_id)).orderBy('at', 'desc').orderBy('created_at', 'desc').execute();
  const out: PositionDetail[] = [];
  for (const p of positions) {
    const loc = locs.find((l) => l.id === p.location_id)!;
    const st = states.find((s) => s.item_id === p.item_id && s.to_location_id === p.location_id);
    const b = p.item_type === 'bundle' ? bundles.find((x) => x.id === p.item_id) : undefined;
    const lot = p.item_type === 'material_lot' ? lots.find((x) => x.id === p.item_id) : undefined;
    const state = b ? (b.status === 'ok' ? formState(b.form) : b.status === 'consumed' ? 'sold' : 'quarantine') : st?.state_to ?? (lot ? lotState(lot.kind) : null);
    if (filter.state && state !== filter.state) continue;
    if (filter.party_id && loc.party_id !== filter.party_id) continue;
    const lines = b ? blines.filter((l) => l.bundle_id === b.id) : [];
    if (filter.product_id && !lines.some((l) => l.product_id === filter.product_id)) continue;
    out.push({ location_id: p.location_id, location_name: loc.name, location_kind: loc.kind, party_id: loc.party_id, item_type: p.item_type, item_id: p.item_id, kg: p.kg, state, owner_party_id: lot?.owner_party_id ?? st?.owner_party_id ?? null, bundle: b ? { ...b, lines } : undefined, lot: lot ?? undefined });
  }
  return out;
}

export function stockRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  app.get('/stock/positions', async (req) => {
    requireUser(req);
    const q = z.object({ location_id: uuid.optional(), item_type: z.enum(['bundle', 'material_lot']).optional(), state: z.string().max(20).optional(), party_id: uuid.optional(), product_id: uuid.optional() }).parse(req.query);
    return { items: await positionsDetailed(db, q) };
  });

  /** Summary per location → state → kg, plus totals by state (raw / coated / quarantine / ingot / scrap / in transit). */
  app.get('/stock/summary', async (req) => {
    requireUser(req);
    const items = await positionsDetailed(db);
    const byLocation: Record<string, { location_id: string; name: string; kind: string; party_id: string | null; states: Record<string, string>; total_kg: string; bundle_count: number }> = {};
    const byState: Record<string, Dec> = {};
    for (const p of items) {
      const l = (byLocation[p.location_id] ??= { location_id: p.location_id, name: p.location_name, kind: p.location_kind, party_id: p.party_id, states: {}, total_kg: '0', bundle_count: 0 });
      const key = p.state ?? 'unknown';
      l.states[key] = round(new Dec(l.states[key] ?? 0).plus(p.kg), 'weight');
      l.total_kg = round(new Dec(l.total_kg).plus(p.kg), 'weight');
      if (p.item_type === 'bundle') l.bundle_count++;
      byState[key] = (byState[key] ?? new Dec(0)).plus(p.kg);
    }
    const vitralOwned = items.filter((p) => !p.owner_party_id).reduce((a, p) => a.plus(p.kg), new Dec(0));
    return { locations: Object.values(byLocation).sort((a, b) => a.name.localeCompare(b.name, 'fa')), by_state: Object.fromEntries(Object.entries(byState).map(([k, v]) => [k, round(v, 'weight')])), total_kg: round(items.reduce((a, p) => a.plus(p.kg), new Dec(0)), 'weight'), vitral_owned_kg: round(vitralOwned, 'weight') };
  });

  /** Available for sale: ok, definitive bundles minus active reservations, grouped by product/form/colour. */
  app.get('/stock/available', async (req) => {
    requireUser(req);
    const q = z.object({ product_id: uuid.optional(), form: z.enum(['raw', 'painted', 'anodized']).optional(), color: z.string().max(60).optional() }).parse(req.query);
    let qb = db.selectFrom('bundles').innerJoin('bundle_lines', 'bundle_lines.bundle_id', 'bundles.id').innerJoin('products', 'products.id', 'bundle_lines.product_id').innerJoin('locations', 'locations.id', 'bundles.location_id')
      .select(['bundle_lines.product_id', 'products.code as product_code', 'products.name_fa as product_name', 'bundles.form', 'bundles.color', 'bundle_lines.length_m', 'bundle_lines.filler_mm', sql<number>`COUNT(DISTINCT bundles.id)::int`.as('bundles'), sql<string>`SUM(COALESCE(bundle_lines.weight_kg, bundles.weight_kg))`.as('kg'), sql<string>`SUM(COALESCE(bundle_lines.bars,0))`.as('bars'), sql<string>`COALESCE(SUM((SELECT COALESCE(SUM(r.kg),0) FROM reservations r WHERE r.bundle_id = bundles.id AND r.status = 'active')),0)`.as('reserved_kg')])
      .where('bundles.status', '=', 'ok').where('bundles.draft', '=', false).where('locations.kind', 'in', ['own_warehouse', 'factory', 'painter']).groupBy(['bundle_lines.product_id', 'products.code', 'products.name_fa', 'bundles.form', 'bundles.color', 'bundle_lines.length_m', 'bundle_lines.filler_mm']);
    if (q.product_id) qb = qb.where('bundle_lines.product_id', '=', q.product_id);
    if (q.form) qb = qb.where('bundles.form', '=', q.form);
    if (q.color) qb = qb.where('bundles.color', '=', q.color);
    return { items: (await qb.execute()).map((r) => ({ ...r, kg: round(r.kg, 'weight'), reserved_kg: round(r.reserved_kg, 'weight'), free_kg: round(new Dec(r.kg).minus(r.reserved_kg), 'weight') })) };
  });

  /** Ledger browser. */
  app.get('/stock/moves', async (req) => {
    const me = requireUser(req);
    const q = listQuery.extend({ item_type: z.enum(['bundle', 'material_lot']).optional(), item_id: uuid.optional(), location_id: uuid.optional(), ref_type: z.string().max(40).optional(), ref_id: uuid.optional(), from: z.string().datetime({ offset: true }).optional(), to: z.string().datetime({ offset: true }).optional() }).parse(req.query);
    let qb = db.selectFrom('stock_moves').leftJoin('locations as f', 'f.id', 'stock_moves.from_location_id').leftJoin('locations as t', 't.id', 'stock_moves.to_location_id').leftJoin('bundles', (j) => j.onRef('bundles.id', '=', 'stock_moves.item_id').on('stock_moves.item_type', '=', 'bundle')).leftJoin('users', 'users.id', 'stock_moves.created_by')
      .selectAll('stock_moves').select(['f.name as from_name', 't.name as to_name', 'bundles.code as bundle_code', 'users.short_name as user_name']).orderBy('stock_moves.at', 'desc').orderBy('stock_moves.id', 'desc').limit(q.limit + 1);
    if (q.item_type) qb = qb.where('stock_moves.item_type', '=', q.item_type);
    if (q.item_id) qb = qb.where('stock_moves.item_id', '=', q.item_id);
    if (q.location_id) qb = qb.where((eb) => eb.or([eb('stock_moves.from_location_id', '=', q.location_id!), eb('stock_moves.to_location_id', '=', q.location_id!)]));
    if (q.ref_type) qb = qb.where('stock_moves.ref_type', '=', q.ref_type);
    if (q.ref_id) qb = qb.where('stock_moves.ref_id', '=', q.ref_id);
    if (q.from) qb = qb.where('stock_moves.at', '>=', new Date(q.from));
    if (q.to) qb = qb.where('stock_moves.at', '<', new Date(q.to));
    const cur = decodeCursor(q.cursor);
    if (cur) qb = qb.where(sql<SqlBool>`(stock_moves.at, stock_moves.id) < (${new Date(cur.at)}, ${cur.id}::uuid)`);
    const rows = await qb.execute();
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    const finance = can(me, 'finance.view');
    return { items: page.map((m) => ({ ...m, unit_cost: finance ? m.unit_cost : undefined })), next_cursor: rows.length > q.limit && last ? encodeCursor(last.at, last.id) : null };
  });

  /** Opening balances (inventory.adjust): one ledger row per item with ref «opening»; locked after any later movement. */
  app.post('/stock/opening', async (req, reply) => {
    const me = requirePermission(req, 'inventory.adjust');
    const key = requireIdempotencyKey(req);
    const body = z.object({ as_of: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), location_id: uuid, reason: optText(500), file_id: uuid.nullable().optional(), items: z.array(z.object({
      item_type: z.enum(['bundle', 'material_lot']), item_id: uuid.optional(), kg: decimalString, unit_cost: decimalString.nullable().optional(), currency: z.enum(CURRENCIES).default('TOMAN'),
      bundle: z.object({ code: z.string().trim().min(1).max(60), form: z.enum(['raw', 'painted', 'anodized']).default('raw'), color: optText(60), lines: z.array(z.object({ product_id: uuid, filler_mm: decimalString.nullable().optional(), length_m: decimalString.nullable().optional(), bars: z.number().int().min(0).nullable().optional(), weight_kg: decimalString.nullable().optional() })).min(1) }).optional(),
      lot: z.object({ kind: z.enum(['ingot', 'billet', 'scrap', 'paint_powder', 'tool']), alloy: optText(40), description: optText(500), owner_party_id: uuid.nullable().optional(), unit: z.enum(['kg', 'carton', 'piece']).default('kg'), kg_per_unit: decimalString.nullable().optional() }).optional(),
    })).min(1).max(500) }).parse(req.body);
    const r = await withIdempotency(db, key, me.id, 'POST /stock/opening', async (trx) => {
      const asOf = new Date(`${body.as_of}T00:00:00Z`);
      const created: string[] = [];
      for (const it of body.items) {
        let itemId = it.item_id ?? null;
        let state: StockState = 'ingot';
        let owner: string | null = null;
        if (it.item_type === 'bundle') {
          if (!itemId) {
            if (!it.bundle) throw new AppError('validation', 'مشخصات بندیل افتتاحیه لازم است', { bundle: 'لازم است' });
            const b = await trx.insertInto('bundles').values({ code: it.bundle.code, location_id: body.location_id, weight_kg: it.kg, form: it.bundle.form, color: it.bundle.color ?? null, source: 'opening', reported_at: asOf, warnings: '[]', created_by: me.id }).returning('id').executeTakeFirstOrThrow();
            let sort = 0;
            for (const l of it.bundle.lines) await trx.insertInto('bundle_lines').values({ ...l, bundle_id: b.id, sort: sort++, created_by: me.id }).execute();
            itemId = b.id;
            state = formState(it.bundle.form);
          } else {
            const b = await trx.selectFrom('bundles').select('form').where('id', '=', itemId).executeTakeFirstOrThrow();
            state = formState(b.form);
          }
        } else {
          if (!itemId) {
            if (!it.lot) throw new AppError('validation', 'مشخصات پارت مواد افتتاحیه لازم است', { lot: 'لازم است' });
            const l = await trx.insertInto('material_lots').values({ ...it.lot, created_by: me.id }).returning('id').executeTakeFirstOrThrow();
            itemId = l.id;
            state = lotState(it.lot.kind);
            owner = it.lot.owner_party_id ?? null;
          } else {
            const l = await trx.selectFrom('material_lots').select(['kind', 'owner_party_id']).where('id', '=', itemId).executeTakeFirstOrThrow();
            state = lotState(l.kind);
            owner = l.owner_party_id;
          }
        }
        const row = await trx.insertInto('opening_weights').values({ item_type: it.item_type, item_id: itemId, location_id: body.location_id, kg: it.kg, unit_cost: it.unit_cost ?? null, currency: it.unit_cost ? it.currency : null, as_of: asOf, reason: body.reason ?? null, file_id: body.file_id ?? null, created_by: me.id }).returning('id').executeTakeFirstOrThrow();
        await move(trx, { at: asOf, item_type: it.item_type, item_id: itemId, from_location_id: null, to_location_id: body.location_id, kg: it.kg, state_to: state, ref_type: 'opening', ref_id: row.id, unit_cost: it.unit_cost ?? null, currency: it.unit_cost ? it.currency : null, owner_party_id: owner, userId: me.id });
        created.push(row.id);
      }
      await audit(trx, { userId: me.id, entity: 'opening_weights', entityId: null, action: 'create', after: { count: created.length, location_id: body.location_id, as_of: body.as_of }, reason: body.reason ?? null });
      return { status: 201, body: { ids: created } };
    });
    return reply.status(r.status).send(r.body);
  });

  app.get('/stock/opening', async (req) => {
    const me = requireUser(req);
    const q = z.object({ location_id: uuid.optional() }).parse(req.query);
    let qb = db.selectFrom('opening_weights').leftJoin('locations', 'locations.id', 'opening_weights.location_id').leftJoin('bundles', 'bundles.id', 'opening_weights.item_id').leftJoin('material_lots', 'material_lots.id', 'opening_weights.item_id').selectAll('opening_weights').select(['locations.name as location_name', 'bundles.code as bundle_code', 'material_lots.description as lot_description', 'material_lots.kind as lot_kind']).orderBy('opening_weights.as_of', 'desc').limit(500);
    if (q.location_id) qb = qb.where('opening_weights.location_id', '=', q.location_id);
    const rows = await qb.execute();
    const finance = can(me, 'finance.view');
    const items = [];
    for (const r of rows) {
      const later = await db.selectFrom('stock_moves').select('id').where('item_type', '=', r.item_type).where('item_id', '=', r.item_id).where('ref_type', '<>', 'opening').executeTakeFirst();
      items.push({ ...r, locked: r.locked || !!later, unit_cost: finance ? r.unit_cost : undefined });
    }
    return { items };
  });

  /** Count adjustment (inventory.adjust): set the counted kg of an item at a location; the difference is one ledger row with the reason. */
  app.post('/stock/adjust', async (req) => {
    const me = requirePermission(req, 'inventory.adjust');
    const key = requireIdempotencyKey(req);
    const body = z.object({ item_type: z.enum(['bundle', 'material_lot']), item_id: uuid, location_id: uuid, counted_kg: decimalString, reason: z.string().trim().min(3).max(500), file_id: uuid.nullable().optional() }).parse(req.body);
    const r = await withIdempotency(db, key, me.id, 'POST /stock/adjust', async (trx) => {
      const have = new Dec(await itemBalance(trx, body.item_type, body.item_id, body.location_id));
      const diff = new Dec(body.counted_kg).minus(have);
      if (diff.isZero()) return { status: 200, body: { kg: have.toFixed(3), diff_kg: '0.000' } };
      let state: StockState = 'ingot';
      if (body.item_type === 'bundle') {
        const b = await trx.selectFrom('bundles').selectAll().where('id', '=', body.item_id).forUpdate().executeTakeFirstOrThrow();
        state = b.status === 'ok' ? formState(b.form) : 'quarantine';
        await trx.updateTable('bundles').set({ weight_kg: body.counted_kg, ...bump }).where('id', '=', b.id).execute();
      } else {
        const l = await trx.selectFrom('material_lots').select('kind').where('id', '=', body.item_id).executeTakeFirstOrThrow();
        state = lotState(l.kind);
      }
      const avg = body.item_type === 'material_lot' ? (await lotAverage(trx, body.item_id)).avg : null;
      const note = body.reason + (body.file_id ? ` [file:${body.file_id}]` : '');
      if (diff.gt(0)) await move(trx, { item_type: body.item_type, item_id: body.item_id, from_location_id: null, to_location_id: body.location_id, kg: diff.toFixed(3), state_to: state, ref_type: 'count_adjustment', ref_id: body.item_id, unit_cost: avg, note, userId: me.id });
      else await move(trx, { item_type: body.item_type, item_id: body.item_id, from_location_id: body.location_id, to_location_id: null, kg: diff.abs().toFixed(3), state_from: state, state_to: 'consumed', ref_type: 'count_adjustment', ref_id: body.item_id, unit_cost: avg, note, userId: me.id });
      await audit(trx, { userId: me.id, entity: body.item_type === 'bundle' ? 'bundles' : 'material_lots', entityId: body.item_id, action: 'count_adjustment', before: { kg: have.toFixed(3) }, after: { kg: body.counted_kg, location_id: body.location_id }, reason: body.reason });
      return { status: 200, body: { kg: body.counted_kg, diff_kg: round(diff, 'weight') } };
    });
    return r.body;
  });

  /** Factory weight account: Vitral's weight at a factory/painter — received, consumed, produced, scrap, currently there. */
  app.get('/stock/party-account/:id', async (req) => {
    requireUser(req);
    const { id } = idParam.parse(req.params);
    const locs = await db.selectFrom('locations').select(['id', 'name', 'kind']).where('party_id', '=', id).execute();
    if (!locs.length) throw new AppError('not_found', 'این طرف محل انبار ندارد');
    const ids = locs.map((l) => l.id);
    const sums = await db.selectFrom('stock_moves').select([
      sql<string>`COALESCE(SUM(CASE WHEN to_location_id = ANY(${ids}::uuid[]) AND ref_type IN ('transfer_receive','purchase_receipt','opening') THEN kg ELSE 0 END),0)`.as('received_kg'),
      sql<string>`COALESCE(SUM(CASE WHEN from_location_id = ANY(${ids}::uuid[]) AND ref_type = 'production_consume' THEN kg ELSE 0 END),0)`.as('consumed_kg'),
      sql<string>`COALESCE(SUM(CASE WHEN to_location_id = ANY(${ids}::uuid[]) AND ref_type = 'production_output' AND item_type = 'bundle' THEN kg ELSE 0 END),0)`.as('produced_kg'),
      sql<string>`COALESCE(SUM(CASE WHEN to_location_id = ANY(${ids}::uuid[]) AND state_to = 'scrap' THEN kg ELSE 0 END),0)`.as('scrap_kg'),
      sql<string>`COALESCE(SUM(CASE WHEN from_location_id = ANY(${ids}::uuid[]) AND ref_type = 'transfer_dispatch' THEN kg ELSE 0 END),0)`.as('dispatched_kg'),
      sql<string>`COALESCE(SUM(CASE WHEN to_location_id = ANY(${ids}::uuid[]) AND ref_type = 'coating_send' THEN kg ELSE 0 END),0)`.as('coating_in_kg'),
      sql<string>`COALESCE(SUM(CASE WHEN from_location_id = ANY(${ids}::uuid[]) AND ref_type = 'coating_return' THEN kg ELSE 0 END),0)`.as('coating_out_kg'),
    ]).executeTakeFirstOrThrow();
    const positions = await positionsDetailed(db, { party_id: id });
    const byState: Record<string, Dec> = {};
    for (const p of positions) byState[p.state ?? 'unknown'] = (byState[p.state ?? 'unknown'] ?? new Dec(0)).plus(p.kg);
    return { locations: locs, ...Object.fromEntries(Object.entries(sums).map(([k, v]) => [k, round(v, 'weight')])), on_hand: Object.fromEntries(Object.entries(byState).map(([k, v]) => [k, round(v, 'weight')])), on_hand_total_kg: round(positions.reduce((a, p) => a.plus(p.kg), new Dec(0)), 'weight'), items: positions };
  });
}
