import type { FastifyInstance } from 'fastify';
import { CURRENCIES, decimalString } from '@vitral/shared';
import { sql, type SqlBool } from 'kysely';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { crudRoutes, dateOnly, optText, uuid, versionField } from '../../lib/crud.js';
import type { Db, Trx } from '../../db/index.js';
import type { Row } from '../../db/schema.js';

const SERVICES = ['extrusion', 'paint', 'anodize', 'smelting', 'die_making', 'transport'] as const;
const base = {
  party_id: uuid,
  service: z.enum(SERVICES),
  rate_per_kg: decimalString.nullable().optional(),
  currency: z.enum(CURRENCIES).default('TOMAN'),
  weight_basis: z.enum(['input', 'good_output']).nullable().optional(),
  fixed_fee: decimalString.nullable().optional(),
  scrap_owner: z.enum(['vitral', 'factory']).nullable().optional(),
  scrap_credit_rate: decimalString.nullable().optional(),
  includes_material: z.boolean().nullable().optional(),
  freight_payer: z.enum(['vitral', 'party']).nullable().optional(),
  rework_payer: z.enum(['vitral', 'party']).nullable().optional(),
  allowed_loss_percent: decimalString.nullable().optional(),
  valid_from: dateOnly,
  valid_to: dateOnly.nullable().optional(),
  note: optText(2000),
};

/** Contracts carry rates: the whole row is confidential except identity fields. The global guard strips rate_per_kg/fixed_fee for others. */
export function presentContract(r: Record<string, unknown>): Record<string, unknown> {
  const c = r as Row<'contracts'>;
  return {
    id: c.id, party_id: c.party_id, service: c.service, rate_per_kg: c.rate_per_kg, currency: c.currency, weight_basis: c.weight_basis, fixed_fee: c.fixed_fee,
    scrap_owner: c.scrap_owner, scrap_credit_rate: c.scrap_credit_rate, includes_material: c.includes_material, freight_payer: c.freight_payer, rework_payer: c.rework_payer,
    allowed_loss_percent: c.allowed_loss_percent, valid_from: c.valid_from, valid_to: c.valid_to, note: c.note, version: c.version, created_at: c.created_at,
  };
}

/** The contract in force for a party and service on a date (latest valid_from wins). */
export async function activeContract(db: Db | Trx, partyId: string, service: string, at: Date = new Date()): Promise<Row<'contracts'> | undefined> {
  const day = at.toISOString().slice(0, 10);
  return db
    .selectFrom('contracts')
    .selectAll()
    .where('party_id', '=', partyId)
    .where('service', '=', service)
    .where(sql<SqlBool>`valid_from <= ${day}::date`)
    .where(sql<SqlBool>`(valid_to IS NULL OR valid_to >= ${day}::date)`)
    .orderBy('valid_from', 'desc')
    .executeTakeFirst();
}

export function contractRoutes(app: FastifyInstance, ctx: AppContext): void {
  crudRoutes(app, ctx, {
    table: 'contracts',
    path: '/contracts',
    createSchema: z.object(base),
    updateSchema: z.object({ ...versionField, ...Object.fromEntries(Object.entries(base).map(([k, v]) => [k, v.optional()])) }),
    writePermission: 'settings.manage',
    readPermission: 'settings.manage',
    listSchema: z.object({ party_id: uuid.optional(), service: z.enum(SERVICES).optional() }),
    present: presentContract,
    filter: (qb, q) => {
      if (q.party_id) qb = qb.where('contracts.party_id', '=', String(q.party_id));
      if (q.service) qb = qb.where('contracts.service', '=', String(q.service));
      return qb;
    },
    orderBy: 'valid_from',
  });
}
