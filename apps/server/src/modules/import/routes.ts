import type { FastifyInstance } from 'fastify';
import { CURRENCIES, Dec, parseJalali, parseNumber, round, toGregorian, toLatinDigits } from '@vitral/shared';
import { sql } from 'kysely';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import type { Db, Trx } from '../../db/index.js';
import { audit } from '../../lib/audit.js';
import { requirePermission } from '../../lib/auth.js';
import { idParam, uuid } from '../../lib/crud.js';
import { AppError } from '../../lib/errors.js';
import { requireIdempotencyKey, withIdempotency } from '../../lib/idempotency.js';
import { nextNumber } from '../../lib/numbering.js';
import { move, OWN_WAREHOUSE } from '../../lib/stock.js';
import { attachment, buildXlsx } from '../../lib/xlsx.js';
import { readCsvRows, readXlsxRows } from '../../lib/xlsx-read.js';
import { suggestedWeightPerMeter } from '../../rules/weights.js';

export const IMPORT_KINDS = ['products', 'dies', 'parties', 'contracts', 'opening_stock', 'open_orders', 'factor_app', 'chatgpt'] as const;
type Kind = (typeof IMPORT_KINDS)[number];

/** Template columns (spec §18) with the Persian header → field mapping; the first alias is the template header. */
const FIELDS: Record<Exclude<Kind, 'factor_app' | 'chatgpt'>, Array<{ field: string; aliases: string[]; required?: boolean; sample: string }>> = {
  products: [
    { field: 'code', aliases: ['کد', 'کد محصول', 'code'], required: true, sample: '7168' }, { field: 'name_fa', aliases: ['نام فارسی', 'نام', 'name_fa'], required: true, sample: 'مولیون' }, { field: 'name_ar', aliases: ['نام عربی', 'name_ar'], sample: 'موليون' }, { field: 'name_en', aliases: ['نام انگلیسی', 'name_en'], sample: 'Mullion' },
    { field: 'category', aliases: ['دسته', 'category'], sample: 'نما' }, { field: 'alloy', aliases: ['آلیاژ', 'alloy'], sample: '6063' }, { field: 'section_area_mm2', aliases: ['سطح مقطع (mm²)', 'سطح مقطع', 'section_area_mm2'], sample: '293' }, { field: 'filler_mm', aliases: ['فیلر (mm)', 'فیلر', 'filler_mm'], sample: '1.2' },
    { field: 'weight_g_per_m', aliases: ['وزن هر متر (گرم)', 'وزن هر متر', 'weight_g_per_m'], sample: '791' }, { field: 'weight_source', aliases: ['منبع وزن', 'weight_source'], sample: 'drawing' }, { field: 'common_lengths', aliases: ['طول‌های رایج', 'طول های رایج', 'common_lengths'], sample: '6' }, { field: 'colors', aliases: ['رنگ‌ها', 'رنگ ها', 'colors'], sample: 'سفید، مشکی مات' },
  ],
  dies: [
    { field: 'code', aliases: ['کد قالب', 'کد', 'code'], required: true, sample: 'D-7168' }, { field: 'product_code', aliases: ['کد محصول', 'product_code'], sample: '7168' }, { field: 'owner', aliases: ['مالک', 'owner'], sample: 'ویترال' }, { field: 'location', aliases: ['محل فعلی', 'محل', 'location'], sample: 'کارخانه نمونه' }, { field: 'status', aliases: ['وضعیت', 'status'], sample: 'ready' }, { field: 'compatible_press', aliases: ['پرس سازگار', 'compatible_press'], sample: '1800 تن' },
  ],
  parties: [
    { field: 'name', aliases: ['نام', 'name'], required: true, sample: 'مشتری نمونه' }, { field: 'roles', aliases: ['نقش‌ها', 'نقش ها', 'نقش', 'roles'], required: true, sample: 'customer' }, { field: 'phone', aliases: ['تلفن', 'موبایل', 'phone'], sample: '09120000000' }, { field: 'country', aliases: ['کشور', 'country'], sample: 'ایران' }, { field: 'city', aliases: ['شهر', 'city'], sample: 'تهران' }, { field: 'address', aliases: ['نشانی', 'address'], sample: 'نشانی نمونه' },
    { field: 'default_currency', aliases: ['ارز پیش‌فرض', 'ارز پیش فرض', 'default_currency'], sample: 'TOMAN' }, { field: 'opening_toman', aliases: ['مانده افتتاحیه تومان', 'opening_toman'], sample: '0' }, { field: 'opening_usd', aliases: ['دلار', 'مانده افتتاحیه دلار', 'opening_usd'], sample: '0' }, { field: 'opening_iqd', aliases: ['دینار', 'مانده افتتاحیه دینار', 'opening_iqd'], sample: '0' }, { field: 'opening_date', aliases: ['تاریخ مانده', 'opening_date'], sample: '1405/01/01' },
  ],
  contracts: [
    { field: 'party', aliases: ['طرف', 'party'], required: true, sample: 'کارخانه نمونه' }, { field: 'service', aliases: ['خدمت', 'service'], required: true, sample: 'extrusion' }, { field: 'rate_per_kg', aliases: ['نرخ هر کیلو', 'rate_per_kg'], sample: '12000' }, { field: 'currency', aliases: ['ارز', 'currency'], sample: 'TOMAN' }, { field: 'weight_basis', aliases: ['مبنای وزن', 'weight_basis'], sample: 'input' },
    { field: 'fixed_fee', aliases: ['هزینه ثابت', 'fixed_fee'], sample: '0' }, { field: 'scrap_owner', aliases: ['مالک ضایعات', 'scrap_owner'], sample: 'vitral' }, { field: 'includes_material', aliases: ['شمول ماده', 'includes_material'], sample: 'بله' }, { field: 'valid_from', aliases: ['از تاریخ', 'valid_from'], required: true, sample: '1405/01/01' },
  ],
  opening_stock: [
    { field: 'type', aliases: ['نوع', 'type'], required: true, sample: 'ingot' }, { field: 'item', aliases: ['محصول یا ماده', 'محصول', 'ماده', 'item'], sample: 'شمش 6063' }, { field: 'alloy', aliases: ['آلیاژ', 'alloy'], sample: '6063' }, { field: 'filler_mm', aliases: ['فیلر', 'filler_mm'], sample: '' }, { field: 'length_m', aliases: ['طول', 'length_m'], sample: '' }, { field: 'color', aliases: ['رنگ', 'color'], sample: '' },
    { field: 'owner', aliases: ['مالک', 'owner'], sample: 'ویترال' }, { field: 'location', aliases: ['محل', 'location'], required: true, sample: 'انبار ویترال' }, { field: 'kg', aliases: ['کیلو', 'kg'], required: true, sample: '1000' }, { field: 'bars', aliases: ['تعداد شاخه', 'bars'], sample: '' }, { field: 'unit_cost', aliases: ['ارزش هر کیلو', 'unit_cost'], sample: '180000' }, { field: 'date', aliases: ['تاریخ', 'date'], required: true, sample: '1405/01/01' },
  ],
  open_orders: [
    { field: 'old_number', aliases: ['شماره قدیم', 'old_number'], sample: 'A-12' }, { field: 'party', aliases: ['مشتری', 'party'], required: true, sample: 'مشتری نمونه' }, { field: 'date', aliases: ['تاریخ', 'date'], required: true, sample: '1405/01/01' }, { field: 'lines', aliases: ['ردیف‌ها', 'ردیف ها', 'lines'], required: true, sample: '7168 × 500 کیلو' }, { field: 'price', aliases: ['قیمت', 'price'], sample: '850000' }, { field: 'currency', aliases: ['ارز', 'currency'], sample: 'TOMAN' }, { field: 'received', aliases: ['دریافتی تا امروز', 'received'], sample: '0' },
  ],
};

