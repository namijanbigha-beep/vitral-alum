import { sql, type Kysely } from 'kysely';

/**
 * Sections 7.2–7.7: parties, contracts, products, dies, sales, weight ledger, money, daily work.
 * Reversible: `down` drops everything in reverse dependency order.
 */
const BASE = `
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id)`;
const EDITABLE = `${BASE},
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1`;

const CUR = `CHECK (currency IN ('TOMAN','USD','IQD'))`;

export async function up(db: Kysely<unknown>): Promise<void> {
  const run = (s: string) => sql.raw(s).execute(db);

  // 7.2 parties, locations, contracts
  await run(`CREATE TABLE parties (${EDITABLE},
    name text NOT NULL, name_ar text, name_en text,
    phones text[] NOT NULL DEFAULT '{}', country text, city text, address text, national_id text,
    roles text[] NOT NULL DEFAULT '{}' CHECK (roles <@ ARRAY['customer','factory','painter','anodizer','ingot_supplier','scrap_trader','smelter','die_maker','carrier','tool_supplier','other']::text[]),
    default_currency text NOT NULL DEFAULT 'TOMAN' CHECK (default_currency IN ('TOMAN','USD','IQD')),
    note text, active boolean NOT NULL DEFAULT true,
    merged_into_id uuid REFERENCES parties(id))`);
  await run(`CREATE INDEX parties_name_idx ON parties (lower(name))`);
  await run(`CREATE INDEX parties_roles_idx ON parties USING gin (roles)`);
  await run(`CREATE INDEX parties_phones_idx ON parties USING gin (phones)`);
  await run(`CREATE INDEX parties_created_by_idx ON parties (created_by)`);

  await run(`CREATE TABLE locations (${EDITABLE},
    name text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('own_warehouse','factory','painter','in_transit','customer','border')),
    party_id uuid REFERENCES parties(id), active boolean NOT NULL DEFAULT true)`);
  await run(`CREATE INDEX locations_party_id_idx ON locations (party_id)`);
  await run(`CREATE UNIQUE INDEX locations_in_transit_single ON locations (kind) WHERE kind = 'in_transit'`);
  await run(`INSERT INTO locations (name, kind) VALUES ('انبار ویترال', 'own_warehouse'), ('در مسیر', 'in_transit')`);

  await run(`CREATE TABLE contracts (${EDITABLE},
    party_id uuid NOT NULL REFERENCES parties(id),
    service text NOT NULL CHECK (service IN ('extrusion','paint','anodize','smelting','die_making','transport')),
    rate_per_kg numeric(18,2) CHECK (rate_per_kg >= 0), currency text NOT NULL DEFAULT 'TOMAN' ${CUR},
    weight_basis text CHECK (weight_basis IN ('input','good_output')),
    fixed_fee numeric(18,2) CHECK (fixed_fee >= 0),
    scrap_owner text CHECK (scrap_owner IN ('vitral','factory')),
    scrap_credit_rate numeric(18,2) CHECK (scrap_credit_rate >= 0),
    includes_material boolean,
    freight_payer text CHECK (freight_payer IN ('vitral','party')),
    rework_payer text CHECK (rework_payer IN ('vitral','party')),
    allowed_loss_percent numeric(5,2) CHECK (allowed_loss_percent >= 0 AND allowed_loss_percent <= 100),
    valid_from date NOT NULL, valid_to date, note text,
    CHECK (valid_to IS NULL OR valid_to >= valid_from))`);
  await run(`CREATE INDEX contracts_party_service_idx ON contracts (party_id, service, valid_from)`);

  // 7.3 products, fillers, dies, die events, die orders
  await run(`CREATE TABLE products (${EDITABLE},
    code text NOT NULL UNIQUE, name_fa text NOT NULL, name_ar text, name_en text,
    category text CHECK (category IN ('light_line','facade','door_window','general','misc')),
    alloy text, section_area_mm2 numeric(10,2) CHECK (section_area_mm2 > 0),
    weight_g_per_m_no_filler numeric(8,1) CHECK (weight_g_per_m_no_filler > 0),
    common_lengths numeric(5,2)[] NOT NULL DEFAULT '{}', colors text[] NOT NULL DEFAULT '{}',
    drawing_version text, description text, main_file_id uuid REFERENCES files(id),
    active boolean NOT NULL DEFAULT true)`);
  await run(`CREATE INDEX products_name_idx ON products (lower(name_fa))`);
  await run(`CREATE INDEX products_main_file_id_idx ON products (main_file_id)`);

  await run(`CREATE TABLE product_fillers (${EDITABLE},
    product_id uuid NOT NULL REFERENCES products(id),
    filler_mm numeric(4,2) CHECK (filler_mm > 0),
    weight_g_per_m numeric(8,1) NOT NULL CHECK (weight_g_per_m > 0),
    source text NOT NULL CHECK (source IN ('drawing','sample','formula','agreed')),
    sample_length_m numeric(5,2) CHECK (sample_length_m > 0), sample_weight_kg numeric(12,3) CHECK (sample_weight_kg > 0),
    status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','approved')),
    approved_by uuid REFERENCES users(id), approved_at timestamptz, note text)`);
  await run(`CREATE INDEX product_fillers_product_id_idx ON product_fillers (product_id)`);
  await run(`CREATE UNIQUE INDEX product_fillers_one_approved ON product_fillers (product_id, COALESCE(filler_mm, -1)) WHERE status = 'approved'`);

  await run(`CREATE TABLE dies (${EDITABLE},
    code text NOT NULL UNIQUE, name text, product_id uuid REFERENCES products(id),
    owner_party_id uuid REFERENCES parties(id), location_id uuid REFERENCES locations(id),
    compatible_press text, maker_party_id uuid REFERENCES parties(id),
    status text NOT NULL DEFAULT 'ready' CHECK (status IN ('design','making','ready','needs_repair','retired','in_transit')),
    total_produced_kg numeric(14,3) NOT NULL DEFAULT 0 CHECK (total_produced_kg >= 0),
    run_count integer NOT NULL DEFAULT 0 CHECK (run_count >= 0), last_run_at timestamptz, note text)`);
  await run(`CREATE INDEX dies_product_id_idx ON dies (product_id)`);
  await run(`CREATE INDEX dies_location_id_idx ON dies (location_id)`);
  await run(`CREATE INDEX dies_owner_party_id_idx ON dies (owner_party_id)`);
  await run(`CREATE INDEX dies_maker_party_id_idx ON dies (maker_party_id)`);

  await run(`CREATE TABLE die_events (${BASE},
    die_id uuid NOT NULL REFERENCES dies(id),
    kind text NOT NULL CHECK (kind IN ('moved','repair','filler_check','damage','note')),
    at timestamptz NOT NULL DEFAULT now(), detail text,
    measured_filler_mm numeric(4,2) CHECK (measured_filler_mm > 0),
    production_run_id uuid, bundle_id uuid)`);
  await run(`CREATE INDEX die_events_die_id_idx ON die_events (die_id, at)`);

  await run(`CREATE TABLE die_orders (${EDITABLE},
    number text NOT NULL UNIQUE, customer_party_id uuid REFERENCES parties(id),
    maker_party_id uuid REFERENCES parties(id), die_id uuid REFERENCES dies(id), order_line_id uuid,
    step text NOT NULL DEFAULT 'drawing_received' CHECK (step IN ('drawing_received','quoted','ordered','delivered','trial_run','registered')),
    maker_cost numeric(18,2) CHECK (maker_cost >= 0), currency text NOT NULL DEFAULT 'TOMAN' ${CUR},
    due_date date, steps jsonb NOT NULL DEFAULT '[]', purchase_document_id uuid, note text)`);
  await run(`CREATE INDEX die_orders_customer_idx ON die_orders (customer_party_id)`);
  await run(`CREATE INDEX die_orders_maker_idx ON die_orders (maker_party_id)`);
  await run(`CREATE INDEX die_orders_die_id_idx ON die_orders (die_id)`);

  // 7.4 sales
  await run(`CREATE TABLE orders (${EDITABLE},
    number text NOT NULL UNIQUE, title text, party_id uuid NOT NULL REFERENCES parties(id),
    currency text NOT NULL DEFAULT 'TOMAN' ${CUR},
    settlement_basis text NOT NULL DEFAULT 'final_net_scale' CHECK (settlement_basis IN ('final_net_scale','agreed_weight')),
    prepay_percent numeric(5,2) CHECK (prepay_percent >= 0 AND prepay_percent <= 100), prepay_amount numeric(18,2) CHECK (prepay_amount >= 0),
    payment_terms text NOT NULL DEFAULT 'cash' CHECK (payment_terms IN ('cash','credit')),
    valid_until date, validity_text text, delivery_days integer CHECK (delivery_days >= 0), due_date date,
    destination_country text, destination_city text, destination_address text,
    owner_user_id uuid REFERENCES users(id),
    status_sales text NOT NULL DEFAULT 'draft' CHECK (status_sales IN ('draft','proforma','approved','cancelled')),
    revision integer NOT NULL DEFAULT 0, approved_by uuid REFERENCES users(id), approved_at timestamptz,
    invoice_notes text, internal_note text, archived boolean NOT NULL DEFAULT false,
    order_date date NOT NULL DEFAULT CURRENT_DATE, print_count integer NOT NULL DEFAULT 0,
    cost_confirmed_by uuid REFERENCES users(id), cost_confirmed_at timestamptz, cancel_reason text)`);
  await run(`CREATE INDEX orders_party_id_idx ON orders (party_id)`);
  await run(`CREATE INDEX orders_owner_idx ON orders (owner_user_id)`);
  await run(`CREATE INDEX orders_status_idx ON orders (status_sales, archived)`);
  await run(`CREATE INDEX orders_due_date_idx ON orders (due_date)`);
  await run(`CREATE INDEX orders_date_idx ON orders (order_date)`);

  await run(`CREATE TABLE order_lines (${EDITABLE},
    order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE, sort integer NOT NULL DEFAULT 0,
    kind text NOT NULL CHECK (kind IN ('profile','material','die_making','service')),
    product_id uuid REFERENCES products(id), product_filler_id uuid REFERENCES product_fillers(id),
    filler_mm numeric(4,2), length_m numeric(5,2) CHECK (length_m > 0), min_length_m numeric(5,2) CHECK (min_length_m > 0),
    color text, load_type_label text, weight_g_per_m numeric(8,1) CHECK (weight_g_per_m > 0), weight_unapproved boolean NOT NULL DEFAULT false,
    calc_mode text NOT NULL DEFAULT 'manual' CHECK (calc_mode IN ('from_bars','from_weight','manual')),
    qty_bars numeric(10,1) CHECK (qty_bars >= 0), qty_kg numeric(12,3) CHECK (qty_kg >= 0), qty_is_estimate boolean NOT NULL DEFAULT false,
    qty_pieces integer CHECK (qty_pieces >= 0),
    price_basis text NOT NULL DEFAULT 'per_kg' CHECK (price_basis IN ('per_kg','per_bar','per_meter','per_piece')),
    unit_price numeric(18,2) CHECK (unit_price >= 0), currency text NOT NULL DEFAULT 'TOMAN' ${CUR},
    discount_amount numeric(18,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
    discount_percent numeric(5,2) NOT NULL DEFAULT 0 CHECK (discount_percent >= 0 AND discount_percent <= 100),
    supply_method text CHECK (supply_method IN ('toll_production','stock','buy_raw_then_paint','buy_finished')),
    die_id uuid REFERENCES dies(id), material_kind text CHECK (material_kind IN ('ingot','billet','scrap','paint_powder','tool')),
    coating_gain_estimate_percent numeric(5,2),
    vat_rate numeric(5,2), vat_amount numeric(18,2), name_ar text, name_en text, description text,
    file_id uuid REFERENCES files(id), note text)`);
  await run(`CREATE INDEX order_lines_order_id_idx ON order_lines (order_id, sort)`);
  await run(`CREATE INDEX order_lines_product_id_idx ON order_lines (product_id)`);
  await run(`CREATE INDEX order_lines_die_id_idx ON order_lines (die_id)`);
  await run(`CREATE INDEX order_lines_filler_idx ON order_lines (product_filler_id)`);
  await run(`CREATE INDEX order_lines_file_idx ON order_lines (file_id)`);
  await run(`ALTER TABLE die_orders ADD CONSTRAINT die_orders_order_line_fk FOREIGN KEY (order_line_id) REFERENCES order_lines(id)`);
  await run(`CREATE INDEX die_orders_order_line_idx ON die_orders (order_line_id)`);

  await run(`CREATE TABLE order_revisions (${BASE},
    order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE, revision integer NOT NULL,
    snapshot jsonb NOT NULL, reason text, UNIQUE (order_id, revision))`);

  // 7.5 weight and operations
  await run(`CREATE TABLE material_lots (${EDITABLE},
    kind text NOT NULL CHECK (kind IN ('ingot','billet','scrap','paint_powder','tool')),
    alloy text, grade text, batch_no text, owner_party_id uuid REFERENCES parties(id),
    unit text NOT NULL DEFAULT 'kg' CHECK (unit IN ('kg','carton','piece')),
    kg_per_unit numeric(12,3) CHECK (kg_per_unit > 0), description text,
    tool_class text CHECK (tool_class IN ('consumable','equipment')), responsible_user_id uuid REFERENCES users(id))`);
  await run(`CREATE INDEX material_lots_kind_idx ON material_lots (kind, alloy, owner_party_id)`);
  await run(`CREATE INDEX material_lots_owner_idx ON material_lots (owner_party_id)`);

  await run(`CREATE TABLE production_runs (${EDITABLE},
    number text NOT NULL UNIQUE, factory_party_id uuid NOT NULL REFERENCES parties(id), location_id uuid NOT NULL REFERENCES locations(id),
    service text NOT NULL DEFAULT 'extrusion' CHECK (service IN ('extrusion','smelting')),
    started_at timestamptz NOT NULL DEFAULT now(), due_at timestamptz, contract_id uuid REFERENCES contracts(id),
    rate_per_kg numeric(18,2) CHECK (rate_per_kg >= 0), rate_currency text NOT NULL DEFAULT 'TOMAN' CHECK (rate_currency IN ('TOMAN','USD','IQD')),
    weight_basis text CHECK (weight_basis IN ('input','good_output')), fixed_fee numeric(18,2) CHECK (fixed_fee >= 0),
    scrap_owner text CHECK (scrap_owner IN ('vitral','factory')), scrap_credit_rate numeric(18,2),
    status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
    ingot_allocated_kg numeric(12,3) NOT NULL DEFAULT 0 CHECK (ingot_allocated_kg >= 0),
    ingot_consumed_kg numeric(12,3) CHECK (ingot_consumed_kg >= 0),
    good_kg numeric(12,3) NOT NULL DEFAULT 0, rejected_kg numeric(12,3) NOT NULL DEFAULT 0,
    scrap_kg numeric(12,3) NOT NULL DEFAULT 0 CHECK (scrap_kg >= 0), returned_material_kg numeric(12,3) NOT NULL DEFAULT 0 CHECK (returned_material_kg >= 0),
    unexplained_kg numeric(12,3), close_reason text, closed_by uuid REFERENCES users(id), closed_at timestamptz,
    press text, shift text, heat_treatment text, note text, fee_document_id uuid, shortage_document_id uuid)`);
  await run(`CREATE INDEX production_runs_factory_idx ON production_runs (factory_party_id, status)`);
  await run(`CREATE INDEX production_runs_location_idx ON production_runs (location_id)`);
  await run(`CREATE INDEX production_runs_contract_idx ON production_runs (contract_id)`);
  await run(`CREATE INDEX production_runs_started_idx ON production_runs (started_at)`);

  await run(`CREATE TABLE production_run_lines (${BASE},
    run_id uuid NOT NULL REFERENCES production_runs(id) ON DELETE CASCADE, order_line_id uuid REFERENCES order_lines(id),
    product_id uuid NOT NULL REFERENCES products(id), die_id uuid REFERENCES dies(id),
    filler_mm numeric(4,2), length_m numeric(5,2), target_kg numeric(12,3) CHECK (target_kg >= 0), target_bars integer CHECK (target_bars >= 0))`);
  await run(`CREATE INDEX production_run_lines_run_idx ON production_run_lines (run_id)`);
  await run(`CREATE INDEX production_run_lines_order_line_idx ON production_run_lines (order_line_id)`);
  await run(`CREATE INDEX production_run_lines_product_idx ON production_run_lines (product_id)`);
  await run(`CREATE INDEX production_run_lines_die_idx ON production_run_lines (die_id)`);

  await run(`CREATE TABLE bundles (${EDITABLE},
    code text NOT NULL, code_is_temp boolean NOT NULL DEFAULT false,
    production_run_id uuid REFERENCES production_runs(id), factory_party_id uuid REFERENCES parties(id),
    source text NOT NULL DEFAULT 'production' CHECK (source IN ('production','purchase','opening','return')),
    weight_kg numeric(12,3) NOT NULL CHECK (weight_kg >= 0), packaging_kg numeric(12,3) CHECK (packaging_kg >= 0),
    location_id uuid NOT NULL REFERENCES locations(id),
    form text NOT NULL DEFAULT 'raw' CHECK (form IN ('raw','painted','anodized')), color text,
    status text NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','damaged','wrong_product','pending_review','scrapped','consumed')),
    qc_note text, defect text, decision text CHECK (decision IN ('accept','rework','discount_sale','scrap')),
    decided_by uuid REFERENCES users(id), decided_at timestamptz, decision_note text,
    reserved_order_line_id uuid REFERENCES order_lines(id),
    raw_weight_kg numeric(12,3) CHECK (raw_weight_kg >= 0), measured_filler_mm numeric(4,2), measured_length_m numeric(5,2),
    reported_at timestamptz NOT NULL DEFAULT now(), draft boolean NOT NULL DEFAULT false,
    warnings jsonb NOT NULL DEFAULT '[]', origin_bundle_ids uuid[] NOT NULL DEFAULT '{}', note text)`);
  await run(`CREATE UNIQUE INDEX bundles_factory_code_key ON bundles (factory_party_id, code) WHERE code_is_temp = false AND factory_party_id IS NOT NULL`);
  await run(`CREATE INDEX bundles_run_idx ON bundles (production_run_id)`);
  await run(`CREATE INDEX bundles_location_idx ON bundles (location_id, status, form)`);
  await run(`CREATE INDEX bundles_reserved_idx ON bundles (reserved_order_line_id)`);
  await run(`CREATE INDEX bundles_reported_idx ON bundles (reported_at)`);
  await run(`CREATE INDEX bundles_code_idx ON bundles (code)`);
  await run(`CREATE INDEX bundles_factory_idx ON bundles (factory_party_id)`);

  await run(`CREATE TABLE bundle_lines (${BASE},
    bundle_id uuid NOT NULL REFERENCES bundles(id) ON DELETE CASCADE, product_id uuid NOT NULL REFERENCES products(id),
    filler_mm numeric(4,2), length_m numeric(5,2) CHECK (length_m > 0), bars integer CHECK (bars >= 0),
    weight_kg numeric(12,3) CHECK (weight_kg >= 0), order_line_id uuid REFERENCES order_lines(id), sort integer NOT NULL DEFAULT 0)`);
  await run(`CREATE INDEX bundle_lines_bundle_idx ON bundle_lines (bundle_id)`);
  await run(`CREATE INDEX bundle_lines_product_idx ON bundle_lines (product_id)`);
  await run(`CREATE INDEX bundle_lines_order_line_idx ON bundle_lines (order_line_id)`);
  await run(`ALTER TABLE die_events ADD CONSTRAINT die_events_run_fk FOREIGN KEY (production_run_id) REFERENCES production_runs(id)`);
  await run(`ALTER TABLE die_events ADD CONSTRAINT die_events_bundle_fk FOREIGN KEY (bundle_id) REFERENCES bundles(id)`);
  await run(`CREATE INDEX die_events_run_idx ON die_events (production_run_id)`);
  await run(`CREATE INDEX die_events_bundle_idx ON die_events (bundle_id)`);

  await run(`CREATE TABLE reservations (${EDITABLE},
    order_line_id uuid NOT NULL REFERENCES order_lines(id), bundle_id uuid REFERENCES bundles(id), material_lot_id uuid REFERENCES material_lots(id),
    kg numeric(12,3) NOT NULL CHECK (kg > 0),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','consumed','released')),
    CHECK ((bundle_id IS NOT NULL) <> (material_lot_id IS NOT NULL)))`);
  await run(`CREATE INDEX reservations_line_idx ON reservations (order_line_id, status)`);
  await run(`CREATE INDEX reservations_bundle_idx ON reservations (bundle_id, status)`);
  await run(`CREATE INDEX reservations_lot_idx ON reservations (material_lot_id, status)`);

  await run(`CREATE TABLE coating_runs (${EDITABLE},
    number text NOT NULL UNIQUE, party_id uuid NOT NULL REFERENCES parties(id),
    service text NOT NULL CHECK (service IN ('paint','anodize')), color_code text, contract_id uuid REFERENCES contracts(id),
    rate_per_kg numeric(18,2) CHECK (rate_per_kg >= 0), rate_currency text NOT NULL DEFAULT 'TOMAN' CHECK (rate_currency IN ('TOMAN','USD','IQD')),
    includes_material boolean, sent_at timestamptz NOT NULL DEFAULT now(), due_at timestamptz,
    input_basis text NOT NULL DEFAULT 'bundle_sum' CHECK (input_basis IN ('bundle_sum','scale_ticket','agreed')),
    input_basis_kg numeric(12,3) CHECK (input_basis_kg >= 0), basis_reason text,
    status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','partially_returned','returned','closed')),
    transfer_id uuid, fee_document_id uuid, material_lot_id uuid REFERENCES material_lots(id), material_units numeric(12,3), note text,
    closed_by uuid REFERENCES users(id), closed_at timestamptz)`);
  await run(`CREATE INDEX coating_runs_party_idx ON coating_runs (party_id, status)`);
  await run(`CREATE INDEX coating_runs_contract_idx ON coating_runs (contract_id)`);
  await run(`CREATE INDEX coating_runs_sent_idx ON coating_runs (sent_at)`);

  await run(`CREATE TABLE coating_run_items (${EDITABLE},
    run_id uuid NOT NULL REFERENCES coating_runs(id) ON DELETE CASCADE, bundle_id uuid NOT NULL REFERENCES bundles(id),
    raw_kg numeric(12,3) NOT NULL CHECK (raw_kg >= 0), coated_kg numeric(12,3) CHECK (coated_kg >= 0), returned_at timestamptz,
    qc text CHECK (qc IN ('ok','needs_review','rejected')), bars_returned integer CHECK (bars_returned >= 0),
    gain_needs_review boolean NOT NULL DEFAULT false, note text, UNIQUE (run_id, bundle_id))`);
  await run(`CREATE INDEX coating_run_items_bundle_idx ON coating_run_items (bundle_id)`);

  await run(`CREATE TABLE transfers (${EDITABLE},
    number text NOT NULL UNIQUE,
    kind text NOT NULL CHECK (kind IN ('ingot_in','to_production','raw_delivery','to_coating','from_coating','between_locations','to_customer','customer_return','scrap_out','scrap_in','die_move','general')),
    from_location_id uuid REFERENCES locations(id), to_location_id uuid REFERENCES locations(id),
    carrier_party_id uuid REFERENCES parties(id), vehicle_type text, plate text, driver_name text, driver_phone text, waybill_no text,
    departed_at timestamptz, eta timestamptz, received_at timestamptz, receiver_name text,
    status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','dispatched','in_transit','at_border','partially_received','received','delivered')),
    freight_cost numeric(18,2) CHECK (freight_cost >= 0), freight_currency text NOT NULL DEFAULT 'TOMAN' CHECK (freight_currency IN ('TOMAN','USD','IQD')),
    freight_payer text CHECK (freight_payer IN ('vitral','customer','party')), delivery_term text,
    destination_country text, destination_city text, destination_address text, consignee text, bill_to_party_id uuid REFERENCES parties(id),
    is_export boolean NOT NULL DEFAULT false, border text, transport_mode text,
    order_ids uuid[] NOT NULL DEFAULT '{}', production_run_id uuid REFERENCES production_runs(id), coating_run_id uuid REFERENCES coating_runs(id),
    purchase_document_id uuid, returns_transfer_id uuid REFERENCES transfers(id), freight_document_id uuid,
    dispatched_by uuid REFERENCES users(id), note text, print_count integer NOT NULL DEFAULT 0)`);
  await run(`CREATE INDEX transfers_from_idx ON transfers (from_location_id)`);
  await run(`CREATE INDEX transfers_to_idx ON transfers (to_location_id)`);
  await run(`CREATE INDEX transfers_carrier_idx ON transfers (carrier_party_id)`);
  await run(`CREATE INDEX transfers_status_idx ON transfers (status, kind)`);
  await run(`CREATE INDEX transfers_orders_idx ON transfers USING gin (order_ids)`);
  await run(`CREATE INDEX transfers_run_idx ON transfers (production_run_id)`);
  await run(`CREATE INDEX transfers_coating_idx ON transfers (coating_run_id)`);
  await run(`CREATE INDEX transfers_departed_idx ON transfers (departed_at)`);
  await run(`CREATE INDEX transfers_plate_idx ON transfers (plate)`);
  await run(`CREATE INDEX transfers_bill_to_idx ON transfers (bill_to_party_id)`);
  await run(`CREATE INDEX transfers_returns_idx ON transfers (returns_transfer_id)`);
  await run(`ALTER TABLE coating_runs ADD CONSTRAINT coating_runs_transfer_fk FOREIGN KEY (transfer_id) REFERENCES transfers(id)`);
  await run(`CREATE INDEX coating_runs_transfer_idx ON coating_runs (transfer_id)`);

  await run(`CREATE TABLE transfer_lines (${EDITABLE},
    transfer_id uuid NOT NULL REFERENCES transfers(id) ON DELETE CASCADE,
    bundle_id uuid REFERENCES bundles(id), material_lot_id uuid REFERENCES material_lots(id), die_id uuid REFERENCES dies(id),
    order_id uuid REFERENCES orders(id), order_line_id uuid REFERENCES order_lines(id),
    kg numeric(12,3) CHECK (kg >= 0), bars integer CHECK (bars >= 0), packages integer CHECK (packages >= 0), bars_per_package integer CHECK (bars_per_package >= 0),
    length_m numeric(5,2), received_kg numeric(12,3) CHECK (received_kg >= 0), received_at timestamptz,
    diff_reason text CHECK (diff_reason IN ('scale_difference','packaging','shortage','partial_unload','other')), diff_note text,
    CHECK (num_nonnulls(bundle_id, material_lot_id, die_id) = 1))`);
  await run(`CREATE INDEX transfer_lines_transfer_idx ON transfer_lines (transfer_id)`);
  await run(`CREATE INDEX transfer_lines_bundle_idx ON transfer_lines (bundle_id)`);
  await run(`CREATE INDEX transfer_lines_lot_idx ON transfer_lines (material_lot_id)`);
  await run(`CREATE INDEX transfer_lines_die_idx ON transfer_lines (die_id)`);
  await run(`CREATE INDEX transfer_lines_order_idx ON transfer_lines (order_id)`);
  await run(`CREATE INDEX transfer_lines_order_line_idx ON transfer_lines (order_line_id)`);

  await run(`CREATE TABLE scale_tickets (${EDITABLE},
    transfer_id uuid REFERENCES transfers(id), coating_run_id uuid REFERENCES coating_runs(id), production_run_id uuid REFERENCES production_runs(id),
    site text, ticket_no text, at timestamptz,
    gross_kg numeric(12,3) CHECK (gross_kg >= 0), tare_kg numeric(12,3) CHECK (tare_kg >= 0), packaging_kg numeric(12,3) CHECK (packaging_kg >= 0), net_direct_kg numeric(12,3) CHECK (net_direct_kg >= 0),
    stage text NOT NULL CHECK (stage IN ('origin','destination','factory_in','factory_out','painter_in','painter_out','border')),
    approved_for text[] NOT NULL DEFAULT '{}' CHECK (approved_for <@ ARRAY['receipt','toll_fee','sale']::text[]),
    approved_by uuid REFERENCES users(id), approved_at timestamptz,
    status text NOT NULL DEFAULT 'needs_completion' CHECK (status IN ('needs_completion','recorded','approved')),
    file_id uuid REFERENCES files(id), note text)`);
  await run(`CREATE INDEX scale_tickets_transfer_idx ON scale_tickets (transfer_id)`);
  await run(`CREATE INDEX scale_tickets_coating_idx ON scale_tickets (coating_run_id)`);
  await run(`CREATE INDEX scale_tickets_run_idx ON scale_tickets (production_run_id)`);
  await run(`CREATE INDEX scale_tickets_file_idx ON scale_tickets (file_id)`);
  await run(`CREATE INDEX scale_tickets_status_idx ON scale_tickets (status)`);

  await run(`CREATE TABLE packing_lines (${EDITABLE},
    transfer_id uuid NOT NULL REFERENCES transfers(id) ON DELETE CASCADE, order_id uuid REFERENCES orders(id), order_line_id uuid REFERENCES order_lines(id),
    product_id uuid REFERENCES products(id), description text, filler_mm numeric(4,2), color text, length_m numeric(5,2),
    packages integer NOT NULL DEFAULT 0 CHECK (packages >= 0), bars_per_package integer CHECK (bars_per_package >= 0), bars integer CHECK (bars >= 0),
    weight_kg numeric(12,3) CHECK (weight_kg >= 0), weight_mode text NOT NULL DEFAULT 'group_total' CHECK (weight_mode IN ('group_total','per_package')),
    is_partial boolean NOT NULL DEFAULT false, gross_kg numeric(12,3) CHECK (gross_kg >= 0), sort integer NOT NULL DEFAULT 0)`);
  await run(`CREATE INDEX packing_lines_transfer_idx ON packing_lines (transfer_id, sort)`);
  await run(`CREATE INDEX packing_lines_order_idx ON packing_lines (order_id)`);
  await run(`CREATE INDEX packing_lines_order_line_idx ON packing_lines (order_line_id)`);
  await run(`CREATE INDEX packing_lines_product_idx ON packing_lines (product_id)`);

  // Weight ledger (principle 8): append-only.
  await run(`CREATE TABLE stock_moves (${BASE},
    at timestamptz NOT NULL DEFAULT now(),
    item_type text NOT NULL CHECK (item_type IN ('material_lot','bundle')), item_id uuid NOT NULL,
    from_location_id uuid REFERENCES locations(id), to_location_id uuid REFERENCES locations(id),
    kg numeric(12,3) NOT NULL CHECK (kg >= 0), state_from text, state_to text,
    ref_type text NOT NULL CHECK (ref_type IN ('purchase_receipt','transfer_dispatch','transfer_receive','production_consume','production_output','coating_send','coating_return','sale_dispatch','customer_return','scrap_conversion','count_adjustment','opening','material_consume','smelting_output')),
    ref_id uuid NOT NULL, unit_cost numeric(18,2), currency text ${CUR}, owner_party_id uuid REFERENCES parties(id), note text,
    CHECK (from_location_id IS NOT NULL OR to_location_id IS NOT NULL))`);
  await run(`CREATE INDEX stock_moves_item_idx ON stock_moves (item_type, item_id, at)`);
  await run(`CREATE INDEX stock_moves_from_idx ON stock_moves (from_location_id, at)`);
  await run(`CREATE INDEX stock_moves_to_idx ON stock_moves (to_location_id, at)`);
  await run(`CREATE INDEX stock_moves_ref_idx ON stock_moves (ref_type, ref_id)`);
  await run(`CREATE INDEX stock_moves_at_idx ON stock_moves (at)`);
  await run(`CREATE INDEX stock_moves_owner_idx ON stock_moves (owner_party_id)`);
  await run(`CREATE TRIGGER stock_moves_no_update BEFORE UPDATE OR DELETE ON stock_moves FOR EACH ROW EXECUTE FUNCTION audit_log_append_only()`);

  // 7.6 money
  await run(`CREATE TABLE accounts (${EDITABLE},
    name text NOT NULL, kind text NOT NULL CHECK (kind IN ('bank','cash')), currency text NOT NULL DEFAULT 'TOMAN' ${CUR}, active boolean NOT NULL DEFAULT true)`);

  await run(`CREATE TABLE fx_rates (${BASE},
    at timestamptz NOT NULL DEFAULT now(), from_currency text NOT NULL CHECK (from_currency IN ('TOMAN','USD','IQD')),
    to_currency text NOT NULL CHECK (to_currency IN ('TOMAN','USD','IQD')), rate numeric(18,6) NOT NULL CHECK (rate > 0),
    source_text text, kind text NOT NULL CHECK (kind IN ('agreed_settlement','report_daily')), CHECK (from_currency <> to_currency))`);
  await run(`CREATE INDEX fx_rates_at_idx ON fx_rates (from_currency, to_currency, at)`);

  await run(`CREATE TABLE documents (${EDITABLE},
    number text NOT NULL UNIQUE,
    kind text NOT NULL CHECK (kind IN ('invoice','sales_return','purchase','toll_fee','expense','receipt','payment','barter','opening_balance','fx_difference')),
    party_id uuid REFERENCES parties(id), amount numeric(18,2) CHECK (amount >= 0), currency text NOT NULL DEFAULT 'TOMAN' ${CUR},
    date date NOT NULL DEFAULT CURRENT_DATE, due_date date,
    method text CHECK (method IN ('cash','card','bank_transfer','exchange_house','cheque','other')), account_id uuid REFERENCES accounts(id), tracking_no text,
    status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','reported','posted','void','needs_completion')),
    reverses_document_id uuid REFERENCES documents(id), reversed_by_document_id uuid REFERENCES documents(id),
    source_type text, source_id uuid, order_id uuid REFERENCES orders(id), transfer_id uuid REFERENCES transfers(id),
    expense_type text CHECK (expense_type IN ('order','shared','general')), expense_category text,
    purchase_kind text CHECK (purchase_kind IN ('ingot','billet','scrap','paint_powder','tool','raw_profile','finished_profile','die','other')),
    material_lot_id uuid REFERENCES material_lots(id), agreed_kg numeric(12,3) CHECK (agreed_kg >= 0), unit_price numeric(18,2) CHECK (unit_price >= 0),
    received_kg numeric(12,3) NOT NULL DEFAULT 0, barter_sign integer CHECK (barter_sign IN (-1, 1)), barter_kg numeric(12,3),
    description text, print_count integer NOT NULL DEFAULT 0, posted_by uuid REFERENCES users(id), posted_at timestamptz,
    reported_by uuid REFERENCES users(id), settlement_basis_kg numeric(12,3), file_ids uuid[] NOT NULL DEFAULT '{}', locked boolean NOT NULL DEFAULT false, note text)`);
  await run(`CREATE INDEX documents_party_idx ON documents (party_id, currency, status)`);
  await run(`CREATE INDEX documents_kind_idx ON documents (kind, status, date)`);
  await run(`CREATE INDEX documents_order_idx ON documents (order_id)`);
  await run(`CREATE INDEX documents_transfer_idx ON documents (transfer_id)`);
  await run(`CREATE INDEX documents_source_idx ON documents (source_type, source_id)`);
  await run(`CREATE INDEX documents_account_idx ON documents (account_id)`);
  await run(`CREATE INDEX documents_reverses_idx ON documents (reverses_document_id)`);
  await run(`CREATE INDEX documents_reversed_by_idx ON documents (reversed_by_document_id)`);
  await run(`CREATE INDEX documents_lot_idx ON documents (material_lot_id)`);
  await run(`CREATE INDEX documents_date_idx ON documents (date)`);
  await run(`CREATE INDEX documents_posted_by_idx ON documents (posted_by)`);
  await run(`CREATE INDEX documents_reported_by_idx ON documents (reported_by)`);
  await run(`ALTER TABLE production_runs ADD CONSTRAINT production_runs_fee_fk FOREIGN KEY (fee_document_id) REFERENCES documents(id)`);
  await run(`ALTER TABLE production_runs ADD CONSTRAINT production_runs_shortage_fk FOREIGN KEY (shortage_document_id) REFERENCES documents(id)`);
  await run(`CREATE INDEX production_runs_fee_idx ON production_runs (fee_document_id)`);
  await run(`CREATE INDEX production_runs_shortage_idx ON production_runs (shortage_document_id)`);
  await run(`ALTER TABLE coating_runs ADD CONSTRAINT coating_runs_fee_fk FOREIGN KEY (fee_document_id) REFERENCES documents(id)`);
  await run(`CREATE INDEX coating_runs_fee_idx ON coating_runs (fee_document_id)`);
  await run(`ALTER TABLE transfers ADD CONSTRAINT transfers_purchase_fk FOREIGN KEY (purchase_document_id) REFERENCES documents(id)`);
  await run(`ALTER TABLE transfers ADD CONSTRAINT transfers_freight_fk FOREIGN KEY (freight_document_id) REFERENCES documents(id)`);
  await run(`CREATE INDEX transfers_purchase_idx ON transfers (purchase_document_id)`);
  await run(`CREATE INDEX transfers_freight_idx ON transfers (freight_document_id)`);
  await run(`ALTER TABLE die_orders ADD CONSTRAINT die_orders_purchase_fk FOREIGN KEY (purchase_document_id) REFERENCES documents(id)`);
  await run(`CREATE INDEX die_orders_purchase_idx ON die_orders (purchase_document_id)`);

  await run(`CREATE TABLE document_lines (${BASE},
    document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE, order_line_id uuid REFERENCES order_lines(id),
    description text NOT NULL, qty numeric(12,3) CHECK (qty >= 0), unit text, unit_price numeric(18,2) CHECK (unit_price >= 0),
    amount numeric(18,2) NOT NULL CHECK (amount >= 0), vat_rate numeric(5,2), vat_amount numeric(18,2), sort integer NOT NULL DEFAULT 0, meta jsonb)`);
  await run(`CREATE INDEX document_lines_doc_idx ON document_lines (document_id, sort)`);
  await run(`CREATE INDEX document_lines_order_line_idx ON document_lines (order_line_id)`);

  await run(`CREATE TABLE allocations (${BASE},
    from_document_id uuid NOT NULL REFERENCES documents(id), to_document_id uuid REFERENCES documents(id), order_id uuid REFERENCES orders(id),
    amount numeric(18,2) NOT NULL CHECK (amount > 0), currency text NOT NULL ${CUR},
    amount_in_target_currency numeric(18,2) CHECK (amount_in_target_currency > 0), target_currency text CHECK (target_currency IN ('TOMAN','USD','IQD')),
    fx_rate_id uuid REFERENCES fx_rates(id), weight_kg numeric(12,3), CHECK ((to_document_id IS NOT NULL) <> (order_id IS NOT NULL)))`);
  await run(`CREATE INDEX allocations_from_idx ON allocations (from_document_id)`);
  await run(`CREATE INDEX allocations_to_idx ON allocations (to_document_id)`);
  await run(`CREATE INDEX allocations_order_idx ON allocations (order_id)`);
  await run(`CREATE INDEX allocations_fx_idx ON allocations (fx_rate_id)`);
  // Database-enforced: the sum of allocations from a document never exceeds its amount.
  await run(`CREATE FUNCTION check_allocation_total() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE total numeric; doc_amount numeric;
    BEGIN
      SELECT COALESCE(SUM(amount),0) INTO total FROM allocations WHERE from_document_id = NEW.from_document_id;
      SELECT amount INTO doc_amount FROM documents WHERE id = NEW.from_document_id FOR UPDATE;
      IF doc_amount IS NULL OR total > doc_amount THEN RAISE EXCEPTION 'over_allocation' USING ERRCODE = 'check_violation'; END IF;
      RETURN NEW;
    END $$`);
  await run(`CREATE CONSTRAINT TRIGGER allocations_total AFTER INSERT OR UPDATE ON allocations DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION check_allocation_total()`);

  await run(`CREATE TABLE expense_shares (${BASE},
    document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE, order_id uuid NOT NULL REFERENCES orders(id),
    amount numeric(18,2) NOT NULL CHECK (amount >= 0), currency text NOT NULL ${CUR}, weight_kg numeric(12,3), manual boolean NOT NULL DEFAULT false,
    UNIQUE (document_id, order_id))`);
  await run(`CREATE INDEX expense_shares_order_idx ON expense_shares (order_id)`);

  await run(`CREATE TABLE opening_weights (${BASE},
    item_type text NOT NULL CHECK (item_type IN ('material_lot','bundle')), item_id uuid NOT NULL, location_id uuid NOT NULL REFERENCES locations(id),
    kg numeric(12,3) NOT NULL CHECK (kg >= 0), unit_cost numeric(18,2), currency text ${CUR}, as_of date NOT NULL, reason text, file_id uuid REFERENCES files(id),
    locked boolean NOT NULL DEFAULT true)`);
  await run(`CREATE INDEX opening_weights_location_idx ON opening_weights (location_id)`);
  await run(`CREATE INDEX opening_weights_file_idx ON opening_weights (file_id)`);

  await run(`CREATE TABLE correction_requests (${EDITABLE},
    entity text NOT NULL, entity_id uuid NOT NULL, reason text NOT NULL,
    status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','rejected')), resolved_by uuid REFERENCES users(id), resolved_at timestamptz, resolution text)`);
  await run(`CREATE INDEX correction_requests_entity_idx ON correction_requests (entity, entity_id)`);
  await run(`CREATE INDEX correction_requests_status_idx ON correction_requests (status)`);

  // 7.7 daily work
  await run(`CREATE TABLE free_notes (${EDITABLE},
    text text NOT NULL, occurred_at timestamptz,
    topic text CHECK (topic IN ('paint_purchase','tool_purchase','bill_payment','freight_cost','misc_delivery','damage','other')),
    amount numeric(18,2) CHECK (amount >= 0), currency text ${CUR}, party_id uuid REFERENCES parties(id), order_id uuid REFERENCES orders(id),
    location_id uuid REFERENCES locations(id), qty numeric(12,3), kg numeric(12,3), sensitive boolean NOT NULL DEFAULT false,
    status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','needs_info','reviewed','converted','rejected')),
    review_note text, reviewed_by uuid REFERENCES users(id), reviewed_at timestamptz,
    converted_document_ids uuid[] NOT NULL DEFAULT '{}', converted_transfer_id uuid REFERENCES transfers(id), conversion_request_id uuid, telegram_message_id text)`);
  await run(`CREATE INDEX free_notes_status_idx ON free_notes (status, created_at)`);
  await run(`CREATE INDEX free_notes_party_idx ON free_notes (party_id)`);
  await run(`CREATE INDEX free_notes_order_idx ON free_notes (order_id)`);
  await run(`CREATE INDEX free_notes_location_idx ON free_notes (location_id)`);
  await run(`CREATE INDEX free_notes_created_by_idx ON free_notes (created_by)`);
  await run(`CREATE INDEX free_notes_transfer_idx ON free_notes (converted_transfer_id)`);

  await run(`CREATE TABLE tasks (${EDITABLE},
    title text NOT NULL, description text, assignee_user_id uuid NOT NULL REFERENCES users(id), due_at timestamptz,
    voice_file_id uuid REFERENCES files(id), order_id uuid REFERENCES orders(id), transfer_id uuid REFERENCES transfers(id), party_id uuid REFERENCES parties(id),
    status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','cancelled')), done_at timestamptz, done_note text, done_file_id uuid REFERENCES files(id))`);
  await run(`CREATE INDEX tasks_assignee_idx ON tasks (assignee_user_id, status)`);
  await run(`CREATE INDEX tasks_order_idx ON tasks (order_id)`);
  await run(`CREATE INDEX tasks_transfer_idx ON tasks (transfer_id)`);
  await run(`CREATE INDEX tasks_party_idx ON tasks (party_id)`);
  await run(`CREATE INDEX tasks_voice_idx ON tasks (voice_file_id)`);
  await run(`CREATE INDEX tasks_done_file_idx ON tasks (done_file_id)`);
  await run(`CREATE INDEX tasks_due_idx ON tasks (due_at)`);

  await run(`CREATE TABLE task_comments (${BASE},
    task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, user_id uuid NOT NULL REFERENCES users(id), text text, file_id uuid REFERENCES files(id))`);
  await run(`CREATE INDEX task_comments_task_idx ON task_comments (task_id)`);
  await run(`CREATE INDEX task_comments_file_idx ON task_comments (file_id)`);

  await run(`CREATE TABLE share_links (${BASE},
    token_hash text NOT NULL UNIQUE, scope_type text NOT NULL CHECK (scope_type IN ('daily_report','document','bundle_gallery')),
    scope_id uuid, scope_date date, expires_at timestamptz NOT NULL, revoked boolean NOT NULL DEFAULT false, open_count integer NOT NULL DEFAULT 0, last_opened_at timestamptz,
    CHECK ((scope_id IS NOT NULL) OR (scope_date IS NOT NULL)))`);
  await run(`CREATE INDEX share_links_scope_idx ON share_links (scope_type, scope_id, scope_date)`);

  await run(`CREATE TABLE notifications (${BASE},
    user_id uuid NOT NULL REFERENCES users(id), kind text NOT NULL, title text NOT NULL, entity text, entity_id uuid,
    read_at timestamptz, group_key text, telegram_sent_at timestamptz)`);
  await run(`CREATE INDEX notifications_user_idx ON notifications (user_id, read_at, created_at)`);
  await run(`CREATE UNIQUE INDEX notifications_group_open ON notifications (user_id, group_key) WHERE read_at IS NULL AND group_key IS NOT NULL`);

  await run(`CREATE TABLE daily_reports (${BASE},
    date date NOT NULL UNIQUE, generated_at timestamptz NOT NULL DEFAULT now(), snapshot jsonb NOT NULL, sent_to_telegram_at timestamptz)`);

  await run(`CREATE TABLE telegram_link_codes (${BASE},
    user_id uuid NOT NULL REFERENCES users(id), code_hash text NOT NULL UNIQUE, expires_at timestamptz NOT NULL, used_at timestamptz)`);
  await run(`CREATE INDEX telegram_link_codes_user_idx ON telegram_link_codes (user_id)`);

  await run(`CREATE TABLE bot_log (${BASE}, chat_id text, kind text NOT NULL, detail text)`);
  await run(`CREATE INDEX bot_log_created_idx ON bot_log (created_at)`);

  await run(`CREATE TABLE import_batches (${EDITABLE},
    kind text NOT NULL, status text NOT NULL DEFAULT 'preview' CHECK (status IN ('preview','committed','reverted')), rows jsonb NOT NULL, errors jsonb NOT NULL DEFAULT '[]',
    created_ids jsonb NOT NULL DEFAULT '{}', trial boolean NOT NULL DEFAULT false, file_id uuid REFERENCES files(id), note text)`);
  await run(`CREATE INDEX import_batches_file_idx ON import_batches (file_id)`);

  // Document-policy defaults (module 6) and more settings.
  for (const [key, value] of [
    ['transfer_document_policy', { to_customer: ['load_photo', 'scale_ticket'], ingot_in: ['load_photo', 'scale_ticket'] }],
    ['anodize_gain_range_percent', null],
    ['default_anodize_rate_per_kg', null],
  ] as Array<[string, unknown]>) {
    await sql`INSERT INTO settings (key, value) VALUES (${key}, ${JSON.stringify(value)}::jsonb) ON CONFLICT (key) DO NOTHING`.execute(db);
  }
  await sql`UPDATE settings SET value = ${JSON.stringify({ wholesale_proforma: 'V{yymmdd}-{seq}' })}::jsonb WHERE key = 'numbering_patterns' AND value = '{}'::jsonb`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const run = (s: string) => sql.raw(s).execute(db);
  for (const t of [
    'import_batches', 'bot_log', 'telegram_link_codes', 'daily_reports', 'notifications', 'share_links', 'task_comments', 'tasks', 'free_notes',
    'correction_requests', 'opening_weights', 'expense_shares', 'allocations', 'document_lines',
  ]) await run(`DROP TABLE IF EXISTS ${t} CASCADE`);
  await run(`DROP FUNCTION IF EXISTS check_allocation_total()`);
  for (const t of [
    'documents', 'fx_rates', 'accounts', 'stock_moves', 'packing_lines', 'scale_tickets', 'transfer_lines', 'transfers', 'coating_run_items', 'coating_runs',
    'reservations', 'bundle_lines', 'bundles', 'production_run_lines', 'production_runs', 'material_lots', 'order_revisions', 'order_lines', 'orders',
    'die_orders', 'die_events', 'dies', 'product_fillers', 'products', 'contracts', 'locations', 'parties',
  ]) await run(`DROP TABLE IF EXISTS ${t} CASCADE`);
  await sql`DELETE FROM settings WHERE key IN ('transfer_document_policy','anodize_gain_range_percent','default_anodize_rate_per_kg')`.execute(db);
}
