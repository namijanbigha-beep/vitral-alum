import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { jalaliOf } from '@vitral/shared';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { stripConfidential } from '../../lib/confidential.js';
import { AppError } from '../../lib/errors.js';
import { jalaliDayRange } from '../../lib/dates.js';
import { buildDailyReport, productionSection } from './report.js';
import { galleryItems } from './routes.js';

/**
 * Guest links (spec module 10, T44): read-only, no session, token hashed at rest, expiry and revocation enforced,
 * no financial data whatsoever (the report is built without finance and stripped again on the way out).
 */
export function publicRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;
  app.get('/public/share/:token', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const { token } = z.object({ token: z.string().min(20).max(100) }).parse(req.params);
    const hash = createHash('sha256').update(token).digest('hex');
    const link = await db.selectFrom('share_links').selectAll().where('token_hash', '=', hash).executeTakeFirst();
    if (!link || link.revoked || link.expires_at.getTime() < Date.now()) throw new AppError('not_found', 'این لینک معتبر نیست یا منقضی شده است');
    await db.updateTable('share_links').set({ open_count: link.open_count + 1, last_opened_at: new Date() }).where('id', '=', link.id).execute();
    if (link.scope_type === 'daily_report') {
      const d = link.scope_date!;
      const date = jalaliOf(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12)), 'UTC');
      const r = await buildDailyReport(db, date, { finance: false });
      const { money, free_notes, tasks, decisions, ...rest } = r; void money; void free_notes; void tasks;
      const photos = await galleryItems(db, { start: undefined, end: undefined });
      return stripConfidential({ scope: 'daily_report', ...rest, decisions: { quarantine: decisions.quarantine, weight_warnings: decisions.weight_warnings }, photos: photos.filter((p) => rest.production.bundles.some((b) => b.id === p.owner_id)).slice(0, 60), expires_at: link.expires_at });
    }
    if (link.scope_type === 'bundle_gallery') {
      const b = await db.selectFrom('bundles').leftJoin('parties', 'parties.id', 'bundles.factory_party_id').select(['bundles.id', 'bundles.code', 'bundles.weight_kg', 'bundles.form', 'bundles.color', 'bundles.status', 'bundles.reported_at', 'parties.name as factory_name']).where('bundles.id', '=', link.scope_id!).executeTakeFirst();
      if (!b) throw new AppError('not_found');
      const lines = await db.selectFrom('bundle_lines').innerJoin('products', 'products.id', 'bundle_lines.product_id').select(['products.name_fa as product_name', 'products.code as product_code', 'bundle_lines.length_m', 'bundle_lines.filler_mm', 'bundle_lines.bars', 'bundle_lines.weight_kg']).where('bundle_id', '=', b.id).execute();
      return stripConfidential({ scope: 'bundle_gallery', bundle: { ...b, lines }, photos: await galleryItems(db, { bundle_id: b.id }), expires_at: link.expires_at });
    }
    const d = await db.selectFrom('documents').leftJoin('parties', 'parties.id', 'documents.party_id').leftJoin('orders', 'orders.id', 'documents.order_id').select(['documents.id', 'documents.number', 'documents.kind', 'documents.date', 'documents.amount', 'documents.currency', 'documents.status', 'documents.description', 'parties.name as party_name', 'orders.number as order_number']).where('documents.id', '=', link.scope_id!).executeTakeFirst();
    if (!d || !['invoice', 'sales_return'].includes(d.kind)) throw new AppError('not_found');
    const lines = await db.selectFrom('document_lines').select(['description', 'qty', 'unit', 'unit_price', 'amount', 'sort']).where('document_id', '=', d.id).orderBy('sort').execute();
    const file = await db.selectFrom('file_links').innerJoin('files', 'files.id', 'file_links.file_id').select('files.id').where('entity', '=', 'documents').where('entity_id', '=', d.id).where('files.mime', '=', 'application/pdf').orderBy('files.created_at', 'desc').executeTakeFirst();
    return stripConfidential({ scope: 'document', document: { ...d, lines }, pdf_file_id: file?.id ?? null, expires_at: link.expires_at });
  });

  /** Public thumbnail/file for a share link's photos: the token proves access to that scope only. */
  app.get('/public/share/:token/files/:id', { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { token, id } = z.object({ token: z.string().min(20).max(100), id: z.string().uuid() }).parse(req.params);
    const hash = createHash('sha256').update(token).digest('hex');
    const link = await db.selectFrom('share_links').selectAll().where('token_hash', '=', hash).executeTakeFirst();
    if (!link || link.revoked || link.expires_at.getTime() < Date.now()) throw new AppError('not_found');
    const f = await db.selectFrom('files').selectAll().where('id', '=', id).where('sensitive', '=', false).executeTakeFirst();
    if (!f) throw new AppError('not_found');
    // The token proves access to its scope only: the file must belong to an entity inside it, otherwise 404 (never «exists but forbidden»).
    let entity: 'bundles' | 'documents';
    let ids: string[];
    if (link.scope_type === 'document') { entity = 'documents'; ids = [link.scope_id!]; }
    else if (link.scope_type === 'bundle_gallery') { entity = 'bundles'; ids = [link.scope_id!]; }
    else {
      // daily_report: exactly the bundles that report lists (that Jalali day's production bundles).
      const d = link.scope_date!;
      const { start, end } = jalaliDayRange(jalaliOf(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12)), 'UTC'));
      entity = 'bundles';
      ids = (await productionSection(db, start, end)).bundles.map((b) => b.id);
    }
    const allowed = ids.length > 0 && ((f.owner_entity === entity && f.owner_id !== null && ids.includes(f.owner_id))
      || !!(await db.selectFrom('file_links').select('id').where('file_id', '=', f.id).where('entity', '=', entity).where('entity_id', 'in', ids).executeTakeFirst()));
    if (!allowed) throw new AppError('not_found');
    const thumb = (req.query as Record<string, unknown>).thumb === '1' && f.thumb_key;
    return reply.header('Content-Type', thumb ? 'image/webp' : f.mime).header('Cache-Control', 'private, max-age=3600').header('X-Content-Type-Options', 'nosniff').send(ctx.storage.stream(thumb ? f.thumb_key! : f.storage_key));
  });
}