type RowError = { row: number; field?: string; message: string };
interface Prepared { rows: Record<string, unknown>[]; errors: RowError[]; duplicates: RowError[] }

const num = (v: unknown): string | null => { const s = String(v ?? '').trim(); if (!s) return null; const n = parseNumber(s); if (n === null) throw new Error('عدد نامعتبر'); return n; };
const date = (v: unknown): Date | null => { const s = toLatinDigits(String(v ?? '').trim()); if (!s) return null; const j = parseJalali(s); if (!j) { const d = new Date(s); if (isNaN(d.getTime())) throw new Error('تاریخ نامعتبر'); return d; } const g = toGregorian(j.jy, j.jm, j.jd); return new Date(Date.UTC(g.gy, g.gm - 1, g.gd)); };
const list = (v: unknown): string[] => String(v ?? '').split(/[،,;\n]/).map((s) => s.trim()).filter(Boolean);
const yes = (v: unknown): boolean | null => { const s = String(v ?? '').trim().toLowerCase(); if (!s) return null; return ['بله', 'yes', 'true', '1', 'دارد'].includes(s); };

function mapRows(kind: Exclude<Kind, 'factor_app' | 'chatgpt'>, raw: string[][], mapping?: Record<string, string>): Record<string, string>[] {
  const header = (raw[0] ?? []).map((h) => h.trim());
  const defs = FIELDS[kind];
  const colFor: Record<string, number> = {};
  for (const d of defs) {
    const given = mapping?.[d.field];
    const idx = given !== undefined ? header.indexOf(given) : header.findIndex((h) => d.aliases.some((a) => a.toLowerCase() === h.toLowerCase()));
    if (idx >= 0) colFor[d.field] = idx;
  }
  return raw.slice(1).filter((r) => r.some((c) => c && c.trim())).map((r) => Object.fromEntries(defs.map((d) => [d.field, colFor[d.field] !== undefined ? (r[colFor[d.field]!] ?? '') : ''])));
}

