import { sql, type Kysely } from 'kysely';

/**
 * Phase 0 — section 7.1 base tables, plus `files` / `file_links` (7.3) that the private upload needs.
 * Reversible: `down` drops everything this migration created.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db);

  await sql`
    CREATE TABLE users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      mobile text NOT NULL,
      name text NOT NULL,
      short_name text,
      password_hash text NOT NULL,
      role text NOT NULL CHECK (role IN ('manager', 'staff')),
      permissions text[] NOT NULL DEFAULT '{}'
        CHECK (permissions <@ ARRAY['finance.view','finance.post','technical.approve','inventory.adjust','sales.approve','settings.manage']::text[]),
      telegram_chat_id text,
      active boolean NOT NULL DEFAULT true,
      failed_logins integer NOT NULL DEFAULT 0 CHECK (failed_logins >= 0),
      locked_until timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by uuid REFERENCES users(id),
      updated_at timestamptz NOT NULL DEFAULT now(),
      version integer NOT NULL DEFAULT 1,
      CONSTRAINT users_mobile_key UNIQUE (mobile),
      CONSTRAINT users_telegram_chat_id_key UNIQUE (telegram_chat_id),
      CONSTRAINT users_mobile_format CHECK (mobile ~ '^09[0-9]{9}$')
    )`.execute(db);
  await sql`CREATE INDEX users_created_by_idx ON users (created_by)`.execute(db);

  await sql`
    CREATE TABLE sessions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash text NOT NULL UNIQUE,
      expires_at timestamptz NOT NULL,
      user_agent text,
      last_seen_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by uuid REFERENCES users(id)
    )`.execute(db);
  await sql`CREATE INDEX sessions_user_id_idx ON sessions (user_id)`.execute(db);
  await sql`CREATE INDEX sessions_expires_at_idx ON sessions (expires_at)`.execute(db);

  await sql`
    CREATE TABLE audit_log (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      at timestamptz NOT NULL DEFAULT now(),
      user_id uuid REFERENCES users(id),
      entity text NOT NULL,
      entity_id uuid,
      action text NOT NULL,
      before jsonb,
      after jsonb,
      reason text,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by uuid REFERENCES users(id)
    )`.execute(db);
  await sql`CREATE INDEX audit_log_entity_idx ON audit_log (entity, entity_id)`.execute(db);
  await sql`CREATE INDEX audit_log_user_id_idx ON audit_log (user_id)`.execute(db);
  await sql`CREATE INDEX audit_log_at_idx ON audit_log (at)`.execute(db);
  // Principle 7: append-only, enforced by the database.
  await sql`
    CREATE FUNCTION audit_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'audit_log is append-only';
    END $$`.execute(db);
  await sql`
    CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION audit_log_append_only()`.execute(db);
  await sql`
    CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
    FOR EACH STATEMENT EXECUTE FUNCTION audit_log_append_only()`.execute(db);

  await sql`
    CREATE TABLE idempotency_keys (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      request_id uuid NOT NULL UNIQUE,
      user_id uuid REFERENCES users(id),
      endpoint text NOT NULL,
      response jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by uuid REFERENCES users(id)
    )`.execute(db);
  await sql`CREATE INDEX idempotency_keys_user_id_idx ON idempotency_keys (user_id)`.execute(db);
  await sql`CREATE INDEX idempotency_keys_created_at_idx ON idempotency_keys (created_at)`.execute(db);

  await sql`
    CREATE TABLE settings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      key text NOT NULL UNIQUE,
      value jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by uuid REFERENCES users(id),
      updated_at timestamptz NOT NULL DEFAULT now(),
      version integer NOT NULL DEFAULT 1
    )`.execute(db);

  await sql`
    CREATE TABLE counters (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      kind text NOT NULL,
      year integer NOT NULL,
      last_value integer NOT NULL CHECK (last_value >= 0),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by uuid REFERENCES users(id),
      CONSTRAINT counters_kind_year_key UNIQUE (kind, year)
    )`.execute(db);

  await sql`
    CREATE TABLE files (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      storage_key text NOT NULL UNIQUE,
      original_name text NOT NULL,
      mime text NOT NULL CHECK (mime IN ('image/jpeg','image/png','image/webp','application/pdf','audio/ogg','audio/mp4','audio/mpeg')),
      size bigint NOT NULL CHECK (size >= 0 AND size <= 20971520),
      sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
      kind text NOT NULL CHECK (kind IN ('product','section','color_sample','drawing','die','bundle','label','load','vehicle','package','waybill','scale_ticket','receipt','delivery_receipt','voice','document_pdf','other')),
      caption text,
      sensitive boolean NOT NULL DEFAULT false,
      owner_entity text,
      owner_id uuid,
      sort_order integer NOT NULL DEFAULT 0,
      thumb_key text,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by uuid REFERENCES users(id),
      updated_at timestamptz NOT NULL DEFAULT now(),
      version integer NOT NULL DEFAULT 1
    )`.execute(db);
  await sql`CREATE INDEX files_owner_idx ON files (owner_entity, owner_id)`.execute(db);
  await sql`CREATE INDEX files_created_by_idx ON files (created_by)`.execute(db);
  await sql`CREATE INDEX files_sha256_idx ON files (sha256)`.execute(db);

  await sql`
    CREATE TABLE file_links (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      file_id uuid NOT NULL REFERENCES files(id),
      entity text NOT NULL,
      entity_id uuid NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by uuid REFERENCES users(id),
      CONSTRAINT file_links_unique UNIQUE (file_id, entity, entity_id)
    )`.execute(db);
  await sql`CREATE INDEX file_links_entity_idx ON file_links (entity, entity_id)`.execute(db);
  await sql`CREATE INDEX file_links_created_by_idx ON file_links (created_by)`.execute(db);

  // Section 18 start settings. Unknown values stay NULL (shown as «نامشخص»), never guessed.
  const defaults: Array<[string, unknown]> = [
    ['seller_name_fa', 'ویترال آلومینیوم اراک'],
    ['seller_name_ar', null],
    ['seller_name_en', null],
    ['seller_address_fa', 'اراک، شهرک صنعتی خیرآباد، خیابان ۳۰۲'],
    ['seller_address_ar', null],
    ['seller_address_en', null],
    ['seller_phone', null],
    ['seller_logo_file_id', null],
    ['default_paint_rate_per_kg', { amount: '80000', currency: 'TOMAN' }],
    ['weight_per_meter_tolerance_percent', '5'],
    ['bundle_weight_median_threshold_percent', '40'],
    ['production_balance_threshold_percent', '1'],
    ['coating_gain_range_percent', null],
    ['default_prepay_percent', '80'],
    ['default_delivery_days', 20],
    ['proforma_validity_text', null],
    ['sales_terms_fa', null],
    ['sales_terms_ar', null],
    ['numbering_patterns', {}],
    ['default_numbering_pattern', 'VT-{seq:4}'],
    ['time_zone', 'Asia/Tehran'],
    ['share_link_days', 7],
    ['error_contact_name', null],
    ['error_contact_channel', null],
    ['product_categories', ['لاین نوری', 'نما', 'درب و پنجره', 'عمومی', 'متفرقه']],
    ['sample_colors', ['سفید', 'مشکی مات', 'مشکی سوپر مات', 'آنادایز نقره‌ای']],
    ['load_type_labels', ['تبدیلی', 'شمشی', 'استاندارد', 'ساخت قالب']],
    ['restore_test_log', []],
  ];
  for (const [key, value] of defaults) {
    await sql`INSERT INTO settings (key, value) VALUES (${key}, ${JSON.stringify(value)}::jsonb)`.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS file_links`.execute(db);
  await sql`DROP TABLE IF EXISTS files`.execute(db);
  await sql`DROP TABLE IF EXISTS counters`.execute(db);
  await sql`DROP TABLE IF EXISTS settings`.execute(db);
  await sql`DROP TABLE IF EXISTS idempotency_keys`.execute(db);
  await sql`DROP TABLE IF EXISTS audit_log`.execute(db);
  await sql`DROP FUNCTION IF EXISTS audit_log_append_only()`.execute(db);
  await sql`DROP TABLE IF EXISTS sessions`.execute(db);
  await sql`DROP TABLE IF EXISTS users`.execute(db);
}
