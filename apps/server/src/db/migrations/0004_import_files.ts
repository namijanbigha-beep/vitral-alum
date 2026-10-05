import { sql, type Kysely } from 'kysely';

/**
 * Spec §18: the bulk import uploads its spreadsheet (xlsx / csv) or JSON backup through `/files` with kind `import`.
 * The base CHECKs allowed only images, PDF and audio, so both lists grow by exactly what the import needs.
 */
const MIME_BASE = `'image/jpeg','image/png','image/webp','application/pdf','audio/ogg','audio/mp4','audio/mpeg'`;
const MIME_IMPORT = `'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','text/csv','application/json'`;
const KIND_BASE = `'product','section','color_sample','drawing','die','bundle','label','load','vehicle','package','waybill','scale_ticket','receipt','delivery_receipt','voice','document_pdf','other'`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE files DROP CONSTRAINT IF EXISTS files_mime_check`.execute(db);
  await sql`ALTER TABLE files DROP CONSTRAINT IF EXISTS files_kind_check`.execute(db);
  await sql.raw(`ALTER TABLE files ADD CONSTRAINT files_mime_check CHECK (mime IN (${MIME_BASE},${MIME_IMPORT}))`).execute(db);
  await sql.raw(`ALTER TABLE files ADD CONSTRAINT files_kind_check CHECK (kind IN (${KIND_BASE},'import'))`).execute(db);
  // Data files are import material only: never another kind, never public.
  await sql.raw(`ALTER TABLE files ADD CONSTRAINT files_import_mime_check CHECK (mime NOT IN (${MIME_IMPORT}) OR (kind = 'import' AND sensitive))`).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DELETE FROM file_links WHERE file_id IN (SELECT id FROM files WHERE kind = 'import')`.execute(db);
  await sql`UPDATE import_batches SET file_id = NULL WHERE file_id IN (SELECT id FROM files WHERE kind = 'import')`.execute(db);
  await sql`DELETE FROM files WHERE kind = 'import'`.execute(db);
  await sql`ALTER TABLE files DROP CONSTRAINT IF EXISTS files_import_mime_check`.execute(db);
  await sql`ALTER TABLE files DROP CONSTRAINT IF EXISTS files_mime_check`.execute(db);
  await sql`ALTER TABLE files DROP CONSTRAINT IF EXISTS files_kind_check`.execute(db);
  await sql.raw(`ALTER TABLE files ADD CONSTRAINT files_mime_check CHECK (mime IN (${MIME_BASE}))`).execute(db);
  await sql.raw(`ALTER TABLE files ADD CONSTRAINT files_kind_check CHECK (kind IN (${KIND_BASE}))`).execute(db);
}