async function prepare(db: Db, kind: Kind, raw: string[][] | unknown, mapping?: Record<string, string>): Promise<Prepared & { header: string[]; unmapped: string[] }> {
  const errors: RowError[] = []; const duplicates: RowError[] = [];
  if (kind === 'factor_app' || kind === 'chatgpt') return { ...(await prepareJson(db, kind, raw)), header: [], unmapped: [] };
  const rows2d = raw as string[][];
  const mapped = mapRows(kind, rows2d, mapping);
  const header = rows2d[0] ?? [];
  const defs = FIELDS[kind];
  const unmapped = defs.filter((d) => d.required && !header.some((h) => (mapping?.[d.field] ?? d.aliases).includes(h))).map((d) => d.aliases[0]!);
  const rows: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const [i, r] of mapped.entries()) {
    const n = i + 2;
    const out: Record<string, unknown> = {};
    try {
      for (const d of defs) if (d.required && !String(r[d.field] ?? '').trim()) errors.push({ row: n, field: d.field, message: `«${d.aliases[0]}» لازم است` });
      switch (kind) {
        case 'products': {
          out.code = toLatinDigits(r.code ?? '').trim(); out.name_fa = r.name_fa; out.name_ar = r.name_ar || null; out.name_en = r.name_en || null; out.category = r.category ? ({ 'لاین نوری': 'light_line', نما: 'facade', 'درب و پنجره': 'door_window', عمومی: 'general', متفرقه: 'misc' } as Record<string, string>)[r.category] ?? r.category : null;
          out.alloy = r.alloy || null; out.section_area_mm2 = num(r.section_area_mm2); out.filler_mm = num(r.filler_mm); out.weight_g_per_m = num(r.weight_g_per_m) ?? (out.section_area_mm2 ? suggestedWeightPerMeter(out.section_area_mm2 as string) : null);
          out.weight_source = r.weight_source || (num(r.weight_g_per_m) ? 'drawing' : 'formula'); out.common_lengths = list(r.common_lengths).map((x) => parseNumber(x)).filter(Boolean); out.colors = list(r.colors);
          if (out.code && (await db.selectFrom('products').select('id').where('code', '=', String(out.code)).executeTakeFirst())) duplicates.push({ row: n, field: 'code', message: `کد ${out.code} قبلاً وجود دارد` });
          if (seen.has(`c:${out.code}`)) duplicates.push({ row: n, field: 'code', message: `کد ${out.code} در فایل تکراری است` }); seen.add(`c:${out.code}`);
          break;
        }
        case 'dies': {
          out.code = toLatinDigits(r.code ?? '').trim(); out.product_code = toLatinDigits(r.product_code ?? '').trim() || null; out.owner = r.owner || null; out.location = r.location || null; out.status = r.status || 'ready'; out.compatible_press = r.compatible_press || null;
          if (out.product_code && !(await db.selectFrom('products').select('id').where('code', '=', String(out.product_code)).executeTakeFirst())) errors.push({ row: n, field: 'product_code', message: `محصول ${out.product_code} وجود ندارد` });
          if (await db.selectFrom('dies').select('id').where('code', '=', String(out.code)).executeTakeFirst()) duplicates.push({ row: n, field: 'code', message: `قالب ${out.code} قبلاً وجود دارد` });
          break;
        }
        case 'parties': {
          out.name = r.name?.trim(); out.roles = list(r.roles).map((x) => ({ مشتری: 'customer', کارخانه: 'factory', 'رنگ‌کار': 'painter', رنگکار: 'painter', آنودایزر: 'anodizer', 'تأمین‌کننده شمش': 'ingot_supplier', 'ضایعات‌خر': 'scrap_trader', 'ریخته‌گر': 'smelter', 'قالب‌ساز': 'die_maker', باربری: 'carrier', 'ابزارفروش': 'tool_supplier', سایر: 'other' } as Record<string, string>)[x] ?? x);
          out.phones = list(r.phone).map((p) => toLatinDigits(p)); out.country = r.country || null; out.city = r.city || null; out.address = r.address || null; out.default_currency = (r.default_currency || 'TOMAN').toUpperCase();
          out.opening = { TOMAN: num(r.opening_toman), USD: num(r.opening_usd), IQD: num(r.opening_iqd) }; out.opening_date = date(r.opening_date);
          if (!CURRENCIES.includes(out.default_currency as 'TOMAN')) errors.push({ row: n, field: 'default_currency', message: 'ارز باید TOMAN، USD یا IQD باشد' });
          if (out.name) { const dup = await db.selectFrom('parties').select(['id', 'name']).where((eb) => eb.or([eb('name', '=', String(out.name)), ...((out.phones as string[]).length ? [sql<boolean>`phones && ${out.phones}::text[]`] : [])])).executeTakeFirst(); if (dup) duplicates.push({ row: n, field: 'name', message: `طرف «${dup.name}» با همین نام یا تلفن وجود دارد` }); }
          break;
        }
        case 'contracts': {
          out.party = r.party?.trim(); out.service = ({ اکستروژن: 'extrusion', تولید: 'extrusion', رنگ: 'paint', آنودایز: 'anodize', ذوب: 'smelting', 'قالب‌سازی': 'die_making', حمل: 'transport' } as Record<string, string>)[r.service ?? ''] ?? r.service; out.rate_per_kg = num(r.rate_per_kg); out.currency = (r.currency || 'TOMAN').toUpperCase();
          out.weight_basis = ({ ورودی: 'input', 'خروجی سالم': 'good_output' } as Record<string, string>)[r.weight_basis ?? ''] ?? (r.weight_basis || null); out.fixed_fee = num(r.fixed_fee); out.scrap_owner = ({ ویترال: 'vitral', کارخانه: 'factory' } as Record<string, string>)[r.scrap_owner ?? ''] ?? (r.scrap_owner || null); out.includes_material = yes(r.includes_material); out.valid_from = date(r.valid_from);
          const p = await db.selectFrom('parties').select('id').where('name', '=', String(out.party)).executeTakeFirst();
          if (!p) errors.push({ row: n, field: 'party', message: `طرف «${out.party}» وجود ندارد` }); else out.party_id = p.id;
          break;
        }
        case 'opening_stock': {
          out.type = ({ شمش: 'ingot', بیلت: 'billet', ضایعات: 'scrap', خام: 'raw', 'رنگ‌شده': 'painted', 'رنگ شده': 'painted', آنودایز: 'anodized' } as Record<string, string>)[r.type ?? ''] ?? r.type; out.item = r.item || null; out.alloy = r.alloy || null; out.filler_mm = num(r.filler_mm); out.length_m = num(r.length_m); out.color = r.color || null; out.owner = r.owner || null; out.location = r.location; out.kg = num(r.kg); out.bars = num(r.bars); out.unit_cost = num(r.unit_cost); out.date = date(r.date);
          const loc = await db.selectFrom('locations').select('id').where('name', '=', String(out.location)).executeTakeFirst();
          if (!loc) errors.push({ row: n, field: 'location', message: `محل «${out.location}» وجود ندارد` }); else out.location_id = loc.id;
          if (['raw', 'painted', 'anodized'].includes(String(out.type))) { const p = await db.selectFrom('products').select('id').where('code', '=', toLatinDigits(String(out.item ?? ''))).executeTakeFirst(); if (!p) errors.push({ row: n, field: 'item', message: `محصول «${out.item}» وجود ندارد` }); else out.product_id = p.id; }
          if (!out.kg || new Dec(out.kg as string).lte(0)) errors.push({ row: n, field: 'kg', message: 'کیلو باید بزرگ‌تر از صفر باشد' });
          break;
        }
        case 'open_orders': {
          out.old_number = r.old_number || null; out.party = r.party?.trim(); out.date = date(r.date); out.currency = (r.currency || 'TOMAN').toUpperCase(); out.price = num(r.price); out.received = num(r.received);
          out.lines = list(r.lines).map((l) => { const m = /^(\S+)\s*[×x\*]\s*([\d.,٠-٩۰-۹]+)/.exec(l.trim()); return m ? { product_code: toLatinDigits(m[1]!), qty_kg: parseNumber(m[2]!) } : { description: l }; });
          const p = await db.selectFrom('parties').select('id').where('name', '=', String(out.party)).executeTakeFirst();
          if (!p) errors.push({ row: n, field: 'party', message: `مشتری «${out.party}» وجود ندارد` }); else out.party_id = p.id;
          for (const l of out.lines as Array<{ product_code?: string }>) if (l.product_code) { const pr = await db.selectFrom('products').select('id').where('code', '=', l.product_code).executeTakeFirst(); if (!pr) errors.push({ row: n, field: 'lines', message: `محصول ${l.product_code} وجود ندارد` }); else (l as Record<string, unknown>).product_id = pr.id; }
          break;
        }
      }
    } catch (e) { errors.push({ row: n, message: (e as Error).message }); }
    rows.push({ _row: n, ...out });
  }
  return { rows, errors, duplicates, header, unmapped };
}

