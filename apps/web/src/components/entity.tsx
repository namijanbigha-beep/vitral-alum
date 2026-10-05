import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../lib/auth.js';
import { useAct, useList, useOne, type ActResult } from '../lib/hooks.js';
import { ConflictBanner, JalaliInput, jdate, jdt, MoreButton, money, num, NumInput, Picker, Select, Table, fa } from './ui.js';

/** Persian labels for API fields (one place, used by forms, detail views and 409 banners). */
export const L: Record<string, string> = {
  order_numbers: 'سفارش‌ها', _row: 'ردیف فایل', weight_source: 'منبع وزن',
  customer_party_id: 'مشتری', maker_cost: 'هزینه قالب‌ساز', step: 'گام', order_line_id: 'ردیف سفارش', purchase_document_id: 'سند خرید قالب', sample_length_m: 'طول نمونه (متر)', sample_weight_kg: 'وزن نمونه (کیلو)', production_run_id: 'نوبت تولید',
  run_number: 'نوبت تولید', reserved_kg: 'رزروشده (کیلو)', free_kg: 'آزاد (کیلو)', measured_filler_mm: 'فیلر اندازه‌گیری‌شده', measured_length_m: 'طول اندازه‌گیری‌شده', decision_note: 'یادداشت تصمیم',
  code: 'کد', number: 'شماره', name: 'نام', name_fa: 'نام فارسی', name_ar: 'نام عربی', name_en: 'نام انگلیسی', title: 'عنوان', description: 'شرح', note: 'یادداشت', status: 'وضعیت', kind: 'نوع', date: 'تاریخ', created_at: 'ثبت', updated_at: 'آخرین تغییر', version: 'نسخه',
  party_id: 'طرف حساب', party_name: 'طرف حساب', product_id: 'محصول', product_name: 'محصول', location_id: 'مکان', location_name: 'مکان', order_id: 'سفارش', order_number: 'سفارش', die_id: 'قالب', currency: 'ارز', amount: 'مبلغ', weight_kg: 'وزن (کیلو)', kg: 'کیلو', packaging_kg: 'وزن بسته‌بندی', raw_weight_kg: 'وزن خام', bars: 'تعداد شاخه', length_m: 'طول (متر)', filler_mm: 'فیلر (میلی‌متر)', color: 'رنگ', form: 'شکل',
  phones: 'تلفن‌ها', country: 'کشور', city: 'شهر', address: 'نشانی', national_id: 'شناسه ملی', roles: 'نقش‌ها', default_currency: 'ارز پیش‌فرض', category: 'دسته', alloy: 'آلیاژ', section_area_mm2: 'سطح مقطع (mm²)', weight_g_per_m_no_filler: 'وزن هر متر بدون فیلر (گرم)', common_lengths: 'طول‌های رایج', colors: 'رنگ‌ها', drawing_version: 'نسخه نقشه', main_file_id: 'تصویر اصلی',
  owner_party_id: 'مالک', maker_party_id: 'سازنده', compatible_press: 'پرس سازگار', service: 'خدمت', rate_per_kg: 'نرخ هر کیلو', rate_currency: 'ارز نرخ', weight_basis: 'مبنای وزن', fixed_fee: 'هزینه ثابت', scrap_owner: 'مالک ضایعات', scrap_credit_rate: 'نرخ اعتبار ضایعات', includes_material: 'شامل مواد', freight_payer: 'پرداخت‌کننده کرایه', rework_payer: 'پرداخت‌کننده بازکاری', allowed_loss_percent: 'افت مجاز ٪', valid_from: 'از تاریخ', valid_to: 'تا تاریخ', active: 'فعال',
  factory_party_id: 'کارخانه', factory_name: 'کارخانه', started_at: 'شروع', due_at: 'سررسید', ingot_allocated_kg: 'شمش تخصیص‌یافته', ingot_consumed_kg: 'شمش مصرفی', good_kg: 'سالم (کیلو)', rejected_kg: 'مردودی (کیلو)', scrap_kg: 'ضایعات (کیلو)', returned_material_kg: 'مواد برگشتی', unexplained_kg: 'اختلاف نامشخص', press: 'پرس', shift: 'شیفت', heat_treatment: 'عملیات حرارتی', close_reason: 'دلیل بستن', closed_at: 'زمان بستن',
  from_location_id: 'از', to_location_id: 'به', from_name: 'از', to_name: 'به', transport_mode: 'نوع حمل', vehicle_type: 'نوع خودرو', plate: 'پلاک', driver_name: 'راننده', driver_phone: 'تلفن راننده', carrier_party_id: 'شرکت حمل', waybill_no: 'بارنامه', eta: 'زمان رسیدن', border: 'گذرگاه', is_export: 'صادراتی', consignee: 'گیرنده', destination_country: 'کشور مقصد', destination_city: 'شهر مقصد', destination_address: 'نشانی مقصد', bill_to_party_id: 'صورتحساب به', delivery_term: 'شرط تحویل', freight_cost: 'کرایه', freight_currency: 'ارز کرایه', departed_at: 'حرکت', received_at: 'دریافت', receiver_name: 'تحویل‌گیرنده', print_count: 'شمار چاپ',
  stage: 'مرحله', site: 'باسکول', ticket_no: 'شماره قبض', at: 'زمان', gross_kg: 'ناخالص', tare_kg: 'وزن خالی', net_direct_kg: 'خالص مستقیم', net_kg: 'خالص', approved_for: 'تأیید برای',
  method: 'روش', account_id: 'حساب', expense_type: 'نوع هزینه', expense_category: 'دسته هزینه', purchase_kind: 'نوع خرید', material_lot_id: 'پارت مواد', agreed_kg: 'وزن توافقی', received_kg: 'وزن دریافتی', unit_price: 'قیمت واحد', settlement_basis_kg: 'وزن مبنای تسویه', due_date: 'سررسید', tracking_no: 'شماره پیگیری', posted_at: 'قطعی در', locked: 'قفل',
  settlement_basis: 'مبنای تسویه', prepay_percent: 'درصد پیش‌پرداخت', prepay_amount: 'مبلغ پیش‌پرداخت', payment_terms: 'شرایط پرداخت', valid_until: 'اعتبار تا', validity_text: 'متن اعتبار', delivery_days: 'روز تحویل', order_date: 'تاریخ سفارش', owner_user_id: 'مسئول', status_sales: 'وضعیت فروش', revision: 'ویرایش', invoice_notes: 'توضیحات فاکتور', internal_note: 'یادداشت داخلی', numbering_kind: 'نوع شماره',
  qty_bars: 'تعداد شاخه', qty_kg: 'وزن (کیلو)', qty_pieces: 'تعداد', price_basis: 'مبنای قیمت', discount_amount: 'تخفیف (مبلغ)', discount_percent: 'تخفیف ٪', supply_method: 'روش تأمین', material_kind: 'نوع ماده', coating_gain_estimate_percent: 'برآورد اضافه‌وزن رنگ ٪', weight_g_per_m: 'وزن هر متر (گرم)', calc_mode: 'روش محاسبه', min_length_m: 'حداقل طول', load_type_label: 'نوع بار', file_id: 'فایل',
  grade: 'گرید', batch_no: 'شماره بچ', unit: 'واحد', kg_per_unit: 'کیلو در واحد', tool_class: 'نوع ابزار', responsible_user_id: 'مسئول', text: 'متن', topic: 'موضوع', sensitive: 'محرمانه', occurred_at: 'زمان وقوع', qty: 'تعداد', assignee_user_id: 'مسئول انجام', transfer_id: 'بار', done_note: 'یادداشت انجام', color_code: 'کد رنگ', input_basis: 'مبنای وزن ورودی', input_basis_kg: 'وزن مبنا', basis_reason: 'دلیل مبنا', defect: 'عیب', qc_note: 'یادداشت کنترل کیفیت', decision: 'تصمیم', source: 'منبع', reported_at: 'زمان ثبت', warnings: 'هشدارها', reason: 'دلیل',
};
export const E: Record<string, string> = {
  border: 'گذرگاه',
  light_line: 'لاین نوری', facade: 'نما', door_window: 'درب و پنجره', misc: 'متفرقه',
  drawing: 'نقشه', sample: 'نمونه', formula: 'فرمول', proposed: 'پیشنهادی',
  design: 'طراحی', making: 'در ساخت', needs_repair: 'نیاز به تعمیر',
  preview: 'پیش‌نمایش', committed: 'ثبت‌شده', reverted: 'برگشت‌خورده',
  customer: 'مشتری', factory: 'کارخانه', painter: 'رنگکار', anodizer: 'آنادایزکار', ingot_supplier: 'تأمین‌کننده شمش', scrap_trader: 'خریدار ضایعات', smelter: 'ذوب‌کار', die_maker: 'قالب‌ساز', carrier: 'حمل‌کننده', tool_supplier: 'تأمین ابزار', other: 'دیگر',
  TOMAN: 'تومان', USD: 'دلار', IQD: 'دینار', raw: 'خام', painted: 'رنگ‌شده', anodized: 'آنادایز', ok: 'سالم', damaged: 'آسیب‌دیده', wrong_product: 'محصول اشتباه', pending_review: 'در انتظار بررسی', scrapped: 'ضایعات شد', consumed: 'مصرف شد', accept: 'قبول', rework: 'بازکاری', discount_sale: 'فروش با تخفیف', scrap: 'ضایعات',
  extrusion: 'اکستروژن', smelting: 'ذوب', paint: 'رنگ پودری', anodize: 'آنادایز', input: 'وزن ورودی', good_output: 'خروجی سالم', vitral: 'ویترال', party: 'طرف', open: 'باز', closed: 'بسته', draft: 'پیش‌نویس', proforma: 'پیش‌فاکتور', approved: 'تأییدشده', cancelled: 'لغو', reported: 'گزارش‌شده', posted: 'قطعی', void: 'باطل', needs_completion: 'ناقص',
  ingot_in: 'ورود شمش', to_production: 'به تولید', raw_delivery: 'تحویل خام', to_coating: 'به رنگ', from_coating: 'از رنگ', between_locations: 'بین مکان‌ها', to_customer: 'به مشتری', customer_return: 'برگشت مشتری', scrap_out: 'خروج ضایعات', scrap_in: 'ورود ضایعات', die_move: 'جابجایی قالب', general: 'عمومی',
  dispatched: 'حرکت کرده', in_transit: 'در راه', at_border: 'در گذرگاه', partially_received: 'دریافت ناقص', received: 'دریافت شد', delivered: 'تحویل شد', origin: 'مبدأ', destination: 'مقصد', factory_in: 'ورود کارخانه', factory_out: 'خروج کارخانه', painter_in: 'ورود رنگکار', painter_out: 'خروج رنگکار', recorded: 'ثبت‌شده', receipt: 'دریافت', toll_fee: 'اجرت', sale: 'فروش',
  invoice: 'فاکتور فروش', sales_return: 'برگشت فروش', purchase: 'خرید', expense: 'هزینه', payment: 'پرداخت', barter: 'تهاتر', opening_balance: 'مانده افتتاحیه', fx_difference: 'تسعیر ارز', cash: 'نقدی', credit: 'اعتباری', bank: 'بانک', card: 'کارت', cheque: 'چک', hawala: 'حواله', order: 'سفارش', shared: 'مشترک',
  ingot: 'شمش', billet: 'بیلت', scrap_lot: 'ضایعات', paint_powder: 'پودر رنگ', tool: 'ابزار', kg: 'کیلو', carton: 'کارتن', piece: 'عدد', consumable: 'مصرفی', equipment: 'تجهیز', final_net_scale: 'وزن خالص باسکول نهایی', agreed_weight: 'وزن توافقی', per_kg: 'هر کیلو', per_bar: 'هر شاخه', per_meter: 'هر متر', per_piece: 'هر عدد',
  profile: 'پروفیل', material: 'مواد', die_making: 'ساخت قالب', toll_production: 'تولید کارمزدی', stock: 'از موجودی', buy_raw_then_paint: 'خرید خام و رنگ', buy_finished: 'خرید آماده', from_bars: 'از تعداد شاخه', from_weight: 'از وزن', manual: 'دستی', new: 'تازه', needs_info: 'نیاز به اطلاعات', reviewed: 'بررسی‌شده', converted: 'تبدیل‌شده', rejected: 'ردشده', done: 'انجام شد',
  own_warehouse: 'انبار ویترال', border_loc: 'گذرگاه', bundle_sum: 'جمع بندیل‌ها', scale_ticket: 'قبض باسکول', agreed: 'توافقی', ready: 'آماده', in_repair: 'در تعمیر', retired: 'بازنشسته', missing: 'مفقود', production: 'تولید', opening: 'افتتاحیه', return: 'برگشت', unallocated: 'تأمین نشده', partial: 'ناقص', full: 'کامل', none: '—', in_production: 'در تولید', raw_ready: 'خام آماده', at_painter: 'نزد رنگکار', needs_fix: 'نیاز به اصلاح', ready_to_ship: 'آماده ارسال', not_shipped: 'ارسال نشده', no_receipt: 'بدون دریافت', prepaid: 'پیش‌پرداخت شده', settled: 'تسویه', true: 'بله', false: 'خیر',
};
export const ev = (v: unknown): string => (v === null || v === undefined || v === '' ? '—' : (E[String(v)] ?? fa(String(v))));

