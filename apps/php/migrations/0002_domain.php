<?php
declare(strict_types=1);

use Vitral\Core\Db;
use Vitral\Core\Migrator as M;

/**
 * MySQL translation of apps/server/src/db/migrations/0002_domain.ts (sections 7.2–7.7).
 * Differences forced by MySQL 5.7 / MariaDB 10.3 and how they are covered:
 *  - partial unique indexes → STORED generated columns named `_g_*` with a UNIQUE key (Db drops `_g_*` from rows);
 *  - GIN indexes on arrays → none (arrays are JSON in LONGTEXT; filter in SQL with LIKE or in PHP);
 *  - lower(name) indexes → prefix indexes (the utf8mb4_unicode_ci collation is case-insensitive anyway);
 *  - DEFAULT '{}' / CURRENT_DATE → filled by Db::insert() (Db::INSERT_DEFAULTS);
 *  - triggers (append-only stock_moves, allocation total) → created when the host allows; the PHP code must check too.
 */
return function (Db $db, M $m): void {
    $U = M::UUID;
    $B = static fn (string $t) => M::base($t);
    $E = static fn (string $t) => M::editable($t);
    $fk = static fn (string $t, string $c, string $ref, string $on = '') => M::fk($t, $c, $ref, $on);
    $CUR = "CHECK (currency IN ('TOMAN','USD','IQD'))";
    $currency = "currency VARCHAR(8) NOT NULL DEFAULT 'TOMAN' {$CUR}";
    $cur3 = static fn (string $col) => "{$col} VARCHAR(8) NOT NULL DEFAULT 'TOMAN' CHECK ({$col} IN ('TOMAN','USD','IQD'))";
    $TS = 'DATETIME(3) NULL';
    $NOW = 'DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)';

    // 7.2 parties, locations, contracts
    $m->table('parties', $E('parties') . ",
  name TEXT NOT NULL, name_ar TEXT NULL, name_en TEXT NULL,
  phones LONGTEXT NOT NULL, country TEXT NULL, city TEXT NULL, address TEXT NULL, national_id TEXT NULL,
  roles LONGTEXT NOT NULL,
  default_currency VARCHAR(8) NOT NULL DEFAULT 'TOMAN' CHECK (default_currency IN ('TOMAN','USD','IQD')),
  note TEXT NULL, active TINYINT(1) NOT NULL DEFAULT 1,
  merged_into_id {$U} NULL,
  KEY parties_name_idx (name(191)),
  KEY parties_created_by_idx (created_by),
  " . $fk('parties', 'merged_into_id', 'parties'));

    $m->table('locations', $E('locations') . ",
  name TEXT NOT NULL,
  kind VARCHAR(20) NOT NULL CHECK (kind IN ('own_warehouse','factory','painter','in_transit','customer','border')),
  party_id {$U} NULL, active TINYINT(1) NOT NULL DEFAULT 1,
  _g_in_transit TINYINT GENERATED ALWAYS AS (IF(kind = 'in_transit', 1, NULL)) STORED,
  KEY locations_party_id_idx (party_id),
  UNIQUE KEY locations_in_transit_single (_g_in_transit),
  " . $fk('locations', 'party_id', 'parties'));
    if ((int) $db->value('SELECT COUNT(*) FROM locations') === 0) {
        $m->exec("INSERT INTO locations (id, name, kind) VALUES (?, 'انبار ویترال', 'own_warehouse'), (?, 'در مسیر', 'in_transit')", [Db::uuid(), Db::uuid()]);
    }

    $m->table('contracts', $E('contracts') . ",
  party_id {$U} NOT NULL,
  service VARCHAR(20) NOT NULL CHECK (service IN ('extrusion','paint','anodize','smelting','die_making','transport')),
  rate_per_kg DECIMAL(18,2) NULL CHECK (rate_per_kg >= 0), {$currency},
  weight_basis VARCHAR(20) NULL CHECK (weight_basis IN ('input','good_output')),
  fixed_fee DECIMAL(18,2) NULL CHECK (fixed_fee >= 0),
  scrap_owner VARCHAR(16) NULL CHECK (scrap_owner IN ('vitral','factory')),
  scrap_credit_rate DECIMAL(18,2) NULL CHECK (scrap_credit_rate >= 0),
  includes_material TINYINT(1) NULL,
  freight_payer VARCHAR(16) NULL CHECK (freight_payer IN ('vitral','party')),
  rework_payer VARCHAR(16) NULL CHECK (rework_payer IN ('vitral','party')),
  allowed_loss_percent DECIMAL(5,2) NULL CHECK (allowed_loss_percent >= 0 AND allowed_loss_percent <= 100),
  valid_from DATE NOT NULL, valid_to DATE NULL, note TEXT NULL,
  CONSTRAINT contracts_valid_range CHECK (valid_to IS NULL OR valid_to >= valid_from),
  KEY contracts_party_service_idx (party_id, service, valid_from),
  " . $fk('contracts', 'party_id', 'parties'));

    // 7.3 products, fillers, dies, die events, die orders
    $m->table('products', $E('products') . ",
  code VARCHAR(191) NOT NULL, name_fa TEXT NOT NULL, name_ar TEXT NULL, name_en TEXT NULL,
  category VARCHAR(20) NULL CHECK (category IN ('light_line','facade','door_window','general','misc')),
  alloy TEXT NULL, section_area_mm2 DECIMAL(10,2) NULL CHECK (section_area_mm2 > 0),
  weight_g_per_m_no_filler DECIMAL(8,1) NULL CHECK (weight_g_per_m_no_filler > 0),
  common_lengths LONGTEXT NOT NULL, colors LONGTEXT NOT NULL,
  drawing_version TEXT NULL, description TEXT NULL, main_file_id {$U} NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  CONSTRAINT products_code_key UNIQUE (code),
  KEY products_name_idx (name_fa(191)),
  KEY products_main_file_id_idx (main_file_id),
  " . $fk('products', 'main_file_id', 'files'));

    $m->table('product_fillers', $E('product_fillers') . ",
  product_id {$U} NOT NULL,
  filler_mm DECIMAL(4,2) NULL CHECK (filler_mm > 0),
  weight_g_per_m DECIMAL(8,1) NOT NULL CHECK (weight_g_per_m > 0),
  source VARCHAR(16) NOT NULL CHECK (source IN ('drawing','sample','formula','agreed')),
  sample_length_m DECIMAL(5,2) NULL CHECK (sample_length_m > 0), sample_weight_kg DECIMAL(12,3) NULL CHECK (sample_weight_kg > 0),
  status VARCHAR(16) NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','approved')),
  approved_by {$U} NULL, approved_at {$TS}, note TEXT NULL,
  _g_approved_product {$U} GENERATED ALWAYS AS (IF(status = 'approved', product_id, NULL)) STORED,
  _g_approved_filler DECIMAL(4,2) GENERATED ALWAYS AS (IF(status = 'approved', COALESCE(filler_mm, -1), NULL)) STORED,
  KEY product_fillers_product_id_idx (product_id),
  UNIQUE KEY product_fillers_one_approved (_g_approved_product, _g_approved_filler),
  " . $fk('product_fillers', 'product_id', 'products') . ',
  ' . $fk('product_fillers', 'approved_by', 'users'));

    $m->table('dies', $E('dies') . ",
  code VARCHAR(191) NOT NULL, name TEXT NULL, product_id {$U} NULL,
  owner_party_id {$U} NULL, location_id {$U} NULL,
  compatible_press TEXT NULL, maker_party_id {$U} NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'ready' CHECK (status IN ('design','making','ready','needs_repair','retired','in_transit')),
  total_produced_kg DECIMAL(14,3) NOT NULL DEFAULT 0 CHECK (total_produced_kg >= 0),
  run_count INT NOT NULL DEFAULT 0 CHECK (run_count >= 0), last_run_at {$TS}, note TEXT NULL,
  CONSTRAINT dies_code_key UNIQUE (code),
  KEY dies_product_id_idx (product_id),
  KEY dies_location_id_idx (location_id),
  KEY dies_owner_party_id_idx (owner_party_id),
  KEY dies_maker_party_id_idx (maker_party_id),
  " . $fk('dies', 'product_id', 'products') . ',
  ' . $fk('dies', 'owner_party_id', 'parties') . ',
  ' . $fk('dies', 'location_id', 'locations') . ',
  ' . $fk('dies', 'maker_party_id', 'parties'));

    $m->table('die_events', $B('die_events') . ",
  die_id {$U} NOT NULL,
  kind VARCHAR(16) NOT NULL CHECK (kind IN ('moved','repair','filler_check','damage','note')),
  at {$NOW}, detail TEXT NULL,
  measured_filler_mm DECIMAL(4,2) NULL CHECK (measured_filler_mm > 0),
  production_run_id {$U} NULL, bundle_id {$U} NULL,
  KEY die_events_die_id_idx (die_id, at),
  " . $fk('die_events', 'die_id', 'dies'));

    $m->table('die_orders', $E('die_orders') . ",
  number VARCHAR(191) NOT NULL, customer_party_id {$U} NULL,
  maker_party_id {$U} NULL, die_id {$U} NULL, order_line_id {$U} NULL,
  step VARCHAR(20) NOT NULL DEFAULT 'drawing_received' CHECK (step IN ('drawing_received','quoted','ordered','delivered','trial_run','registered')),
  maker_cost DECIMAL(18,2) NULL CHECK (maker_cost >= 0), {$currency},
  due_date DATE NULL, steps LONGTEXT NOT NULL, purchase_document_id {$U} NULL, note TEXT NULL,
  CONSTRAINT die_orders_number_key UNIQUE (number),
  KEY die_orders_customer_idx (customer_party_id),
  KEY die_orders_maker_idx (maker_party_id),
  KEY die_orders_die_id_idx (die_id),
  " . $fk('die_orders', 'customer_party_id', 'parties') . ',
  ' . $fk('die_orders', 'maker_party_id', 'parties') . ',
  ' . $fk('die_orders', 'die_id', 'dies'));

    // 7.4 sales
    $m->table('orders', $E('orders') . ",
  number VARCHAR(191) NOT NULL, title TEXT NULL, party_id {$U} NOT NULL,
  {$currency},
  settlement_basis VARCHAR(20) NOT NULL DEFAULT 'final_net_scale' CHECK (settlement_basis IN ('final_net_scale','agreed_weight')),
  prepay_percent DECIMAL(5,2) NULL CHECK (prepay_percent >= 0 AND prepay_percent <= 100), prepay_amount DECIMAL(18,2) NULL CHECK (prepay_amount >= 0),
  payment_terms VARCHAR(16) NOT NULL DEFAULT 'cash' CHECK (payment_terms IN ('cash','credit')),
  valid_until DATE NULL, validity_text TEXT NULL, delivery_days INT NULL CHECK (delivery_days >= 0), due_date DATE NULL,
  destination_country TEXT NULL, destination_city TEXT NULL, destination_address TEXT NULL,
  owner_user_id {$U} NULL,
  status_sales VARCHAR(16) NOT NULL DEFAULT 'draft' CHECK (status_sales IN ('draft','proforma','approved','cancelled')),
  revision INT NOT NULL DEFAULT 0, approved_by {$U} NULL, approved_at {$TS},
  invoice_notes TEXT NULL, internal_note TEXT NULL, archived TINYINT(1) NOT NULL DEFAULT 0,
  order_date DATE NOT NULL, print_count INT NOT NULL DEFAULT 0,
  cost_confirmed_by {$U} NULL, cost_confirmed_at {$TS}, cancel_reason TEXT NULL,
  CONSTRAINT orders_number_key UNIQUE (number),
  KEY orders_party_id_idx (party_id),
  KEY orders_owner_idx (owner_user_id),
  KEY orders_status_idx (status_sales, archived),
  KEY orders_due_date_idx (due_date),
  KEY orders_date_idx (order_date),
  " . $fk('orders', 'party_id', 'parties') . ',
  ' . $fk('orders', 'owner_user_id', 'users') . ',
  ' . $fk('orders', 'approved_by', 'users') . ',
  ' . $fk('orders', 'cost_confirmed_by', 'users'));

    $m->table('order_lines', $E('order_lines') . ",
  order_id {$U} NOT NULL, sort INT NOT NULL DEFAULT 0,
  kind VARCHAR(16) NOT NULL CHECK (kind IN ('profile','material','die_making','service')),
  product_id {$U} NULL, product_filler_id {$U} NULL,
  filler_mm DECIMAL(4,2) NULL, length_m DECIMAL(5,2) NULL CHECK (length_m > 0), min_length_m DECIMAL(5,2) NULL CHECK (min_length_m > 0),
  color TEXT NULL, load_type_label TEXT NULL, weight_g_per_m DECIMAL(8,1) NULL CHECK (weight_g_per_m > 0), weight_unapproved TINYINT(1) NOT NULL DEFAULT 0,
  calc_mode VARCHAR(16) NOT NULL DEFAULT 'manual' CHECK (calc_mode IN ('from_bars','from_weight','manual')),
  qty_bars DECIMAL(10,1) NULL CHECK (qty_bars >= 0), qty_kg DECIMAL(12,3) NULL CHECK (qty_kg >= 0), qty_is_estimate TINYINT(1) NOT NULL DEFAULT 0,
  qty_pieces INT NULL CHECK (qty_pieces >= 0),
  price_basis VARCHAR(16) NOT NULL DEFAULT 'per_kg' CHECK (price_basis IN ('per_kg','per_bar','per_meter','per_piece')),
  unit_price DECIMAL(18,2) NULL CHECK (unit_price >= 0), {$currency},
  discount_amount DECIMAL(18,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  discount_percent DECIMAL(5,2) NOT NULL DEFAULT 0 CHECK (discount_percent >= 0 AND discount_percent <= 100),
  supply_method VARCHAR(24) NULL CHECK (supply_method IN ('toll_production','stock','buy_raw_then_paint','buy_finished')),
  die_id {$U} NULL, material_kind VARCHAR(16) NULL CHECK (material_kind IN ('ingot','billet','scrap','paint_powder','tool')),
  coating_gain_estimate_percent DECIMAL(5,2) NULL,
  vat_rate DECIMAL(5,2) NULL, vat_amount DECIMAL(18,2) NULL, name_ar TEXT NULL, name_en TEXT NULL, description TEXT NULL,
  file_id {$U} NULL, note TEXT NULL,
  KEY order_lines_order_id_idx (order_id, sort),
  KEY order_lines_product_id_idx (product_id),
  KEY order_lines_die_id_idx (die_id),
  KEY order_lines_filler_idx (product_filler_id),
  KEY order_lines_file_idx (file_id),
  " . $fk('order_lines', 'order_id', 'orders', 'CASCADE') . ',
  ' . $fk('order_lines', 'product_id', 'products') . ',
  ' . $fk('order_lines', 'product_filler_id', 'product_fillers') . ',
  ' . $fk('order_lines', 'die_id', 'dies') . ',
  ' . $fk('order_lines', 'file_id', 'files'));
    $m->exec('ALTER TABLE die_orders ADD CONSTRAINT die_orders_order_line_fk FOREIGN KEY (order_line_id) REFERENCES order_lines(id)');
    $m->exec('CREATE INDEX die_orders_order_line_idx ON die_orders (order_line_id)');

    $m->table('order_revisions', $B('order_revisions') . ",
  order_id {$U} NOT NULL, revision INT NOT NULL,
  snapshot LONGTEXT NOT NULL, reason TEXT NULL,
  CONSTRAINT order_revisions_order_id_revision_key UNIQUE (order_id, revision),
  " . $fk('order_revisions', 'order_id', 'orders', 'CASCADE'));

    // 7.5 weight and operations
    $m->table('material_lots', $E('material_lots') . ",
  kind VARCHAR(16) NOT NULL CHECK (kind IN ('ingot','billet','scrap','paint_powder','tool')),
  alloy VARCHAR(100) NULL, grade TEXT NULL, batch_no TEXT NULL, owner_party_id {$U} NULL,
  unit VARCHAR(16) NOT NULL DEFAULT 'kg' CHECK (unit IN ('kg','carton','piece')),
  kg_per_unit DECIMAL(12,3) NULL CHECK (kg_per_unit > 0), description TEXT NULL,
  tool_class VARCHAR(16) NULL CHECK (tool_class IN ('consumable','equipment')), responsible_user_id {$U} NULL,
  KEY material_lots_kind_idx (kind, alloy, owner_party_id),
  KEY material_lots_owner_idx (owner_party_id),
  " . $fk('material_lots', 'owner_party_id', 'parties') . ',
  ' . $fk('material_lots', 'responsible_user_id', 'users'));

    $m->table('production_runs', $E('production_runs') . ",
  number VARCHAR(191) NOT NULL, factory_party_id {$U} NOT NULL, location_id {$U} NOT NULL,
  service VARCHAR(16) NOT NULL DEFAULT 'extrusion' CHECK (service IN ('extrusion','smelting')),
  started_at {$NOW}, due_at {$TS}, contract_id {$U} NULL,
  rate_per_kg DECIMAL(18,2) NULL CHECK (rate_per_kg >= 0), " . $cur3('rate_currency') . ",
  weight_basis VARCHAR(20) NULL CHECK (weight_basis IN ('input','good_output')), fixed_fee DECIMAL(18,2) NULL CHECK (fixed_fee >= 0),
  scrap_owner VARCHAR(16) NULL CHECK (scrap_owner IN ('vitral','factory')), scrap_credit_rate DECIMAL(18,2) NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  ingot_allocated_kg DECIMAL(12,3) NOT NULL DEFAULT 0 CHECK (ingot_allocated_kg >= 0),
  ingot_consumed_kg DECIMAL(12,3) NULL CHECK (ingot_consumed_kg >= 0),
  good_kg DECIMAL(12,3) NOT NULL DEFAULT 0, rejected_kg DECIMAL(12,3) NOT NULL DEFAULT 0,
  scrap_kg DECIMAL(12,3) NOT NULL DEFAULT 0 CHECK (scrap_kg >= 0), returned_material_kg DECIMAL(12,3) NOT NULL DEFAULT 0 CHECK (returned_material_kg >= 0),
  unexplained_kg DECIMAL(12,3) NULL, close_reason TEXT NULL, closed_by {$U} NULL, closed_at {$TS},
  press TEXT NULL, shift TEXT NULL, heat_treatment TEXT NULL, note TEXT NULL, fee_document_id {$U} NULL, shortage_document_id {$U} NULL,
  CONSTRAINT production_runs_number_key UNIQUE (number),
  KEY production_runs_factory_idx (factory_party_id, status),
  KEY production_runs_location_idx (location_id),
  KEY production_runs_contract_idx (contract_id),
  KEY production_runs_started_idx (started_at),
  " . $fk('production_runs', 'factory_party_id', 'parties') . ',
  ' . $fk('production_runs', 'location_id', 'locations') . ',
  ' . $fk('production_runs', 'contract_id', 'contracts') . ',
  ' . $fk('production_runs', 'closed_by', 'users'));

    $m->table('production_run_lines', $B('production_run_lines') . ",
  run_id {$U} NOT NULL, order_line_id {$U} NULL,
  product_id {$U} NOT NULL, die_id {$U} NULL,
  filler_mm DECIMAL(4,2) NULL, length_m DECIMAL(5,2) NULL, target_kg DECIMAL(12,3) NULL CHECK (target_kg >= 0), target_bars INT NULL CHECK (target_bars >= 0),
  KEY production_run_lines_run_idx (run_id),
  KEY production_run_lines_order_line_idx (order_line_id),
  KEY production_run_lines_product_idx (product_id),
  KEY production_run_lines_die_idx (die_id),
  " . $fk('production_run_lines', 'run_id', 'production_runs', 'CASCADE') . ',
  ' . $fk('production_run_lines', 'order_line_id', 'order_lines') . ',
  ' . $fk('production_run_lines', 'product_id', 'products') . ',
  ' . $fk('production_run_lines', 'die_id', 'dies'));

    $m->table('bundles', $E('bundles') . ",
  code VARCHAR(191) NOT NULL, code_is_temp TINYINT(1) NOT NULL DEFAULT 0,
  production_run_id {$U} NULL, factory_party_id {$U} NULL,
  source VARCHAR(16) NOT NULL DEFAULT 'production' CHECK (source IN ('production','purchase','opening','return')),
  weight_kg DECIMAL(12,3) NOT NULL CHECK (weight_kg >= 0), packaging_kg DECIMAL(12,3) NULL CHECK (packaging_kg >= 0),
  location_id {$U} NOT NULL,
  form VARCHAR(16) NOT NULL DEFAULT 'raw' CHECK (form IN ('raw','painted','anodized')), color TEXT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','damaged','wrong_product','pending_review','scrapped','consumed')),
  qc_note TEXT NULL, defect TEXT NULL, decision VARCHAR(16) NULL CHECK (decision IN ('accept','rework','discount_sale','scrap')),
  decided_by {$U} NULL, decided_at {$TS}, decision_note TEXT NULL,
  reserved_order_line_id {$U} NULL,
  raw_weight_kg DECIMAL(12,3) NULL CHECK (raw_weight_kg >= 0), measured_filler_mm DECIMAL(4,2) NULL, measured_length_m DECIMAL(5,2) NULL,
  reported_at {$NOW}, draft TINYINT(1) NOT NULL DEFAULT 0,
  warnings LONGTEXT NOT NULL, origin_bundle_ids LONGTEXT NOT NULL, note TEXT NULL,
  _g_factory_code {$U} GENERATED ALWAYS AS (IF(code_is_temp = 0 AND factory_party_id IS NOT NULL, factory_party_id, NULL)) STORED,
  UNIQUE KEY bundles_factory_code_key (_g_factory_code, code),
  KEY bundles_run_idx (production_run_id),
  KEY bundles_location_idx (location_id, status, form),
  KEY bundles_reserved_idx (reserved_order_line_id),
  KEY bundles_reported_idx (reported_at),
  KEY bundles_code_idx (code),
  KEY bundles_factory_idx (factory_party_id),
  " . $fk('bundles', 'production_run_id', 'production_runs') . ',
  ' . $fk('bundles', 'factory_party_id', 'parties') . ',
  ' . $fk('bundles', 'location_id', 'locations') . ',
  ' . $fk('bundles', 'decided_by', 'users') . ',
  ' . $fk('bundles', 'reserved_order_line_id', 'order_lines'));

    $m->table('bundle_lines', $B('bundle_lines') . ",
  bundle_id {$U} NOT NULL, product_id {$U} NOT NULL,
  filler_mm DECIMAL(4,2) NULL, length_m DECIMAL(5,2) NULL CHECK (length_m > 0), bars INT NULL CHECK (bars >= 0),
  weight_kg DECIMAL(12,3) NULL CHECK (weight_kg >= 0), order_line_id {$U} NULL, sort INT NOT NULL DEFAULT 0,
  KEY bundle_lines_bundle_idx (bundle_id),
  KEY bundle_lines_product_idx (product_id),
  KEY bundle_lines_order_line_idx (order_line_id),
  " . $fk('bundle_lines', 'bundle_id', 'bundles', 'CASCADE') . ',
  ' . $fk('bundle_lines', 'product_id', 'products') . ',
  ' . $fk('bundle_lines', 'order_line_id', 'order_lines'));
    $m->exec('ALTER TABLE die_events ADD CONSTRAINT die_events_run_fk FOREIGN KEY (production_run_id) REFERENCES production_runs(id)');
    $m->exec('ALTER TABLE die_events ADD CONSTRAINT die_events_bundle_fk FOREIGN KEY (bundle_id) REFERENCES bundles(id)');
    $m->exec('CREATE INDEX die_events_run_idx ON die_events (production_run_id)');
    $m->exec('CREATE INDEX die_events_bundle_idx ON die_events (bundle_id)');

    $m->table('reservations', $E('reservations') . ",
  order_line_id {$U} NOT NULL, bundle_id {$U} NULL, material_lot_id {$U} NULL,
  kg DECIMAL(12,3) NOT NULL CHECK (kg > 0),
  status VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active','consumed','released')),
  CONSTRAINT reservations_one_item CHECK ((bundle_id IS NOT NULL) <> (material_lot_id IS NOT NULL)),
  KEY reservations_line_idx (order_line_id, status),
  KEY reservations_bundle_idx (bundle_id, status),
  KEY reservations_lot_idx (material_lot_id, status),
  " . $fk('reservations', 'order_line_id', 'order_lines') . ',
  ' . $fk('reservations', 'bundle_id', 'bundles') . ',
  ' . $fk('reservations', 'material_lot_id', 'material_lots'));

    $m->table('coating_runs', $E('coating_runs') . ",
  number VARCHAR(191) NOT NULL, party_id {$U} NOT NULL,
  service VARCHAR(16) NOT NULL CHECK (service IN ('paint','anodize')), color_code TEXT NULL, contract_id {$U} NULL,
  rate_per_kg DECIMAL(18,2) NULL CHECK (rate_per_kg >= 0), " . $cur3('rate_currency') . ",
  includes_material TINYINT(1) NULL, sent_at {$NOW}, due_at {$TS},
  input_basis VARCHAR(16) NOT NULL DEFAULT 'bundle_sum' CHECK (input_basis IN ('bundle_sum','scale_ticket','agreed')),
  input_basis_kg DECIMAL(12,3) NULL CHECK (input_basis_kg >= 0), basis_reason TEXT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'open' CHECK (status IN ('open','partially_returned','returned','closed')),
  transfer_id {$U} NULL, fee_document_id {$U} NULL, material_lot_id {$U} NULL, material_units DECIMAL(12,3) NULL, note TEXT NULL,
  closed_by {$U} NULL, closed_at {$TS},
  CONSTRAINT coating_runs_number_key UNIQUE (number),
  KEY coating_runs_party_idx (party_id, status),
  KEY coating_runs_contract_idx (contract_id),
  KEY coating_runs_sent_idx (sent_at),
  " . $fk('coating_runs', 'party_id', 'parties') . ',
  ' . $fk('coating_runs', 'contract_id', 'contracts') . ',
  ' . $fk('coating_runs', 'material_lot_id', 'material_lots') . ',
  ' . $fk('coating_runs', 'closed_by', 'users'));

    $m->table('coating_run_items', $E('coating_run_items') . ",
  run_id {$U} NOT NULL, bundle_id {$U} NOT NULL,
  raw_kg DECIMAL(12,3) NOT NULL CHECK (raw_kg >= 0), coated_kg DECIMAL(12,3) NULL CHECK (coated_kg >= 0), returned_at {$TS},
  qc VARCHAR(16) NULL CHECK (qc IN ('ok','needs_review','rejected')), bars_returned INT NULL CHECK (bars_returned >= 0),
  gain_needs_review TINYINT(1) NOT NULL DEFAULT 0, note TEXT NULL,
  CONSTRAINT coating_run_items_run_id_bundle_id_key UNIQUE (run_id, bundle_id),
  KEY coating_run_items_bundle_idx (bundle_id),
  " . $fk('coating_run_items', 'run_id', 'coating_runs', 'CASCADE') . ',
  ' . $fk('coating_run_items', 'bundle_id', 'bundles'));

    $m->table('transfers', $E('transfers') . ",
  number VARCHAR(191) NOT NULL,
  kind VARCHAR(24) NOT NULL CHECK (kind IN ('ingot_in','to_production','raw_delivery','to_coating','from_coating','between_locations','to_customer','customer_return','scrap_out','scrap_in','die_move','general')),
  from_location_id {$U} NULL, to_location_id {$U} NULL,
  carrier_party_id {$U} NULL, vehicle_type TEXT NULL, plate VARCHAR(191) NULL, driver_name TEXT NULL, driver_phone TEXT NULL, waybill_no TEXT NULL,
  departed_at {$TS}, eta {$TS}, received_at {$TS}, receiver_name TEXT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','dispatched','in_transit','at_border','partially_received','received','delivered')),
  freight_cost DECIMAL(18,2) NULL CHECK (freight_cost >= 0), " . $cur3('freight_currency') . ",
  freight_payer VARCHAR(16) NULL CHECK (freight_payer IN ('vitral','customer','party')), delivery_term TEXT NULL,
  destination_country TEXT NULL, destination_city TEXT NULL, destination_address TEXT NULL, consignee TEXT NULL, bill_to_party_id {$U} NULL,
  is_export TINYINT(1) NOT NULL DEFAULT 0, border TEXT NULL, transport_mode TEXT NULL,
  order_ids LONGTEXT NOT NULL, production_run_id {$U} NULL, coating_run_id {$U} NULL,
  purchase_document_id {$U} NULL, returns_transfer_id {$U} NULL, freight_document_id {$U} NULL,
  dispatched_by {$U} NULL, note TEXT NULL, print_count INT NOT NULL DEFAULT 0,
  CONSTRAINT transfers_number_key UNIQUE (number),
  KEY transfers_from_idx (from_location_id),
  KEY transfers_to_idx (to_location_id),
  KEY transfers_carrier_idx (carrier_party_id),
  KEY transfers_status_idx (status, kind),
  KEY transfers_run_idx (production_run_id),
  KEY transfers_coating_idx (coating_run_id),
  KEY transfers_departed_idx (departed_at),
  KEY transfers_plate_idx (plate),
  KEY transfers_bill_to_idx (bill_to_party_id),
  KEY transfers_returns_idx (returns_transfer_id),
  " . $fk('transfers', 'from_location_id', 'locations') . ',
  ' . $fk('transfers', 'to_location_id', 'locations') . ',
  ' . $fk('transfers', 'carrier_party_id', 'parties') . ',
  ' . $fk('transfers', 'bill_to_party_id', 'parties') . ',
  ' . $fk('transfers', 'production_run_id', 'production_runs') . ',
  ' . $fk('transfers', 'coating_run_id', 'coating_runs') . ',
  ' . $fk('transfers', 'returns_transfer_id', 'transfers') . ',
  ' . $fk('transfers', 'dispatched_by', 'users'));
    $m->exec('ALTER TABLE coating_runs ADD CONSTRAINT coating_runs_transfer_fk FOREIGN KEY (transfer_id) REFERENCES transfers(id)');
    $m->exec('CREATE INDEX coating_runs_transfer_idx ON coating_runs (transfer_id)');

    $m->table('transfer_lines', $E('transfer_lines') . ",
  transfer_id {$U} NOT NULL,
  bundle_id {$U} NULL, material_lot_id {$U} NULL, die_id {$U} NULL,
  order_id {$U} NULL, order_line_id {$U} NULL,
  kg DECIMAL(12,3) NULL CHECK (kg >= 0), bars INT NULL CHECK (bars >= 0), packages INT NULL CHECK (packages >= 0), bars_per_package INT NULL CHECK (bars_per_package >= 0),
  length_m DECIMAL(5,2) NULL, received_kg DECIMAL(12,3) NULL CHECK (received_kg >= 0), received_at {$TS},
  diff_reason VARCHAR(24) NULL CHECK (diff_reason IN ('scale_difference','packaging','shortage','partial_unload','other')), diff_note TEXT NULL,
  CONSTRAINT transfer_lines_one_item CHECK (((bundle_id IS NOT NULL) + (material_lot_id IS NOT NULL) + (die_id IS NOT NULL)) = 1),
  KEY transfer_lines_transfer_idx (transfer_id),
  KEY transfer_lines_bundle_idx (bundle_id),
  KEY transfer_lines_lot_idx (material_lot_id),
  KEY transfer_lines_die_idx (die_id),
  KEY transfer_lines_order_idx (order_id),
  KEY transfer_lines_order_line_idx (order_line_id),
  " . $fk('transfer_lines', 'transfer_id', 'transfers', 'CASCADE') . ',
  ' . $fk('transfer_lines', 'bundle_id', 'bundles') . ',
  ' . $fk('transfer_lines', 'material_lot_id', 'material_lots') . ',
  ' . $fk('transfer_lines', 'die_id', 'dies') . ',
  ' . $fk('transfer_lines', 'order_id', 'orders') . ',
  ' . $fk('transfer_lines', 'order_line_id', 'order_lines'));

    $m->table('scale_tickets', $E('scale_tickets') . ",
  transfer_id {$U} NULL, coating_run_id {$U} NULL, production_run_id {$U} NULL,
  site TEXT NULL, ticket_no TEXT NULL, at {$TS},
  gross_kg DECIMAL(12,3) NULL CHECK (gross_kg >= 0), tare_kg DECIMAL(12,3) NULL CHECK (tare_kg >= 0), packaging_kg DECIMAL(12,3) NULL CHECK (packaging_kg >= 0), net_direct_kg DECIMAL(12,3) NULL CHECK (net_direct_kg >= 0),
  stage VARCHAR(16) NOT NULL CHECK (stage IN ('origin','destination','factory_in','factory_out','painter_in','painter_out','border')),
  approved_for LONGTEXT NOT NULL,
  approved_by {$U} NULL, approved_at {$TS},
  status VARCHAR(24) NOT NULL DEFAULT 'needs_completion' CHECK (status IN ('needs_completion','recorded','approved')),
  file_id {$U} NULL, note TEXT NULL,
  KEY scale_tickets_transfer_idx (transfer_id),
  KEY scale_tickets_coating_idx (coating_run_id),
  KEY scale_tickets_run_idx (production_run_id),
  KEY scale_tickets_file_idx (file_id),
  KEY scale_tickets_status_idx (status),
  " . $fk('scale_tickets', 'transfer_id', 'transfers') . ',
  ' . $fk('scale_tickets', 'coating_run_id', 'coating_runs') . ',
  ' . $fk('scale_tickets', 'production_run_id', 'production_runs') . ',
  ' . $fk('scale_tickets', 'approved_by', 'users') . ',
  ' . $fk('scale_tickets', 'file_id', 'files'));

    $m->table('packing_lines', $E('packing_lines') . ",
  transfer_id {$U} NOT NULL, order_id {$U} NULL, order_line_id {$U} NULL,
  product_id {$U} NULL, description TEXT NULL, filler_mm DECIMAL(4,2) NULL, color TEXT NULL, length_m DECIMAL(5,2) NULL,
  packages INT NOT NULL DEFAULT 0 CHECK (packages >= 0), bars_per_package INT NULL CHECK (bars_per_package >= 0), bars INT NULL CHECK (bars >= 0),
  weight_kg DECIMAL(12,3) NULL CHECK (weight_kg >= 0), weight_mode VARCHAR(16) NOT NULL DEFAULT 'group_total' CHECK (weight_mode IN ('group_total','per_package')),
  is_partial TINYINT(1) NOT NULL DEFAULT 0, gross_kg DECIMAL(12,3) NULL CHECK (gross_kg >= 0), sort INT NOT NULL DEFAULT 0,
  KEY packing_lines_transfer_idx (transfer_id, sort),
  KEY packing_lines_order_idx (order_id),
  KEY packing_lines_order_line_idx (order_line_id),
  KEY packing_lines_product_idx (product_id),
  " . $fk('packing_lines', 'transfer_id', 'transfers', 'CASCADE') . ',
  ' . $fk('packing_lines', 'order_id', 'orders') . ',
  ' . $fk('packing_lines', 'order_line_id', 'order_lines') . ',
  ' . $fk('packing_lines', 'product_id', 'products'));

    // Weight ledger (principle 8): append-only.
    $m->table('stock_moves', $B('stock_moves') . ",
  at {$NOW},
  item_type VARCHAR(16) NOT NULL CHECK (item_type IN ('material_lot','bundle')), item_id {$U} NOT NULL,
  from_location_id {$U} NULL, to_location_id {$U} NULL,
  kg DECIMAL(12,3) NOT NULL CHECK (kg >= 0), state_from TEXT NULL, state_to TEXT NULL,
  ref_type VARCHAR(32) NOT NULL CHECK (ref_type IN ('purchase_receipt','transfer_dispatch','transfer_receive','production_consume','production_output','coating_send','coating_return','sale_dispatch','customer_return','scrap_conversion','count_adjustment','opening','material_consume','smelting_output')),
  ref_id {$U} NOT NULL, unit_cost DECIMAL(18,2) NULL, currency VARCHAR(8) NULL {$CUR}, owner_party_id {$U} NULL, note TEXT NULL,
  CONSTRAINT stock_moves_has_location CHECK (from_location_id IS NOT NULL OR to_location_id IS NOT NULL),
  KEY stock_moves_item_idx (item_type, item_id, at),
  KEY stock_moves_from_idx (from_location_id, at),
  KEY stock_moves_to_idx (to_location_id, at),
  KEY stock_moves_ref_idx (ref_type, ref_id),
  KEY stock_moves_at_idx (at),
  KEY stock_moves_owner_idx (owner_party_id),
  " . $fk('stock_moves', 'from_location_id', 'locations') . ',
  ' . $fk('stock_moves', 'to_location_id', 'locations') . ',
  ' . $fk('stock_moves', 'owner_party_id', 'parties'));
    $m->optional("CREATE TRIGGER stock_moves_no_update BEFORE UPDATE ON stock_moves FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_log is append-only'", 'append-only trigger (update) on stock_moves');
    $m->optional("CREATE TRIGGER stock_moves_no_delete BEFORE DELETE ON stock_moves FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_log is append-only'", 'append-only trigger (delete) on stock_moves');

    // 7.6 money
    $m->table('accounts', $E('accounts') . ",
  name TEXT NOT NULL, kind VARCHAR(8) NOT NULL CHECK (kind IN ('bank','cash')), {$currency}, active TINYINT(1) NOT NULL DEFAULT 1");

    $m->table('fx_rates', $B('fx_rates') . ",
  at {$NOW}, from_currency VARCHAR(8) NOT NULL CHECK (from_currency IN ('TOMAN','USD','IQD')),
  to_currency VARCHAR(8) NOT NULL CHECK (to_currency IN ('TOMAN','USD','IQD')), rate DECIMAL(18,6) NOT NULL CHECK (rate > 0),
  source_text TEXT NULL, kind VARCHAR(24) NOT NULL CHECK (kind IN ('agreed_settlement','report_daily')),
  CONSTRAINT fx_rates_distinct CHECK (from_currency <> to_currency),
  KEY fx_rates_at_idx (from_currency, to_currency, at)");

    $m->table('documents', $E('documents') . ",
  number VARCHAR(191) NOT NULL,
  kind VARCHAR(24) NOT NULL CHECK (kind IN ('invoice','sales_return','purchase','toll_fee','expense','receipt','payment','barter','opening_balance','fx_difference')),
  party_id {$U} NULL, amount DECIMAL(18,2) NULL CHECK (amount >= 0), {$currency},
  `date` DATE NOT NULL, due_date DATE NULL,
  method VARCHAR(24) NULL CHECK (method IN ('cash','card','bank_transfer','exchange_house','cheque','other')), account_id {$U} NULL, tracking_no TEXT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','reported','posted','void','needs_completion')),
  reverses_document_id {$U} NULL, reversed_by_document_id {$U} NULL,
  source_type VARCHAR(64) NULL, source_id {$U} NULL, order_id {$U} NULL, transfer_id {$U} NULL,
  expense_type VARCHAR(16) NULL CHECK (expense_type IN ('order','shared','general')), expense_category TEXT NULL,
  purchase_kind VARCHAR(24) NULL CHECK (purchase_kind IN ('ingot','billet','scrap','paint_powder','tool','raw_profile','finished_profile','die','other')),
  material_lot_id {$U} NULL, agreed_kg DECIMAL(12,3) NULL CHECK (agreed_kg >= 0), unit_price DECIMAL(18,2) NULL CHECK (unit_price >= 0),
  received_kg DECIMAL(12,3) NOT NULL DEFAULT 0, barter_sign INT NULL CHECK (barter_sign IN (-1, 1)), barter_kg DECIMAL(12,3) NULL,
  description TEXT NULL, print_count INT NOT NULL DEFAULT 0, posted_by {$U} NULL, posted_at {$TS},
  reported_by {$U} NULL, settlement_basis_kg DECIMAL(12,3) NULL, file_ids LONGTEXT NOT NULL, locked TINYINT(1) NOT NULL DEFAULT 0, note TEXT NULL,
  CONSTRAINT documents_number_key UNIQUE (number),
  KEY documents_party_idx (party_id, currency, status),
  KEY documents_kind_idx (kind, status, `date`),
  KEY documents_order_idx (order_id),
  KEY documents_transfer_idx (transfer_id),
  KEY documents_source_idx (source_type, source_id),
  KEY documents_account_idx (account_id),
  KEY documents_reverses_idx (reverses_document_id),
  KEY documents_reversed_by_idx (reversed_by_document_id),
  KEY documents_lot_idx (material_lot_id),
  KEY documents_date_idx (`date`),
  KEY documents_posted_by_idx (posted_by),
  KEY documents_reported_by_idx (reported_by),
  " . $fk('documents', 'party_id', 'parties') . ',
  ' . $fk('documents', 'account_id', 'accounts') . ',
  ' . $fk('documents', 'reverses_document_id', 'documents') . ',
  ' . $fk('documents', 'reversed_by_document_id', 'documents') . ',
  ' . $fk('documents', 'order_id', 'orders') . ',
  ' . $fk('documents', 'transfer_id', 'transfers') . ',
  ' . $fk('documents', 'material_lot_id', 'material_lots') . ',
  ' . $fk('documents', 'posted_by', 'users') . ',
  ' . $fk('documents', 'reported_by', 'users'));
    $m->exec('ALTER TABLE production_runs ADD CONSTRAINT production_runs_fee_fk FOREIGN KEY (fee_document_id) REFERENCES documents(id)');
    $m->exec('ALTER TABLE production_runs ADD CONSTRAINT production_runs_shortage_fk FOREIGN KEY (shortage_document_id) REFERENCES documents(id)');
    $m->exec('CREATE INDEX production_runs_fee_idx ON production_runs (fee_document_id)');
    $m->exec('CREATE INDEX production_runs_shortage_idx ON production_runs (shortage_document_id)');
    $m->exec('ALTER TABLE coating_runs ADD CONSTRAINT coating_runs_fee_fk FOREIGN KEY (fee_document_id) REFERENCES documents(id)');
    $m->exec('CREATE INDEX coating_runs_fee_idx ON coating_runs (fee_document_id)');
    $m->exec('ALTER TABLE transfers ADD CONSTRAINT transfers_purchase_fk FOREIGN KEY (purchase_document_id) REFERENCES documents(id)');
    $m->exec('ALTER TABLE transfers ADD CONSTRAINT transfers_freight_fk FOREIGN KEY (freight_document_id) REFERENCES documents(id)');
    $m->exec('CREATE INDEX transfers_purchase_idx ON transfers (purchase_document_id)');
    $m->exec('CREATE INDEX transfers_freight_idx ON transfers (freight_document_id)');
    $m->exec('ALTER TABLE die_orders ADD CONSTRAINT die_orders_purchase_fk FOREIGN KEY (purchase_document_id) REFERENCES documents(id)');
    $m->exec('CREATE INDEX die_orders_purchase_idx ON die_orders (purchase_document_id)');

    $m->table('document_lines', $B('document_lines') . ",
  document_id {$U} NOT NULL, order_line_id {$U} NULL,
  description TEXT NOT NULL, qty DECIMAL(12,3) NULL CHECK (qty >= 0), unit TEXT NULL, unit_price DECIMAL(18,2) NULL CHECK (unit_price >= 0),
  amount DECIMAL(18,2) NOT NULL CHECK (amount >= 0), vat_rate DECIMAL(5,2) NULL, vat_amount DECIMAL(18,2) NULL, sort INT NOT NULL DEFAULT 0, meta LONGTEXT NULL,
  KEY document_lines_doc_idx (document_id, sort),
  KEY document_lines_order_line_idx (order_line_id),
  " . $fk('document_lines', 'document_id', 'documents', 'CASCADE') . ',
  ' . $fk('document_lines', 'order_line_id', 'order_lines'));

    $m->table('allocations', $B('allocations') . ",
  from_document_id {$U} NOT NULL, to_document_id {$U} NULL, order_id {$U} NULL,
  amount DECIMAL(18,2) NOT NULL CHECK (amount > 0), currency VARCHAR(8) NOT NULL {$CUR},
  amount_in_target_currency DECIMAL(18,2) NULL CHECK (amount_in_target_currency > 0), target_currency VARCHAR(8) NULL CHECK (target_currency IN ('TOMAN','USD','IQD')),
  fx_rate_id {$U} NULL, weight_kg DECIMAL(12,3) NULL,
  CONSTRAINT allocations_one_target CHECK ((to_document_id IS NOT NULL) <> (order_id IS NOT NULL)),
  KEY allocations_from_idx (from_document_id),
  KEY allocations_to_idx (to_document_id),
  KEY allocations_order_idx (order_id),
  KEY allocations_fx_idx (fx_rate_id),
  " . $fk('allocations', 'from_document_id', 'documents') . ',
  ' . $fk('allocations', 'to_document_id', 'documents') . ',
  ' . $fk('allocations', 'order_id', 'orders') . ',
  ' . $fk('allocations', 'fx_rate_id', 'fx_rates'));
    // Database-enforced where triggers are allowed: allocations from a document never exceed its amount.
    // (The money module must check the same in PHP, under SELECT … FOR UPDATE of the document.)
    $m->optional("CREATE TRIGGER allocations_total_insert BEFORE INSERT ON allocations FOR EACH ROW BEGIN
        DECLARE total DECIMAL(30,2); DECLARE doc_amount DECIMAL(18,2);
        SELECT amount INTO doc_amount FROM documents WHERE id = NEW.from_document_id FOR UPDATE;
        SELECT COALESCE(SUM(amount), 0) + NEW.amount INTO total FROM allocations WHERE from_document_id = NEW.from_document_id;
        IF doc_amount IS NULL OR total > doc_amount THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'over_allocation'; END IF;
      END", 'allocation total trigger (insert)');
    $m->optional("CREATE TRIGGER allocations_total_update BEFORE UPDATE ON allocations FOR EACH ROW BEGIN
        DECLARE total DECIMAL(30,2); DECLARE doc_amount DECIMAL(18,2);
        SELECT amount INTO doc_amount FROM documents WHERE id = NEW.from_document_id FOR UPDATE;
        SELECT COALESCE(SUM(amount), 0) + NEW.amount INTO total FROM allocations WHERE from_document_id = NEW.from_document_id AND id <> OLD.id;
        IF doc_amount IS NULL OR total > doc_amount THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'over_allocation'; END IF;
      END", 'allocation total trigger (update)');

    $m->table('expense_shares', $B('expense_shares') . ",
  document_id {$U} NOT NULL, order_id {$U} NOT NULL,
  amount DECIMAL(18,2) NOT NULL CHECK (amount >= 0), currency VARCHAR(8) NOT NULL {$CUR}, weight_kg DECIMAL(12,3) NULL, manual TINYINT(1) NOT NULL DEFAULT 0,
  CONSTRAINT expense_shares_document_id_order_id_key UNIQUE (document_id, order_id),
  KEY expense_shares_order_idx (order_id),
  " . $fk('expense_shares', 'document_id', 'documents', 'CASCADE') . ',
  ' . $fk('expense_shares', 'order_id', 'orders'));

    $m->table('opening_weights', $B('opening_weights') . ",
  item_type VARCHAR(16) NOT NULL CHECK (item_type IN ('material_lot','bundle')), item_id {$U} NOT NULL, location_id {$U} NOT NULL,
  kg DECIMAL(12,3) NOT NULL CHECK (kg >= 0), unit_cost DECIMAL(18,2) NULL, currency VARCHAR(8) NULL {$CUR}, as_of DATE NOT NULL, reason TEXT NULL, file_id {$U} NULL,
  locked TINYINT(1) NOT NULL DEFAULT 1,
  KEY opening_weights_location_idx (location_id),
  KEY opening_weights_file_idx (file_id),
  " . $fk('opening_weights', 'location_id', 'locations') . ',
  ' . $fk('opening_weights', 'file_id', 'files'));

    $m->table('correction_requests', $E('correction_requests') . ",
  entity VARCHAR(64) NOT NULL, entity_id {$U} NOT NULL, reason TEXT NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','rejected')), resolved_by {$U} NULL, resolved_at {$TS}, resolution TEXT NULL,
  KEY correction_requests_entity_idx (entity, entity_id),
  KEY correction_requests_status_idx (status),
  " . $fk('correction_requests', 'resolved_by', 'users'));

    // 7.7 daily work
    $m->table('free_notes', $E('free_notes') . ",
  `text` TEXT NOT NULL, occurred_at {$TS},
  topic VARCHAR(24) NULL CHECK (topic IN ('paint_purchase','tool_purchase','bill_payment','freight_cost','misc_delivery','damage','other')),
  amount DECIMAL(18,2) NULL CHECK (amount >= 0), currency VARCHAR(8) NULL {$CUR}, party_id {$U} NULL, order_id {$U} NULL,
  location_id {$U} NULL, qty DECIMAL(12,3) NULL, kg DECIMAL(12,3) NULL, `sensitive` TINYINT(1) NOT NULL DEFAULT 0,
  status VARCHAR(16) NOT NULL DEFAULT 'new' CHECK (status IN ('new','needs_info','reviewed','converted','rejected')),
  review_note TEXT NULL, reviewed_by {$U} NULL, reviewed_at {$TS},
  converted_document_ids LONGTEXT NOT NULL, converted_transfer_id {$U} NULL, conversion_request_id {$U} NULL, telegram_message_id VARCHAR(64) NULL,
  KEY free_notes_status_idx (status, created_at),
  KEY free_notes_party_idx (party_id),
  KEY free_notes_order_idx (order_id),
  KEY free_notes_location_idx (location_id),
  KEY free_notes_created_by_idx (created_by),
  KEY free_notes_transfer_idx (converted_transfer_id),
  " . $fk('free_notes', 'party_id', 'parties') . ',
  ' . $fk('free_notes', 'order_id', 'orders') . ',
  ' . $fk('free_notes', 'location_id', 'locations') . ',
  ' . $fk('free_notes', 'reviewed_by', 'users') . ',
  ' . $fk('free_notes', 'converted_transfer_id', 'transfers'));

    $m->table('tasks', $E('tasks') . ",
  title TEXT NOT NULL, description TEXT NULL, assignee_user_id {$U} NOT NULL, due_at {$TS},
  voice_file_id {$U} NULL, order_id {$U} NULL, transfer_id {$U} NULL, party_id {$U} NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','cancelled')), done_at {$TS}, done_note TEXT NULL, done_file_id {$U} NULL,
  KEY tasks_assignee_idx (assignee_user_id, status),
  KEY tasks_order_idx (order_id),
  KEY tasks_transfer_idx (transfer_id),
  KEY tasks_party_idx (party_id),
  KEY tasks_voice_idx (voice_file_id),
  KEY tasks_done_file_idx (done_file_id),
  KEY tasks_due_idx (due_at),
  " . $fk('tasks', 'assignee_user_id', 'users') . ',
  ' . $fk('tasks', 'voice_file_id', 'files') . ',
  ' . $fk('tasks', 'order_id', 'orders') . ',
  ' . $fk('tasks', 'transfer_id', 'transfers') . ',
  ' . $fk('tasks', 'party_id', 'parties') . ',
  ' . $fk('tasks', 'done_file_id', 'files'));

    $m->table('task_comments', $B('task_comments') . ",
  task_id {$U} NOT NULL, user_id {$U} NOT NULL, `text` TEXT NULL, file_id {$U} NULL,
  KEY task_comments_task_idx (task_id),
  KEY task_comments_file_idx (file_id),
  " . $fk('task_comments', 'task_id', 'tasks', 'CASCADE') . ',
  ' . $fk('task_comments', 'user_id', 'users') . ',
  ' . $fk('task_comments', 'file_id', 'files'));

    $m->table('share_links', $B('share_links') . ",
  token_hash VARCHAR(128) NOT NULL, scope_type VARCHAR(24) NOT NULL CHECK (scope_type IN ('daily_report','document','bundle_gallery')),
  scope_id {$U} NULL, scope_date DATE NULL, expires_at DATETIME(3) NOT NULL, revoked TINYINT(1) NOT NULL DEFAULT 0, open_count INT NOT NULL DEFAULT 0, last_opened_at {$TS},
  CONSTRAINT share_links_token_hash_key UNIQUE (token_hash),
  CONSTRAINT share_links_scope CHECK ((scope_id IS NOT NULL) OR (scope_date IS NOT NULL)),
  KEY share_links_scope_idx (scope_type, scope_id, scope_date)");

    $m->table('notifications', $B('notifications') . ",
  user_id {$U} NOT NULL, kind VARCHAR(64) NOT NULL, title TEXT NOT NULL, entity VARCHAR(64) NULL, entity_id {$U} NULL,
  read_at {$TS}, group_key VARCHAR(150) NULL, telegram_sent_at {$TS},
  _g_open_user {$U} GENERATED ALWAYS AS (IF(read_at IS NULL AND group_key IS NOT NULL, user_id, NULL)) STORED,
  KEY notifications_user_idx (user_id, read_at, created_at),
  UNIQUE KEY notifications_group_open (_g_open_user, group_key),
  " . $fk('notifications', 'user_id', 'users'));

    $m->table('daily_reports', $B('daily_reports') . ",
  `date` DATE NOT NULL, generated_at {$NOW}, snapshot LONGTEXT NOT NULL, sent_to_telegram_at {$TS},
  CONSTRAINT daily_reports_date_key UNIQUE (`date`)");

    $m->table('telegram_link_codes', $B('telegram_link_codes') . ",
  user_id {$U} NOT NULL, code_hash VARCHAR(128) NOT NULL, expires_at DATETIME(3) NOT NULL, used_at {$TS},
  CONSTRAINT telegram_link_codes_code_hash_key UNIQUE (code_hash),
  KEY telegram_link_codes_user_idx (user_id),
  " . $fk('telegram_link_codes', 'user_id', 'users'));

    $m->table('bot_log', $B('bot_log') . ',
  chat_id VARCHAR(64) NULL, kind VARCHAR(64) NOT NULL, detail TEXT NULL,
  KEY bot_log_created_idx (created_at)');

    $m->table('import_batches', $E('import_batches') . ",
  kind VARCHAR(32) NOT NULL, status VARCHAR(16) NOT NULL DEFAULT 'preview' CHECK (status IN ('preview','committed','reverted')), `rows` LONGTEXT NOT NULL, errors LONGTEXT NOT NULL,
  created_ids LONGTEXT NOT NULL, trial TINYINT(1) NOT NULL DEFAULT 0, file_id {$U} NULL, note TEXT NULL,
  KEY import_batches_file_idx (file_id),
  " . $fk('import_batches', 'file_id', 'files'));

    // Document-policy defaults (module 6) and more settings.
    $m->seedSetting('transfer_document_policy', ['to_customer' => ['load_photo', 'scale_ticket'], 'ingot_in' => ['load_photo', 'scale_ticket']]);
    $m->seedSetting('anodize_gain_range_percent', null);
    $m->seedSetting('default_anodize_rate_per_kg', null);
    $m->exec("UPDATE settings SET value = ? WHERE `key` = 'numbering_patterns' AND value = '{}'", ['{"wholesale_proforma":"V{yymmdd}-{seq}"}']);
};
