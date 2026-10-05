import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { crudRoutes, like, optText, text, uuid, versionField } from '../../lib/crud.js';

const KINDS = ['own_warehouse', 'factory', 'painter', 'in_transit', 'customer', 'border'] as const;

export function locationRoutes(app: FastifyInstance, ctx: AppContext): void {
  crudRoutes(app, ctx, {
    table: 'locations',
    path: '/locations',
    createSchema: z.object({ name: text(200).min(1), kind: z.enum(KINDS).refine((k) => k !== 'in_transit', 'محل «در مسیر» یکتا و خودکار است'), party_id: uuid.nullable().optional() }),
    updateSchema: z.object({ ...versionField, name: text(200).min(1).optional(), active: z.boolean().optional(), party_id: uuid.nullable().optional(), note: optText() }),
    writePermission: 'settings.manage',
    listSchema: z.object({ q: z.string().max(100).optional(), kind: z.enum(KINDS).optional(), party_id: uuid.optional(), active: z.enum(['true', 'false']).optional() }),
    present: (r) => ({ id: r.id, name: r.name, kind: r.kind, party_id: r.party_id, active: r.active, version: r.version }),
    filter: (qb, q) => {
      if (q.q) qb = qb.where('locations.name', 'ilike', like(String(q.q)));
      if (q.active) qb = qb.where('locations.active', '=', q.active === 'true');
      if (q.kind) qb = qb.where('locations.kind', '=', String(q.kind));
      if (q.party_id) qb = qb.where('locations.party_id', '=', String(q.party_id));
      return qb;
    },
    orderBy: 'name',
  });
}