export type FieldSpec =
  | { k: string; t: 'text' | 'textarea' | 'ltr'; req?: boolean; label?: string; hidden?: (f: Record<string, unknown>) => boolean }
  | { k: string; t: 'num'; unit?: string; req?: boolean; label?: string; hidden?: (f: Record<string, unknown>) => boolean }
  | { k: string; t: 'int'; req?: boolean; label?: string; hidden?: (f: Record<string, unknown>) => boolean }
  | { k: string; t: 'date' | 'datetime' | 'bool'; req?: boolean; label?: string; hidden?: (f: Record<string, unknown>) => boolean }
  | { k: string; t: 'select'; opts: string[]; req?: boolean; label?: string; empty?: string; hidden?: (f: Record<string, unknown>) => boolean }
  | { k: string; t: 'multi'; opts: string[]; req?: boolean; label?: string; hidden?: (f: Record<string, unknown>) => boolean }
  | { k: string; t: 'tags'; req?: boolean; label?: string; hidden?: (f: Record<string, unknown>) => boolean }
  | { k: string; t: 'pick'; path: string; params?: Record<string, string>; show: (r: Record<string, unknown>) => string; req?: boolean; label?: string; onPick?: (r: Record<string, unknown> | null, f: Record<string, unknown>) => Record<string, unknown>; hidden?: (f: Record<string, unknown>) => boolean };

