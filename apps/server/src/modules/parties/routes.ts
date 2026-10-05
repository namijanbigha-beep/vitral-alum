import type { FastifyInstance } from 'fastify';
import { CURRENCIES } from '@vitral/shared';
import { sql, type SqlBool } from 'kysely';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { audit } from '../../lib/audit.js';
import { requirePermission, requireUser, can, type AuthUser } from '../../lib/auth.js';
import { crudRoutes, idParam, like, optText, text, uuid, versionField } from '../../lib/crud.js';
import { AppError } from '../../lib/errors.js';
import { partyBalance, type BalanceDocKind } from '../../rules/money.js';
import type { Row } from '../../db/schema.js';
import type { Currency } from '@vitral/shared';

const PARTY_ROLES = ['customer', 'factory', 'painter', 'anodizer', 'ingot_supplier', 'scrap_trader', 'smelter', 'die_maker', 'carrier', 'tool_supplier', 'other'] as const;
const phone = z.string().trim().min(3).max(30);

const base = {
  name: text(200).min(1, 'نام لازم است'),
  name_ar: optText(200),
  name_en: optText(200),
  phones: z.array(phone).max(10).default([]),
  country: optText(80),
  city: optText(80),
  address: optText(500),
  national_id: optText(40),
  roles: z.array(z.enum(PARTY_ROLES)).default([]),
  default_currency: z.enum(CURRENCIES).default('TOMAN'),
  note: optText(2000),
};
const createSchema = z.object(base);
const updateSchema = z.object({ ...versionField, ...Object.fromEntries(Object.entries(base).map(([k, v]) => [k, v.optional()])), active: z.boolean().optional() });

export function presentParty(p: Row<'parties'> | Record<string, unknown>): Record<string, unknown> {
  const r = p as Row<'parties'>;
  return {
    id: r.id, name: r.name, name_ar: r.name_ar, name_en: r.name_en, phones: r.phones, country: r.country, city: r.city, address: r.address,
    national_id: r.national_id, roles: r.roles, default_currency: r.default_currency, note: r.note, active: r.active, merged_into_id: r.merged_into_id,
    created_at: r.created_at, updated_at: r.updated_at, version: r.version,
  };
}

const LOCATION_KIND: Record<string, 'factory' | 'painter'> = { factory: 'factory', painter: 'painter', anodizer: 'painter', smelter: 'factory' };

/** Every factory / painter gets its own location automatically (7.2). */
async function ensureLocations(trx: Parameters<NonNullable<Parameters<typeof crudRoutes>[2]['afterCreate']>>[0], party: Row<'parties'>, userId: string): Promise<void> {
  const kinds = new Set(party.roles.map((r) => LOCATION_KIND[r]).filter((k): k is 'factory' | 'painter' => !!k));
  for (const kind of kinds) {
    const exists = await trx.selectFrom('locations').select('id').where('party_id', '=', party.id).where('kind', '=', kind).executeTakeFirst();
    if (!exists) await trx.insertInto('locations').values({ name: party.name, kind, party_id: party.id, created_by: userId }).execute();
  }
}

