import { Dec, round } from '@vitral/shared';
import { sql, type SqlBool } from 'kysely';
import type { Db, Trx } from '../db/index.js';
import { AppError } from './errors.js';

export type ItemType = 'material_lot' | 'bundle';
export type StockState = 'ingot' | 'scrap' | 'raw' | 'coated' | 'quarantine' | 'in_transit' | 'consumed' | 'sold' | 'paint' | 'tool';

export interface MoveInput {
  at?: Date;
  item_type: ItemType;
  item_id: string;
  from_location_id: string | null;
  to_location_id: string | null;
  kg: string;
  state_from?: StockState | null;
  state_to?: StockState | null;
  ref_type: string;
  ref_id: string;
  unit_cost?: string | null;
  currency?: string | null;
  owner_party_id?: string | null;
  note?: string | null;
  userId: string | null;
}

/** Quantity of an item at a location, from the ledger (principle 8). */
export async function itemBalance(trx: Trx | Db, itemType: ItemType, itemId: string, locationId: string): Promise<string> {
  const r = await trx
    .selectFrom('stock_moves')
    .select(sql<string>`COALESCE(SUM(CASE WHEN to_location_id = ${locationId} THEN kg ELSE 0 END) - SUM(CASE WHEN from_location_id = ${locationId} THEN kg ELSE 0 END), 0)`.as('kg'))
    .where('item_type', '=', itemType)
    .where('item_id', '=', itemId)
    .executeTakeFirstOrThrow();
  return round(r.kg, 'weight');
}

/**
 * Append one ledger row. A move out of a location checks the balance first (with the item locked via
 * an advisory lock keyed on the item) and fails with insufficient_stock, so no location ever goes negative.
 */
export async function move(trx: Trx, m: MoveInput): Promise<string> {
  await sql`SELECT pg_advisory_xact_lock(hashtext(${m.item_type + ':' + m.item_id}))`.execute(trx);
  if (m.from_location_id) {
    const have = new Dec(await itemBalance(trx, m.item_type, m.item_id, m.from_location_id));
    if (have.lt(m.kg)) {
      throw new AppError('insufficient_stock', `موجودی کافی نیست؛ موجود ${round(have, 'weight')} کیلوگرم، درخواست ${round(m.kg, 'weight')} کیلوگرم`);
    }
  }
  const row = await trx
    .insertInto('stock_moves')
    .values({
      at: m.at ?? new Date(),
      item_type: m.item_type,
      item_id: m.item_id,
      from_location_id: m.from_location_id,
      to_location_id: m.to_location_id,
      kg: m.kg,
      state_from: m.state_from ?? null,
      state_to: m.state_to ?? null,
      ref_type: m.ref_type,
      ref_id: m.ref_id,
      unit_cost: m.unit_cost ?? null,
      currency: m.currency ?? null,
      owner_party_id: m.owner_party_id ?? null,
      note: m.note ?? null,
      created_by: m.userId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

export interface LocationStock {
  location_id: string;
  item_type: ItemType;
  item_id: string;
  kg: string;
}

/** Current quantity of every item at every location (non-zero), optionally restricted. */
export async function stockPositions(db: Trx | Db, filter: { location_id?: string; item_type?: ItemType; item_id?: string } = {}): Promise<LocationStock[]> {
  let q = db
    .selectFrom(
      db
        .selectFrom('stock_moves')
        .select(['item_type', 'item_id', 'at', sql<string>`to_location_id`.as('location_id'), sql<string>`kg`.as('kg')])
        .where('to_location_id', 'is not', null)
        .unionAll(
          db
            .selectFrom('stock_moves')
            .select(['item_type', 'item_id', 'at', sql<string>`from_location_id`.as('location_id'), sql<string>`-kg`.as('kg')])
            .where('from_location_id', 'is not', null),
        )
        .as('m'),
    )
    .select(['m.location_id', 'm.item_type', 'm.item_id', sql<string>`SUM(m.kg)`.as('kg')])
    .groupBy(['m.location_id', 'm.item_type', 'm.item_id'])
    .having(sql<SqlBool>`SUM(m.kg) <> 0`)
    // Deterministic order (same in the PHP twin): oldest position first, then by ids.
    .orderBy(sql`MIN(m.at)`)
    .orderBy('m.location_id')
    .orderBy('m.item_type')
    .orderBy('m.item_id');
  if (filter.location_id) q = q.where('m.location_id', '=', filter.location_id);
  if (filter.item_type) q = q.where('m.item_type', '=', filter.item_type);
  if (filter.item_id) q = q.where('m.item_id', '=', filter.item_id);
  const rows = await q.execute();
  return rows.map((r) => ({ location_id: r.location_id, item_type: r.item_type as ItemType, item_id: r.item_id, kg: round(r.kg, 'weight') }));
}

export const IN_TRANSIT = async (db: Trx | Db): Promise<string> => {
  const r = await db.selectFrom('locations').select('id').where('kind', '=', 'in_transit').executeTakeFirstOrThrow();
  return r.id;
};

export const OWN_WAREHOUSE = async (db: Trx | Db): Promise<string> => {
  const r = await db.selectFrom('locations').select('id').where('kind', '=', 'own_warehouse').orderBy('created_at').executeTakeFirstOrThrow();
  return r.id;
};