/** Backups of the previous apps (§18): tolerant mapping of the parts we recognise; the rest is listed as skipped. */
async function prepareJson(db: Db, kind: 'factor_app' | 'chatgpt', raw: unknown): Promise<Prepared> {
  const errors: RowError[] = []; const duplicates: RowError[] = []; const rows: Record<string, unknown>[] = [];
  const root = (raw as Record<string, unknown>) ?? {};
  const data = (kind === 'factor_app' ? (root.factorApp as Record<string, unknown>) ?? root : root) as Record<string, unknown>;
  const arr = (k: string[]): Record<string, unknown>[] => { for (const key of k) if (Array.isArray(data[key])) return data[key] as Record<string, unknown>[]; return []; };
  const pick = (o: Record<string, unknown>, keys: string[]) => { for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k]; return undefined; };
  let n = 1;
  for (const c of arr(['customers', 'parties', 'clients'])) {
    const name = String(pick(c, ['name', 'title', 'fullName']) ?? '');
    if (!name) { errors.push({ row: n, message: 'مشتری بدون نام' }); n++; continue; }
    const phones = [pick(c, ['phone', 'mobile', 'tel'])].filter(Boolean).map((p) => toLatinDigits(String(p)));
    if (await db.selectFrom('parties').select('id').where('name', '=', name).executeTakeFirst()) duplicates.push({ row: n, field: 'name', message: `«${name}» وجود دارد` });
    rows.push({ _row: n++, _entity: 'party', name, roles: ['customer'], phones, address: pick(c, ['address']) ?? null, default_currency: 'TOMAN', opening: { TOMAN: pick(c, ['balance', 'openingBalance']) !== undefined ? parseNumber(String(pick(c, ['balance', 'openingBalance']))) : null }, opening_date: new Date() });
  }
  for (const p of arr(['products', 'profiles', 'items'])) {
    const code = toLatinDigits(String(pick(p, ['code', 'id', 'sku']) ?? ''));
    const name = String(pick(p, ['name', 'title']) ?? code);
    if (!code) { errors.push({ row: n, message: 'محصول بدون کد' }); n++; continue; }
    let g = pick(p, ['weightPerMeter', 'weight_g_per_m', 'gramPerMeter', 'weight']);
    const gramsInChatgpt = kind === 'chatgpt' && g !== undefined && Number(g) < 20; // ChatGPT app kept kg/m
    if (gramsInChatgpt) g = new Dec(String(g)).mul(1000).toFixed();
    if (await db.selectFrom('products').select('id').where('code', '=', code).executeTakeFirst()) duplicates.push({ row: n, field: 'code', message: `کد ${code} وجود دارد` });
    rows.push({ _row: n++, _entity: 'product', code, name_fa: name, weight_g_per_m: g !== undefined ? parseNumber(String(g)) : null, weight_source: 'agreed', common_lengths: ['6'], colors: [] });
  }
  for (const inv of arr(['invoices', 'sales'])) {
    rows.push({ _row: n++, _entity: 'note', text: `فاکتور قدیمی ${String(pick(inv, ['number', 'id']) ?? '')}: ${JSON.stringify(inv).slice(0, 500)}`, topic: 'other' });
  }
  for (const key of ['payments', 'ingotMoves', 'productionOrders', 'factoryAccounts', 'bundles']) if (Array.isArray(data[key])) rows.push({ _row: n++, _entity: 'skipped', key, count: (data[key] as unknown[]).length, message: `«${key}» با ${(data[key] as unknown[]).length} رکورد فقط به‌صورت یادداشت بایگانی می‌شود؛ مانده‌ها را با فایل افتتاحیه وارد کنید` });
  return { rows, errors, duplicates };
}