export const showParty = (r: Record<string, unknown>) => `${r.name}${r.city ? ` (${r.city})` : ''}`;
export const showProduct = (r: Record<string, unknown>) => `${r.code ?? ''} ${r.name_fa ?? ''}`.trim();
export const showLocation = (r: Record<string, unknown>) => `${r.name} ${r.kind ? `(${E[String(r.kind)] ?? r.kind})` : ''}`;
export const showOrder = (r: Record<string, unknown>) => `${r.number} — ${(r.party as { name?: string } | null)?.name ?? r.party_name ?? ''}`;
export const showUser = (r: Record<string, unknown>) => String(r.short_name || r.name);

function toIso(local: string): string | null { if (!local) return null; const d = new Date(local); return isNaN(d.getTime()) ? null : d.toISOString(); }
function toLocal(iso: unknown): string { if (!iso) return ''; const d = new Date(String(iso)); const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; }

/** One field editor; value lives in the parent's form record under `spec.k`. */
export function FieldEditor({ spec, form, set, error }: { spec: FieldSpec; form: Record<string, unknown>; set: (k: string, v: unknown, extra?: Record<string, unknown>) => void; error?: string }) {
  if (spec.hidden?.(form)) return null;
  const v = form[spec.k];
  const label = spec.label ?? L[spec.k] ?? spec.k;
  let input: ReactNode;
  switch (spec.t) {
    case 'text': input = <input value={(v as string) ?? ''} onChange={(e) => set(spec.k, e.target.value || null)} />; break;
    case 'ltr': input = <input dir="ltr" value={(v as string) ?? ''} onChange={(e) => set(spec.k, e.target.value || null)} />; break;
    case 'textarea': input = <textarea rows={3} value={(v as string) ?? ''} onChange={(e) => set(spec.k, e.target.value || null)} />; break;
    case 'num': input = <NumInput value={v as string | null} unit={spec.unit} onChange={(n) => set(spec.k, n)} />; break;
    case 'int': input = <NumInput value={v == null ? null : String(v)} onChange={(n) => set(spec.k, n == null ? null : Math.trunc(Number(n)))} />; break;
    case 'date': input = <JalaliInput value={v as string | null} onChange={(d) => set(spec.k, d)} />; break;
    case 'datetime': input = <input type="datetime-local" dir="ltr" value={toLocal(v)} onChange={(e) => set(spec.k, toIso(e.target.value))} />; break;
    case 'bool': input = <label className="row" style={{ minHeight: 44 }}><input type="checkbox" style={{ width: 22, height: 22 }} checked={!!v} onChange={(e) => set(spec.k, e.target.checked)} /> <span>{label}</span></label>; return <div className="field">{input}{error && <div className="error">{error}</div>}</div>;
    case 'select': input = <Select value={(v as string) ?? ''} allowEmpty={spec.req ? undefined : (spec.empty ?? '—')} options={spec.opts.map((o) => [o, E[o] ?? o])} onChange={(x) => set(spec.k, x)} />; break;
    case 'multi': input = <div className="row">{spec.opts.map((o) => { const arr = (v as string[]) ?? []; const on = arr.includes(o); return <button type="button" key={o} className={`badge ${on ? 'ok' : ''}`} style={{ minHeight: 36, border: '1px solid var(--border)' }} onClick={() => set(spec.k, on ? arr.filter((x) => x !== o) : [...arr, o])}>{E[o] ?? o}</button>; })}</div>; break;
    case 'tags': input = <input dir="auto" placeholder="با ویرگول جدا کنید" value={((v as string[]) ?? []).join('، ')} onChange={(e) => set(spec.k, e.target.value.split(/[،,]/).map((s) => s.trim()).filter(Boolean))} />; break;
    case 'pick': input = <Picker path={spec.path} params={spec.params} value={v as string | null} label={spec.show as (r: { id: string }) => string} onChange={(id, row) => set(spec.k, id, spec.onPick?.(row as Record<string, unknown> | null, form))} />; break;
  }
  return <label className="field"><span>{label}{spec.req && <b className="req">*</b>}</span>{input}{error && <div className="error">{error}</div>}</label>;
}

