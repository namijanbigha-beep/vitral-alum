import type { FastifyInstance } from 'fastify';
import { FILE_KINDS, MAX_FILE_BYTES } from '@vitral/shared';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { audit } from '../../lib/audit.js';
import { can, requireUser } from '../../lib/auth.js';
import { AppError } from '../../lib/errors.js';
import { requireIdempotencyKey, withIdempotency } from '../../lib/idempotency.js';
import { canOpen, detectImportMime, detectMime, isImage, makeThumb, normaliseImage, presentFile, sha256 } from './service.js';

const idParam = z.object({ id: z.string().uuid() });

const metaSchema = z.object({
  kind: z.enum(FILE_KINDS).default('other'),
  caption: z.string().trim().max(200).optional(),
  sensitive: z.enum(['true', 'false']).default('false'),
  owner_entity: z.string().regex(/^[a-z_]{1,40}$/).optional(),
  owner_id: z.string().uuid().optional(),
  sort_order: z.coerce.number().int().min(0).max(10_000).default(0),
});

function safeName(name: string): string {
  const cleaned = name.replace(/[\\/\0\r\n"]/g, '_').trim().slice(0, 200);
  return cleaned || 'file';
}

export async function fileRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { db, storage } = ctx;

  app.post(
    '/files',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const me = requireUser(req);
      const key = requireIdempotencyKey(req);
      if (!req.isMultipart()) throw new AppError('validation', 'فایل ارسال نشده است');

      const fields: Record<string, string> = {};
      let upload: { filename: string; data: Buffer } | null = null;
      for await (const part of req.parts({ limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 10 } })) {
        if (part.type === 'file') {
          const data = await part.toBuffer();
          if (part.file.truncated) throw new AppError('validation', 'حجم فایل بیش از ۲۰ مگابایت است', { file: 'حداکثر ۲۰ مگابایت' });
          upload = { filename: part.filename, data };
        } else if (typeof part.value === 'string') {
          fields[part.fieldname] = part.value;
        }
      }
      if (!upload || upload.data.length === 0) throw new AppError('validation', 'فایل خالی است', { file: 'لازم است' });
      const meta = metaSchema.parse(fields);

      // Spec §18: import files (xlsx / csv / json) only as kind `import`, only for settings.manage, always sensitive, never thumbnailed.
      const isImport = meta.kind === 'import';
      if (isImport && !can(me, 'settings.manage')) throw new AppError('forbidden', 'بارگذاری فایل ورود گروهی فقط با مجوز تنظیمات است');
      const mime = isImport ? await detectImportMime(upload.data) : await detectMime(upload.data);
      if (!mime) {
        throw new AppError(
          'validation',
          isImport ? 'نوع فایل مجاز نیست؛ برای ورود گروهی فقط XLSX، CSV یا JSON' : 'نوع فایل مجاز نیست؛ فقط JPEG، PNG، WebP، PDF، OGG، M4A و MP3',
          { file: 'نوع فایل مجاز نیست' },
        );
      }

      let stored = upload.data;
      let thumb: Buffer | null = null;
      if (!isImport && isImage(mime)) {
        try {
          stored = await normaliseImage(upload.data, mime);
          thumb = await makeThumb(stored);
        } catch {
          throw new AppError('validation', 'تصویر خراب است یا خوانده نمی‌شود', { file: 'تصویر خراب است' });
        }
      }

      const storageKey = await storage.put(stored);
      const thumbKey = thumb ? await storage.put(thumb) : null;
      try {
        const result = await withIdempotency(db, key, me.id, 'POST /files', async (trx) => {
          const row = await trx
            .insertInto('files')
            .values({
              storage_key: storageKey,
              thumb_key: thumbKey,
              original_name: safeName(upload.filename),
              mime,
              size: stored.length,
              sha256: sha256(stored),
              kind: meta.kind,
              caption: meta.caption ?? null,
              sensitive: isImport || meta.sensitive === 'true',
              owner_entity: meta.owner_entity ?? null,
              owner_id: meta.owner_id ?? null,
              sort_order: meta.sort_order,
              created_by: me.id,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          if (row.owner_entity && row.owner_id) {
            await trx
              .insertInto('file_links')
              .values({ file_id: row.id, entity: row.owner_entity, entity_id: row.owner_id, created_by: me.id })
              .execute();
          }
          await audit(trx, { userId: me.id, entity: 'files', entityId: row.id, action: 'create', after: presentFile(row) });
          return { status: 201, body: presentFile(row) };
        });
        if (result.replayed) {
          await storage.remove(storageKey);
          if (thumbKey) await storage.remove(thumbKey);
        }
        return reply.status(result.status).send(result.body);
      } catch (err) {
        await storage.remove(storageKey);
        if (thumbKey) await storage.remove(thumbKey);
        throw err;
      }
    },
  );

  async function load(id: string) {
    const row = await db.selectFrom('files').selectAll().where('id', '=', id).executeTakeFirst();
    if (!row) throw new AppError('not_found');
    return row;
  }

  app.get('/files/:id', async (req) => {
    const me = requireUser(req);
    const row = await load(idParam.parse(req.params).id);
    if (!canOpen(me, row)) throw new AppError('forbidden');
    return presentFile(row);
  });

  app.get('/files/:id/download', async (req, reply) => {
    const me = requireUser(req);
    const row = await load(idParam.parse(req.params).id);
    if (!canOpen(me, row)) throw new AppError('forbidden');
    if (row.sensitive) {
      await audit(db, { userId: me.id, entity: 'files', entityId: row.id, action: 'open_sensitive' });
    }
    const inline = (req.query as Record<string, unknown>).inline === '1';
    return reply
      .header('Content-Type', row.mime)
      .header('Content-Length', String(row.size))
      .header('Cache-Control', 'private, max-age=3600')
      .header('X-Content-Type-Options', 'nosniff')
      .header(
        'Content-Disposition',
        `${inline ? 'inline' : 'attachment'}; filename="file"; filename*=UTF-8''${encodeURIComponent(row.original_name)}`,
      )
      .send(ctx.storage.stream(row.storage_key));
  });

  app.get('/files/:id/thumb', async (req, reply) => {
    const me = requireUser(req);
    const row = await load(idParam.parse(req.params).id);
    if (!canOpen(me, row)) throw new AppError('forbidden');
    if (!row.thumb_key) throw new AppError('not_found');
    return reply
      .header('Content-Type', 'image/webp')
      .header('Cache-Control', 'private, max-age=86400')
      .send(ctx.storage.stream(row.thumb_key));
  });
}
