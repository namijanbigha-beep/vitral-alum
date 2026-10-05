<?php
declare(strict_types=1);

use Vitral\Core\Db;
use Vitral\Core\Migrator as M;

/**
 * MySQL translation of apps/server/src/db/migrations/0001_base.ts — section 7.1 base tables plus files/file_links.
 * Type map: uuid → CHAR(36) ascii (ids generated in PHP), timestamptz → DATETIME(3) UTC, jsonb / text[] → LONGTEXT
 * holding JSON (see Db::JSON_COLUMNS), boolean → TINYINT(1), indexed text → VARCHAR(191).
 * Also creates the PHP-only `rate_limits` table (the Node app keeps these counters in memory).
 */
return function (Db $db, M $m): void {
    $U = M::UUID;

    $m->table('users', "id {$U} NOT NULL PRIMARY KEY,
  mobile VARCHAR(20) NOT NULL,
  name TEXT NOT NULL,
  short_name TEXT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(20) NOT NULL CHECK (role IN ('manager', 'staff')),
  permissions LONGTEXT NOT NULL,
  telegram_chat_id VARCHAR(64) NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  failed_logins INT NOT NULL DEFAULT 0 CHECK (failed_logins >= 0),
  locked_until DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_by {$U} NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  version INT NOT NULL DEFAULT 1,
  CONSTRAINT users_mobile_key UNIQUE (mobile),
  CONSTRAINT users_telegram_chat_id_key UNIQUE (telegram_chat_id),
  CONSTRAINT users_mobile_format CHECK (mobile REGEXP '^09[0-9]{9}$'),
  KEY users_created_by_idx (created_by),
  CONSTRAINT fk_users_created_by FOREIGN KEY (created_by) REFERENCES users(id)");

    $m->table('sessions', "id {$U} NOT NULL PRIMARY KEY,
  user_id {$U} NOT NULL,
  token_hash VARCHAR(128) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  user_agent TEXT NULL,
  last_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_by {$U} NULL,
  CONSTRAINT sessions_token_hash_key UNIQUE (token_hash),
  KEY sessions_user_id_idx (user_id),
  KEY sessions_expires_at_idx (expires_at),
  " . M::fk('sessions', 'user_id', 'users', 'CASCADE') . ",
  CONSTRAINT fk_sessions_created_by FOREIGN KEY (created_by) REFERENCES users(id)");

    $m->table('audit_log', "id {$U} NOT NULL PRIMARY KEY,
  at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  user_id {$U} NULL,
  entity VARCHAR(64) NOT NULL,
  entity_id {$U} NULL,
  action VARCHAR(64) NOT NULL,
  `before` LONGTEXT NULL,
  `after` LONGTEXT NULL,
  reason TEXT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_by {$U} NULL,
  KEY audit_log_entity_idx (entity, entity_id),
  KEY audit_log_user_id_idx (user_id),
  KEY audit_log_at_idx (at),
  " . M::fk('audit_log', 'user_id', 'users') . ",
  CONSTRAINT fk_audit_log_created_by FOREIGN KEY (created_by) REFERENCES users(id)");
    // Principle 7: append-only, enforced by the database where the host allows triggers (the code never updates it).
    $m->optional("CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_log is append-only'", 'append-only trigger (update) on audit_log');
    $m->optional("CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_log is append-only'", 'append-only trigger (delete) on audit_log');

    $m->table('idempotency_keys', "id {$U} NOT NULL PRIMARY KEY,
  request_id {$U} NOT NULL,
  user_id {$U} NULL,
  endpoint VARCHAR(191) NOT NULL,
  response LONGTEXT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_by {$U} NULL,
  CONSTRAINT idempotency_keys_request_id_key UNIQUE (request_id),
  KEY idempotency_keys_user_id_idx (user_id),
  KEY idempotency_keys_created_at_idx (created_at),
  " . M::fk('idempotency_keys', 'user_id', 'users') . ",
  CONSTRAINT fk_idempotency_keys_created_by FOREIGN KEY (created_by) REFERENCES users(id)");

    $m->table('settings', "id {$U} NOT NULL PRIMARY KEY,
  `key` VARCHAR(80) NOT NULL,
  value LONGTEXT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_by {$U} NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  version INT NOT NULL DEFAULT 1,
  CONSTRAINT settings_key_key UNIQUE (`key`),
  CONSTRAINT fk_settings_created_by FOREIGN KEY (created_by) REFERENCES users(id)");

    $m->table('counters', "id {$U} NOT NULL PRIMARY KEY,
  kind VARCHAR(64) NOT NULL,
  year INT NOT NULL,
  `last_value` INT NOT NULL CHECK (`last_value` >= 0),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_by {$U} NULL,
  CONSTRAINT counters_kind_year_key UNIQUE (kind, year),
  CONSTRAINT fk_counters_created_by FOREIGN KEY (created_by) REFERENCES users(id)");

    $m->table('files', "id {$U} NOT NULL PRIMARY KEY,
  storage_key VARCHAR(64) NOT NULL,
  original_name VARCHAR(255) NOT NULL,
  mime VARCHAR(100) NOT NULL,
  size BIGINT NOT NULL,
  sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
  kind VARCHAR(32) NOT NULL,
  caption TEXT NULL,
  `sensitive` TINYINT(1) NOT NULL DEFAULT 0,
  owner_entity VARCHAR(64) NULL,
  owner_id {$U} NULL,
  sort_order INT NOT NULL DEFAULT 0,
  thumb_key VARCHAR(64) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_by {$U} NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  version INT NOT NULL DEFAULT 1,
  CONSTRAINT files_storage_key_key UNIQUE (storage_key),
  CONSTRAINT files_mime_check CHECK (mime IN ('image/jpeg','image/png','image/webp','application/pdf','audio/ogg','audio/mp4','audio/mpeg')),
  CONSTRAINT files_size_check CHECK (size >= 0 AND size <= 20971520),
  CONSTRAINT files_sha256_check CHECK (sha256 REGEXP '^[0-9a-f]{64}$'),
  CONSTRAINT files_kind_check CHECK (kind IN ('product','section','color_sample','drawing','die','bundle','label','load','vehicle','package','waybill','scale_ticket','receipt','delivery_receipt','voice','document_pdf','other')),
  KEY files_owner_idx (owner_entity, owner_id),
  KEY files_created_by_idx (created_by),
  KEY files_sha256_idx (sha256),
  CONSTRAINT fk_files_created_by FOREIGN KEY (created_by) REFERENCES users(id)");

    $m->table('file_links', "id {$U} NOT NULL PRIMARY KEY,
  file_id {$U} NOT NULL,
  entity VARCHAR(64) NOT NULL,
  entity_id {$U} NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_by {$U} NULL,
  CONSTRAINT file_links_unique UNIQUE (file_id, entity, entity_id),
  KEY file_links_entity_idx (entity, entity_id),
  KEY file_links_created_by_idx (created_by),
  " . M::fk('file_links', 'file_id', 'files') . ",
  CONSTRAINT fk_file_links_created_by FOREIGN KEY (created_by) REFERENCES users(id)");

    // PHP only: fixed-window rate-limit counters (Node keeps them in memory).
    $m->table('rate_limits', "bucket CHAR(64) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  window_start DATETIME(3) NOT NULL,
  hits INT NOT NULL DEFAULT 0,
  KEY rate_limits_window_idx (window_start)");

    // Section 18 start settings. Unknown values stay NULL (shown as «نامشخص»), never guessed.
    $defaults = [
        ['seller_name_fa', 'ویترال آلومینیوم اراک'],
        ['seller_name_ar', null],
        ['seller_name_en', null],
        ['seller_address_fa', 'اراک، شهرک صنعتی خیرآباد، خیابان ۳۰۲'],
        ['seller_address_ar', null],
        ['seller_address_en', null],
        ['seller_phone', null],
        ['seller_logo_file_id', null],
        ['default_paint_rate_per_kg', ['amount' => '80000', 'currency' => 'TOMAN']],
        ['weight_per_meter_tolerance_percent', '5'],
        ['bundle_weight_median_threshold_percent', '40'],
        ['production_balance_threshold_percent', '1'],
        ['coating_gain_range_percent', null],
        ['default_prepay_percent', '80'],
        ['default_delivery_days', 20],
        ['proforma_validity_text', null],
        ['sales_terms_fa', null],
        ['sales_terms_ar', null],
        ['numbering_patterns', new stdClass()],
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
    foreach ($defaults as [$key, $value]) $m->seedSetting($key, $value);
};