export function useForm(initial: Record<string, unknown>) {
  const [form, setForm] = useState<Record<string, unknown>>(initial);
  const set = (k: string, v: unknown, extra?: Record<string, unknown>) => setForm((f) => ({ ...f, [k]: v, ...(extra ?? {}) }));
  return { form, set, setForm };
}

/** Generic create/edit form over a crud endpoint. */
export function EntityForm({ specs, initial, path, id, onSaved, title, children, transform, extraActions }: { specs: FieldSpec[]; initial: Record<string, unknown>; path: string; id?: string; onSaved: (r: Record<string, unknown>) => void; title: string; children?: ReactNode; transform?: (f: Record<string, unknown>) => Record<string, unknown>; extraActions?: ReactNode }) {
  const nav = useNavigate();
  const existing = useOne<Record<string, unknown>>(id ? `${path}/${id}` : null, { refetchInterval: false, refetchOnWindowFocus: false });
  const { form, set, setForm } = useForm(initial);
  useEffect(() => { if (existing.data) setForm({ ...initial, ...existing.data }); }, [existing.data]);
  const act = useAct<Record<string, unknown>, Record<string, unknown>>(id ? 'PATCH' : 'POST', id ? `${path}/${id}` : path, { onSuccess: onSaved });
  const submit = () => {
    const body: Record<string, unknown> = {};
    for (const s of specs) if (!s.hidden?.(form) && form[s.k] !== undefined) body[s.k] = form[s.k];
    if (id) body.version = form.version;
    act.mutate(transform ? transform({ ...body, ...Object.fromEntries(Object.entries(form).filter(([k]) => !specs.some((s) => s.k === k))) }) : body);
  };
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <h1>{title}</h1>
      <ConflictBanner err={act.error} fields={L} onReload={() => { void existing.refetch().then((r) => { if (r.data) setForm((f) => ({ ...f, version: (r.data as Record<string, unknown>).version })); }); act.clearError(); }} />
      <div className="card"><div className="grid2">{specs.map((s) => <FieldEditor key={s.k} spec={s} form={form} set={set} error={act.error?.fields?.[s.k]} />)}</div>{children}</div>
      <div className="row"><button className="btn primary" type="submit" disabled={act.isPending || (!!id && existing.isLoading)}>{act.isPending ? 'در حال ذخیره…' : 'ذخیره'}</button><button className="btn" type="button" onClick={() => nav(-1)}>انصراف</button>{extraActions}</div>
    </form>
  );
}