async function commit(trx: Trx, kind: Kind, rows: Record<string, unknown>[], userId: string): Promise<Record<string, string[]>> {
  const created: Record<string, string[]> = {};
  const add = (t: string, id: string) => (created[t] ??= []).push(id);
  const wh = await OWN_WAREHOUSE(trx);
  for (const r of rows) {
    const entity = (r._entity as string | undefined) ?? kind;
    if (entity === 'skipped') continue;
    if (entity === 'note') { const n = await trx.insertInto('free_notes').values({ text: String(r.text), topic: 'other', status: 'reviewed', created_by: userId }).returning('id').executeTakeFirstOrThrow(); add('free_notes', n.id); continue; }
    if (kind === 'products' || entity === 'product') {
      const p = await trx.insertInto('products').values({ code: String(r.code), name_fa: String(r.name_fa), name_ar: (r.name_ar as string | null) ?? null, name_en: (r.name_en as string | null) ?? null, category: (r.category as string | null) ?? null, alloy: (r.alloy as string | null) ?? null, section_area_mm2: (r.section_area_mm2 as string | null) ?? null, weight_g_per_m_no_filler: null, common_lengths: (r.common_lengths as string[]) ?? [], colors: (r.colors as string[]) ?? [], created_by: userId }).returning('id').executeTakeFirstOrThrow();
      add('products', p.id);
      if (r.weight_g_per_m) { const f = await trx.insertInto('product_fillers').values({ product_id: p.id, filler_mm: (r.filler_mm as string | null) ?? null, weight_g_per_m: String(r.weight_g_per_m), source: ['drawing', 'sample', 'formula', 'agreed'].includes(String(r.weight_source)) ? String(r.weight_source) : 'agreed', status: 'approved', approved_by: userId, approved_at: new Date(), created_by: userId }).returning('id').executeTakeFirstOrThrow(); add('product_fillers', f.id); }
    } else if (kind === 'dies') {
      const prod = r.product_code ? await trx.selectFrom('products').select('id').where('code', '=', String(r.product_code)).executeTakeFirst() : null;
      const loc = r.location ? await trx.selectFrom('locations').select('id').where('name', '=', String(r.location)).executeTakeFirst() : null;
      const owner = r.owner && String(r.owner) !== 'ویترال' ? await trx.selectFrom('parties').select('id').where('name', '=', String(r.owner)).executeTakeFirst() : null;
      const d = await trx.insertInto('dies').values({ code: String(r.code), product_id: prod?.id ?? null, location_id: loc?.id ?? null, owner_party_id: owner?.id ?? null, status: ['design', 'making', 'ready', 'needs_repair', 'retired'].includes(String(r.status)) ? String(r.status) : 'ready', compatible_press: (r.compatible_press as string | null) ?? null, created_by: userId }).returning('id').executeTakeFirstOrThrow();
      add('dies', d.id);
    } else if (kind === 'parties' || entity === 'party') {
      const p = await trx.insertInto('parties').values({ name: String(r.name), roles: (r.roles as string[]).filter((x) => ['customer', 'factory', 'painter', 'anodizer', 'ingot_supplier', 'scrap_trader', 'smelter', 'die_maker', 'carrier', 'tool_supplier', 'other'].includes(x)), phones: (r.phones as string[]) ?? [], country: (r.country as string | null) ?? null, city: (r.city as string | null) ?? null, address: (r.address as string | null) ?? null, default_currency: String(r.default_currency ?? 'TOMAN'), created_by: userId }).returning('id').executeTakeFirstOrThrow();
      add('parties', p.id);
      for (const role of r.roles as string[]) { const kindL = role === 'factory' || role === 'smelter' ? 'factory' : role === 'painter' || role === 'anodizer' ? 'painter' : null; if (kindL && !(await trx.selectFrom('locations').select('id').where('party_id', '=', p.id).where('kind', '=', kindL).executeTakeFirst())) { const l = await trx.insertInto('locations').values({ name: String(r.name), kind: kindL, party_id: p.id, created_by: userId }).returning('id').executeTakeFirstOrThrow(); add('locations', l.id); } }
      const opening = (r.opening as Record<string, string | null>) ?? {};
      for (const cur of CURRENCIES) { const v = opening[cur]; if (v && !new Dec(v).isZero()) { const d = await trx.insertInto('documents').values({ number: await nextNumber(trx, 'opening_balance'), kind: 'opening_balance', party_id: p.id, amount: new Dec(v).abs().toFixed(2), barter_sign: new Dec(v).gt(0) ? 1 : -1, currency: cur, status: 'posted', locked: true, posted_by: userId, posted_at: new Date(), date: (r.opening_date as Date | null) ?? new Date(), description: 'مانده افتتاحیه (ورود گروهی)', created_by: userId }).returning('id').executeTakeFirstOrThrow(); add('documents', d.id); } }
    } else if (kind === 'contracts') {
      const c = await trx.insertInto('contracts').values({ party_id: String(r.party_id), service: String(r.service), rate_per_kg: (r.rate_per_kg as string | null) ?? null, currency: String(r.currency ?? 'TOMAN'), weight_basis: (r.weight_basis as string | null) ?? null, fixed_fee: (r.fixed_fee as string | null) ?? null, scrap_owner: (r.scrap_owner as string | null) ?? null, includes_material: (r.includes_material as boolean | null) ?? null, valid_from: r.valid_from as Date, created_by: userId }).returning('id').executeTakeFirstOrThrow();
      add('contracts', c.id);
    } else if (kind === 'opening_stock') {
      const at = (r.date as Date) ?? new Date();
      const locId = String(r.location_id ?? wh);
      const owner = r.owner && String(r.owner) !== 'ویترال' ? await trx.selectFrom('parties').select('id').where('name', '=', String(r.owner)).executeTakeFirst() : null;
      if (['ingot', 'billet', 'scrap'].includes(String(r.type))) {
        const lot = await trx.insertInto('material_lots').values({ kind: String(r.type), alloy: (r.alloy as string | null) ?? null, owner_party_id: owner?.id ?? null, description: (r.item as string | null) ?? null, created_by: userId }).returning('id').executeTakeFirstOrThrow();
        add('material_lots', lot.id);
        const ow = await trx.insertInto('opening_weights').values({ item_type: 'material_lot', item_id: lot.id, location_id: locId, kg: String(r.kg), unit_cost: (r.unit_cost as string | null) ?? null, currency: r.unit_cost ? 'TOMAN' : null, as_of: at, reason: 'ورود گروهی', created_by: userId }).returning('id').executeTakeFirstOrThrow();
        add('opening_weights', ow.id);
        await move(trx, { at, item_type: 'material_lot', item_id: lot.id, from_location_id: null, to_location_id: locId, kg: String(r.kg), state_to: r.type === 'scrap' ? 'scrap' : 'ingot', ref_type: 'opening', ref_id: ow.id, unit_cost: (r.unit_cost as string | null) ?? null, currency: r.unit_cost ? 'TOMAN' : null, owner_party_id: owner?.id ?? null, userId });
      } else {
        const form = r.type === 'raw' ? 'raw' : String(r.type);
        const b = await trx.insertInto('bundles').values({ code: `OPN-${String(r._row)}`, code_is_temp: true, location_id: locId, weight_kg: String(r.kg), form, color: (r.color as string | null) ?? null, source: 'opening', reported_at: at, warnings: '[]', created_by: userId }).returning('id').executeTakeFirstOrThrow();
        add('bundles', b.id);
        await trx.insertInto('bundle_lines').values({ bundle_id: b.id, product_id: String(r.product_id), filler_mm: (r.filler_mm as string | null) ?? null, length_m: (r.length_m as string | null) ?? null, bars: r.bars ? Number(r.bars) : null, weight_kg: String(r.kg), created_by: userId }).execute();
        const ow = await trx.insertInto('opening_weights').values({ item_type: 'bundle', item_id: b.id, location_id: locId, kg: String(r.kg), unit_cost: (r.unit_cost as string | null) ?? null, currency: r.unit_cost ? 'TOMAN' : null, as_of: at, reason: 'ورود گروهی', created_by: userId }).returning('id').executeTakeFirstOrThrow();
        add('opening_weights', ow.id);
        await move(trx, { at, item_type: 'bundle', item_id: b.id, from_location_id: null, to_location_id: locId, kg: String(r.kg), state_to: form === 'raw' ? 'raw' : 'coated', ref_type: 'opening', ref_id: ow.id, unit_cost: (r.unit_cost as string | null) ?? null, currency: r.unit_cost ? 'TOMAN' : null, userId });
      }
    } else if (kind === 'open_orders') {
      // r.date comes back from the JSONB batch as an ISO string, not a Date (numbering needs a Date).
      const o = await trx.insertInto('orders').values({ number: await nextNumber(trx, 'order', r.date ? new Date(String(r.date)) : new Date()), party_id: String(r.party_id), currency: String(r.currency ?? 'TOMAN'), order_date: (r.date as Date) ?? new Date(), title: r.old_number ? `شماره قدیم ${r.old_number}` : null, status_sales: 'approved', approved_by: userId, approved_at: new Date(), created_by: userId }).returning('id').executeTakeFirstOrThrow();
      add('orders', o.id);
      let sort = 0;
      for (const l of r.lines as Array<{ product_id?: string; qty_kg?: string | null; description?: string }>) await trx.insertInto('order_lines').values({ order_id: o.id, kind: l.product_id ? 'profile' : 'service', product_id: l.product_id ?? null, description: l.description ?? null, qty_kg: l.qty_kg ?? null, calc_mode: 'manual', price_basis: 'per_kg', unit_price: (r.price as string | null) ?? null, currency: String(r.currency ?? 'TOMAN'), sort: sort++, created_by: userId }).execute();
      if (r.received && !new Dec(r.received as string).isZero()) { const d = await trx.insertInto('documents').values({ number: await nextNumber(trx, 'receipt'), kind: 'receipt', party_id: String(r.party_id), order_id: o.id, amount: String(r.received), currency: String(r.currency ?? 'TOMAN'), method: 'other', status: 'posted', locked: true, posted_by: userId, posted_at: new Date(), description: 'دریافتی تا امروز (ورود گروهی)', created_by: userId }).returning('id').executeTakeFirstOrThrow(); add('documents', d.id); await trx.insertInto('allocations').values({ from_document_id: d.id, order_id: o.id, amount: String(r.received), currency: String(r.currency ?? 'TOMAN'), created_by: userId }).execute(); }
    }
  }
  return created;
}