export async function partyRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { db } = ctx;
  crudRoutes(app, ctx, {
    table: 'parties',
    path: '/parties',
    createSchema,
    updateSchema,
    listSchema: z.object({ q: z.string().max(100).optional(), role: z.enum(PARTY_ROLES).optional(), active: z.enum(['true', 'false']).optional() }),
    present: presentParty,
    filter: (qb, q) => {
      if (q.q) qb = qb.where((eb) => eb.or([eb('parties.name', 'ilike', like(String(q.q))), sql<SqlBool>`EXISTS (SELECT 1 FROM unnest(parties.phones) p WHERE p LIKE ${like(String(q.q))})`]));
      if (q.role) qb = qb.where(sql<SqlBool>`${String(q.role)} = ANY(parties.roles)`);
      if (q.active) qb = qb.where('parties.active', '=', q.active === 'true');
      else qb = qb.where('parties.merged_into_id', 'is', null);
      return qb;
    },
    orderBy: 'name',
    afterCreate: async (trx, row, _i, user) => ensureLocations(trx, row as unknown as Row<'parties'>, user.id),
    afterUpdate: async (trx, _b, after, user) => ensureLocations(trx, after as unknown as Row<'parties'>, user.id),
  });

  /** Similar parties by name or phone, suggested before creating (7.2). */
  app.get('/parties/similar', async (req) => {
    requireUser(req);
    const q = z.object({ name: z.string().max(200).optional(), phone: z.string().max(30).optional() }).parse(req.query);
    if (!q.name && !q.phone) return { items: [] };
    let qb = db.selectFrom('parties').selectAll().where('merged_into_id', 'is', null).limit(10);
    const conds = [];
    if (q.name) conds.push(sql`similarity(lower(name), lower(${q.name})) > 0.3 OR lower(name) LIKE ${like(q.name.toLowerCase())}`);
    if (q.phone) conds.push(sql`${q.phone} = ANY(phones)`);
    qb = qb.where(sql<SqlBool>`(${sql.join(conds, sql` OR `)})`);
    const rows = await qb.execute().catch(async () => {
      // pg_trgm may be unavailable; fall back to LIKE only.
      let fb = db.selectFrom('parties').selectAll().where('merged_into_id', 'is', null).limit(10);
      if (q.name) fb = fb.where('name', 'ilike', like(q.name));
      if (q.phone) fb = fb.where(sql<SqlBool>`${q.phone} = ANY(phones)`);
      return fb.execute();
    });
    return { items: rows.map(presentParty) };
  });

  /** Merge duplicate parties (manager only): the loser is deactivated and points at the winner; references are re-pointed. */
  app.post('/parties/:id/merge', async (req) => {
    const me = requirePermission(req, 'settings.manage');
    const { id } = idParam.parse(req.params);
    const { into_id } = z.object({ into_id: uuid }).parse(req.body);
    if (id === into_id) throw new AppError('validation', 'طرف نمی‌تواند با خودش ادغام شود');
    return db.transaction().execute(async (trx) => {
      const loser = await trx.selectFrom('parties').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      const winner = await trx.selectFrom('parties').selectAll().where('id', '=', into_id).forUpdate().executeTakeFirst();
      if (!loser || !winner) throw new AppError('not_found');
      for (const [table, col] of [
        ['orders', 'party_id'], ['contracts', 'party_id'], ['documents', 'party_id'], ['locations', 'party_id'], ['production_runs', 'factory_party_id'],
        ['coating_runs', 'party_id'], ['transfers', 'carrier_party_id'], ['transfers', 'bill_to_party_id'], ['dies', 'owner_party_id'], ['dies', 'maker_party_id'],
        ['free_notes', 'party_id'], ['tasks', 'party_id'], ['bundles', 'factory_party_id'], ['material_lots', 'owner_party_id'], ['die_orders', 'customer_party_id'], ['die_orders', 'maker_party_id'],
      ] as const) {
        await sql`UPDATE ${sql.table(table)} SET ${sql.ref(col)} = ${into_id} WHERE ${sql.ref(col)} = ${id}`.execute(trx);
      }
      const phones = Array.from(new Set([...winner.phones, ...loser.phones]));
      const roles = Array.from(new Set([...winner.roles, ...loser.roles]));
      await trx.updateTable('parties').set({ phones, roles, updated_at: new Date(), version: sql`version + 1` }).where('id', '=', into_id).execute();
      await trx.updateTable('parties').set({ active: false, merged_into_id: into_id, updated_at: new Date(), version: sql`version + 1` }).where('id', '=', id).execute();
      await audit(trx, { userId: me.id, entity: 'parties', entityId: id, action: 'merge', before: presentParty(loser), after: { merged_into_id: into_id } });
      return { ok: true };
    });
  });

  /** Party file: balances per currency (finance.view), open orders, documents. Weight account lives under /stock. */
  app.get('/parties/:id/summary', async (req) => {
    const me = requireUser(req);
    const { id } = idParam.parse(req.params);
    const party = await db.selectFrom('parties').selectAll().where('id', '=', id).executeTakeFirst();
    if (!party) throw new AppError('not_found');
    const orders = await db.selectFrom('orders').select(['id', 'number', 'title', 'status_sales', 'currency', 'due_date', 'archived', 'created_at']).where('party_id', '=', id).orderBy('created_at', 'desc').limit(100).execute();
    const out: Record<string, unknown> = { party: presentParty(party), orders };
    if (can(me, 'finance.view')) out.balances = await balancesFor(db, id);
    return out;
  });
}

export async function balancesFor(db: AppContext['db'], partyId: string): Promise<Partial<Record<Currency, string>>> {
  const docs = await db.selectFrom('documents').select(['kind', 'amount', 'currency', 'status', 'barter_sign']).where('party_id', '=', partyId).where('status', '=', 'posted').execute();
  return partyBalance(
    docs.map((d) => ({
      kind: d.kind as BalanceDocKind,
      amount: d.kind === 'barter' || d.kind === 'fx_difference' || d.kind === 'opening_balance' ? String(Number(d.amount ?? 0) * (d.barter_sign ?? 1)) : (d.amount ?? '0'),
      currency: d.currency as Currency,
      status: d.status,
    })),
  );
}

export type { AuthUser };