export interface Col { k: string; l?: string; f?: (v: unknown, r: Record<string, unknown>) => ReactNode }
export type Filter = { k: string; l: string; t: 'text' } | { k: string; l: string; t: 'select'; opts: string[] } | { k: string; l: string; t: 'pick'; path: string; show: (r: Record<string, unknown>) => string } | { k: string; l: string; t: 'bool' } | { k: string; l: string; t: 'date' };

export function cell(c: Col, r: Record<string, unknown>): ReactNode {
  const v = r[c.k];
  if (c.f) return c.f(v, r);
  if (v === null || v === undefined) return '—';
  if (/_kg$|^kg$/.test(c.k)) return <span className="num">{num(v, 'weight')}</span>;
  if (/_at$|^at$/.test(c.k)) return jdt(String(v));
  if (/date$|^date$/.test(c.k)) return jdate(String(v));
  if (c.k === 'amount' && r.currency) return <span className="num">{money(v, String(r.currency))}</span>;
  if (typeof v === 'boolean') return v ? 'بله' : 'خیر';
  if (Array.isArray(v)) return v.map(ev).join('، ');
  if (typeof v === 'object') return '…';
  return ev(v);
}

/** Generic list page with URL-synced filters, cursor paging and a "new" button. */
export function ListPage({ title, path, cols, filters = [], newTo, rowTo, perm, extra, fixed }: { title: string; path: string; cols: Col[]; filters?: Filter[]; newTo?: string; rowTo: (r: Record<string, unknown>) => string; perm?: string; extra?: ReactNode; fixed?: Record<string, string> }) {
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const params: Record<string, string> = { ...fixed };
  for (const f of filters) { const v = sp.get(f.k); if (v) params[f.k] = v; }
  const list = useList<Record<string, unknown>>(path, params);
  const setF = (k: string, v: string | null) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); setSp(n, { replace: true }); list.reset(); };
  return (
    <div className="stack">
      <div className="row between"><h1>{title}</h1>{newTo && (!perm || can(perm as 'finance.view')) && <Link className="btn primary" to={newTo}>جدید</Link>}{extra}</div>
      {filters.length > 0 && (
        <div className="toolbar card compact">
          {filters.map((f) => (
            <label key={f.k} className="field" style={{ margin: 0 }}><span>{f.l}</span>
              {f.t === 'text' && <input value={sp.get(f.k) ?? ''} onChange={(e) => setF(f.k, e.target.value || null)} placeholder="جستجو…" />}
              {f.t === 'select' && <Select value={sp.get(f.k) ?? ''} allowEmpty="همه" options={f.opts.map((o) => [o, E[o] ?? o])} onChange={(v) => setF(f.k, v)} />}
              {f.t === 'bool' && <Select value={sp.get(f.k) ?? ''} allowEmpty="همه" options={[['true', 'بله'], ['false', 'خیر']]} onChange={(v) => setF(f.k, v)} />}
              {f.t === 'pick' && <Picker path={f.path} value={sp.get(f.k)} label={f.show as (r: { id: string }) => string} onChange={(id) => setF(f.k, id)} />}
              {f.t === 'date' && <JalaliInput value={sp.get(f.k)} onChange={(d) => setF(f.k, d)} />}
            </label>
          ))}
        </div>
      )}
      {list.error && <div className="alert danger">بارگذاری نشد.</div>}
      <Table head={cols.map((c) => c.l ?? L[c.k] ?? c.k)} rows={list.items.map((r) => cols.map((c, i) => (i === 0 ? <Link to={rowTo(r)}>{cell(c, r)}</Link> : cell(c, r))))} />
      <MoreButton list={list} />
    </div>
  );
}