/** A JSON file for a spreadsheet kind: rows as arrays (first row = header) or as objects (keys = header). */
function jsonTable(v: unknown): string[][] {
  if (!Array.isArray(v)) throw new Error('table expected');
  const cell = (c: unknown) => (c === null || c === undefined ? '' : typeof c === 'object' ? JSON.stringify(c) : String(c));
  if (v.every((r) => Array.isArray(r))) return (v as unknown[][]).map((r) => r.map(cell));
  if (!v.every((r) => r && typeof r === 'object')) throw new Error('table expected');
  const header = [...new Set((v as Record<string, unknown>[]).flatMap((r) => Object.keys(r)))];
  return [header, ...(v as Record<string, unknown>[]).map((r) => header.map((h) => cell(r[h])))];
}

export function importRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, storage } = ctx;

  app.get('/import/templates/:kind.xlsx', async (req, reply) => {
    requirePermission(req, 'settings.manage');
    const { kind } = z.object({ kind: z.enum(['products', 'dies', 'parties', 'contracts', 'opening_stock', 'open_orders']) }).parse(req.params);
    const defs = FIELDS[kind];
    return reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').header('Content-Disposition', attachment(`${kind}.xlsx`)).send(buildXlsx([{ name: kind, header: defs.map((d) => d.aliases[0]!), rows: [defs.map((d) => d.sample)] }]));
  });
  app.get('/import/fields/:kind', async (req) => {
    requirePermission(req, 'settings.manage');
    const { kind } = z.object({ kind: z.enum(['products', 'dies', 'parties', 'contracts', 'opening_stock', 'open_orders']) }).parse(req.params);
    return { fields: FIELDS[kind].map((d) => ({ field: d.field, label: d.aliases[0], required: !!d.required })) };
  });

  /** Preview (T54): parse, map, validate every row; nothing is written. */
  app.post('/import/preview', async (req, reply) => {
    const me = requirePermission(req, 'settings.manage');
    const body = z.object({ kind: z.enum(IMPORT_KINDS), file_id: uuid.optional(), rows: z.array(z.array(z.string())).optional(), json: z.unknown().optional(), mapping: z.record(z.string()).optional(), note: z.string().max(500).optional() }).parse(req.body);
    let raw: unknown = body.rows ?? body.json;
    if (body.file_id) {
      const f = await db.selectFrom('files').selectAll().where('id', '=', body.file_id).executeTakeFirst();
      if (!f) throw new AppError('not_found', 'فایل یافت نشد');
      // Only files uploaded as import material (POST /files, kind=import) are read here — never a photo or a document PDF.
      if (f.kind !== 'import') throw new AppError('validation', 'این فایل برای ورود گروهی بارگذاری نشده است', { file_id: 'فایل ورود گروهی نیست' });
      const buf = await storage.read(f.storage_key);
      try {
        const text = () => buf.toString('utf8').replace(/^\uFEFF/, '');
        if (f.mime === 'application/json') raw = body.kind === 'factor_app' || body.kind === 'chatgpt' ? JSON.parse(text()) : jsonTable(JSON.parse(text()));
        else if (body.kind === 'factor_app' || body.kind === 'chatgpt') throw new Error('json expected');
        else if (f.mime === 'text/csv') raw = readCsvRows(text());
        else raw = readXlsxRows(buf);
      } catch {
        throw new AppError('validation', body.kind === 'factor_app' || body.kind === 'chatgpt' ? 'فایل پشتیبان باید JSON معتبر باشد' : 'فایل خوانده نشد؛ XLSX یا CSV معتبر بفرستید', { file_id: 'فایل خوانده نشد' });
      }
    }
    if (!raw) throw new AppError('validation', 'فایل یا ردیف‌ها لازم است', { file_id: 'لازم است' });
    const prep = await prepare(db, body.kind, raw, body.mapping);
    const batch = await db.insertInto('import_batches').values({ kind: body.kind, file_id: body.file_id ?? null, status: 'preview', rows: JSON.stringify(prep.rows), errors: JSON.stringify([...prep.errors, ...prep.duplicates.map((d) => ({ ...d, duplicate: true }))]), note: body.note ?? null, created_by: me.id }).returning('id').executeTakeFirstOrThrow();
    return reply.status(201).send({ id: batch.id, kind: body.kind, header: prep.header, unmapped_required: prep.unmapped, row_count: prep.rows.length, rows: prep.rows.slice(0, 500), errors: prep.errors, duplicates: prep.duplicates, can_commit: prep.errors.length === 0 && prep.unmapped.length === 0 });
  });

  /** Commit in one transaction; rows with errors block the whole batch; duplicates are skipped unless allow_duplicates. */
  app.post('/import/:id/commit', async (req) => {
    const me = requirePermission(req, 'settings.manage');
    const { id } = idParam.parse(req.params);
    const key = requireIdempotencyKey(req);
    const body = z.object({ trial: z.boolean().default(false), skip_duplicates: z.boolean().default(true) }).parse(req.body ?? {});
    const r = await withIdempotency(db, key, me.id, 'POST /import/commit', async (trx) => {
      const b = await trx.selectFrom('import_batches').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!b) throw new AppError('not_found');
      if (b.status !== 'preview') throw new AppError('validation', 'این دسته قبلاً وارد شده است');
      const errs = (b.errors as unknown as Array<RowError & { duplicate?: boolean }>);
      if (errs.some((e) => !e.duplicate)) throw new AppError('validation', 'ردیف‌های خطادار را اصلاح کنید؛ هیچ ردیفی وارد نشد', { errors: String(errs.filter((e) => !e.duplicate).length) });
      const dupRows = new Set(errs.filter((e) => e.duplicate).map((e) => e.row));
      const rows = (b.rows as unknown as Record<string, unknown>[]).filter((r) => !body.skip_duplicates || !dupRows.has(Number(r._row)));
      const created = await commit(trx, b.kind as Kind, rows, me.id);
      await trx.updateTable('import_batches').set({ status: 'committed', trial: body.trial, created_ids: JSON.stringify(created), updated_at: new Date(), version: sql`version + 1` }).where('id', '=', id).execute();
      await audit(trx, { userId: me.id, entity: 'import_batches', entityId: id, action: 'commit', after: { kind: b.kind, created: Object.fromEntries(Object.entries(created).map(([k, v]) => [k, v.length])), trial: body.trial } });
      return { status: 200, body: { id, created: Object.fromEntries(Object.entries(created).map(([k, v]) => [k, v.length])), skipped_duplicates: dupRows.size, trial: body.trial } };
    });
    return r.body;
  });

  /** Revert a trial import: delete what it created (fails cleanly if anything was used since). */
  app.post('/import/:id/revert', async (req) => {
    const me = requirePermission(req, 'settings.manage');
    const { id } = idParam.parse(req.params);
    return db.transaction().execute(async (trx) => {
      const b = await trx.selectFrom('import_batches').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!b) throw new AppError('not_found');
      if (b.status !== 'committed' || !b.trial) throw new AppError('validation', 'فقط ورود آزمایشی برگشت‌پذیر است');
      const created = b.created_ids as unknown as Record<string, string[]>;
      const order = ['allocations', 'documents', 'order_lines', 'orders', 'opening_weights', 'bundle_lines', 'bundles', 'material_lots', 'contracts', 'locations', 'parties', 'dies', 'product_fillers', 'products', 'free_notes'];
      try {
        for (const t of order) {
          const ids = created[t] ?? [];
          if (!ids.length) continue;
          if (t === 'order_lines') await sql`DELETE FROM order_lines WHERE order_id = ANY(${created.orders ?? []}::uuid[])`.execute(trx);
          else if (t === 'bundle_lines') await sql`DELETE FROM bundle_lines WHERE bundle_id = ANY(${created.bundles ?? []}::uuid[])`.execute(trx);
          else if (t === 'allocations') await sql`DELETE FROM allocations WHERE from_document_id = ANY(${created.documents ?? []}::uuid[])`.execute(trx);
          else if (t === 'bundles' || t === 'material_lots') { await sql`DELETE FROM stock_moves WHERE item_id = ANY(${ids}::uuid[]) AND ref_type = 'opening'`.execute(trx).catch(() => undefined); await sql.raw(`DELETE FROM ${t} WHERE id = ANY('{${ids.join(',')}}'::uuid[])`).execute(trx); }
          else await sql.raw(`DELETE FROM ${t} WHERE id = ANY('{${ids.join(',')}}'::uuid[])`).execute(trx);
        }
      } catch (e) {
        throw new AppError('validation', 'برگشت ممکن نیست؛ از رکوردهای واردشده استفاده شده است: ' + String((e as Error).message).slice(0, 120));
      }
      await trx.updateTable('import_batches').set({ status: 'reverted', updated_at: new Date(), version: sql`version + 1` }).where('id', '=', id).execute();
      await audit(trx, { userId: me.id, entity: 'import_batches', entityId: id, action: 'revert' });
      return { ok: true };
    });
  });

  app.get('/import', async (req) => {
    requirePermission(req, 'settings.manage');
    const rows = await db.selectFrom('import_batches').leftJoin('users', 'users.id', 'import_batches.created_by').select(['import_batches.id', 'import_batches.kind', 'import_batches.status', 'import_batches.trial', 'import_batches.note', 'import_batches.created_at', 'users.short_name as user_name', sql<number>`jsonb_array_length(import_batches.rows)`.as('row_count'), sql<number>`jsonb_array_length(import_batches.errors)`.as('error_count')]).orderBy('import_batches.created_at', 'desc').limit(100).execute();
    return { items: rows };
  });
  app.get('/import/:id', async (req) => {
    requirePermission(req, 'settings.manage');
    const { id } = idParam.parse(req.params);
    const b = await db.selectFrom('import_batches').selectAll().where('id', '=', id).executeTakeFirst();
    if (!b) throw new AppError('not_found');
    return b;
  });
}

export { FIELDS as IMPORT_FIELDS, round };