/** Detail header KV from the row with Persian labels; `skip` hides internal keys. */
export function Details({ r, keys }: { r: Record<string, unknown>; keys: string[] }) {
  return <dl className="kv">{keys.filter((k) => k in r).map((k) => <div key={k}><dt>{L[k] ?? k}</dt><dd>{cell({ k }, r)}</dd></div>)}</dl>;
}

/** Action button with a small inline form (reason, fields) → POST with version & idempotency; 409 shows the banner. */
export function Action({ label, path, version, fields = [], onDone, perm, danger, body: fixedBody, confirm }: { label: string; path: string; version: number; fields?: FieldSpec[]; onDone?: () => void; perm?: string; danger?: boolean; body?: Record<string, unknown>; confirm?: string }) {
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  const { form, set } = useForm({});
  const act = useAct<Record<string, unknown>>('POST', path, { onSuccess: () => { setOpen(false); onDone?.(); } });
  if (perm && !can(perm as 'finance.view')) return null;
  const run = () => act.mutate({ version, ...fixedBody, ...form });
  if (!open) return <button type="button" className={`btn ${danger ? 'danger' : ''}`} onClick={() => (fields.length || confirm ? setOpen(true) : run())} disabled={act.isPending}>{label}</button>;
  return (
    <div className="modal-bg" onClick={() => setOpen(false)}><div className="modal card" onClick={(e) => e.stopPropagation()}>
      <h2>{label}</h2>{confirm && <p>{confirm}</p>}
      <ConflictBanner err={act.error} fields={L} />
      {fields.map((f) => <FieldEditor key={f.k} spec={f} form={form} set={set} error={act.error?.fields?.[f.k]} />)}
      <div className="row" style={{ justifyContent: 'flex-end' }}><button type="button" className="btn" onClick={() => setOpen(false)}>انصراف</button><button type="button" className={`btn ${danger ? 'danger' : 'primary'}`} disabled={act.isPending} onClick={run}>تأیید</button></div>
    </div></div>
  );
}

export function ErrText({ e }: { e: ActResult | null }) { return e ? <div className="alert danger">{e.message}</div> : null; }
