import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Action, Details, E, EntityForm, ev, L, ListPage, showLocation, showParty, showProduct, type FieldSpec } from '../components/entity.js';
import { Back, FileUpload, KV, num, PdfButtons, Table, Tabs, Thumb, fa, jdate, money } from '../components/ui.js';
import { useAuth } from '../lib/auth.js';
import { useAct, useList, useOne, qs } from '../lib/hooks.js';
import { useState } from 'react';

const PARTY_ROLES = ['customer', 'factory', 'painter', 'anodizer', 'ingot_supplier', 'scrap_trader', 'smelter', 'die_maker', 'carrier', 'tool_supplier', 'other'];
const CUR = ['TOMAN', 'USD', 'IQD'];

// ───────── Parties ─────────
const partySpecs: FieldSpec[] = [{ k: 'name', t: 'text', req: true }, { k: 'name_ar', t: 'text' }, { k: 'name_en', t: 'ltr' }, { k: 'phones', t: 'tags' }, { k: 'roles', t: 'multi', opts: PARTY_ROLES }, { k: 'country', t: 'text' }, { k: 'city', t: 'text' }, { k: 'address', t: 'textarea' }, { k: 'national_id', t: 'ltr' }, { k: 'default_currency', t: 'select', opts: CUR, req: true }, { k: 'note', t: 'textarea' }];
export const PartiesPage = () => <ListPage title="طرف‌های حساب" path="/parties" newTo="/parties/new" rowTo={(r) => `/parties/${r.id}`} cols={[{ k: 'name' }, { k: 'roles' }, { k: 'city' }, { k: 'phones', f: (v) => <span dir="ltr">{fa(((v as string[]) ?? []).join(', '))}</span> }, { k: 'default_currency' }]} filters={[{ k: 'q', l: 'جستجو', t: 'text' }, { k: 'role', l: 'نقش', t: 'select', opts: PARTY_ROLES }]} />;
export function PartyForm() { const { id } = useParams(); const nav = useNavigate(); const isNew = !id || id === 'new'; return <EntityForm title={isNew ? 'طرف حساب جدید' : 'ویرایش طرف حساب'} path="/parties" id={isNew ? undefined : id} specs={partySpecs} initial={{ phones: [], roles: [], default_currency: 'TOMAN' }} onSaved={(r) => nav(`/parties/${r.id}`)} />; }

export function PartyDetail() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const [tab, setTab] = useState<'summary' | 'statement' | 'open' | 'weight'>('summary');
  const p = useOne<Record<string, unknown>>(`/parties/${id}`);
  const summary = useOne<Record<string, unknown>>(`/parties/${id}/summary`);
  const st = useOne<{ opening: Record<string, string>; rows: Array<Record<string, unknown>>; closing: Record<string, string> }>(tab === 'statement' && can('finance.view') ? `/parties/${id}/statement` : null);
  const open = useOne<{ items: Array<Record<string, unknown>> }>(tab === 'open' && can('finance.view') ? `/parties/${id}/open-items` : null);
  const weight = useOne<Record<string, unknown>>(tab === 'weight' ? `/stock/party-account/${id}` : null);
  if (!p.data) return <p className="muted">…</p>;
  const r = p.data;
  const roles = (r.roles as string[]) ?? [];
  return (
    <div className="stack">
      <Back to="/parties">طرف‌های حساب</Back>
      <div className="row between"><h1>{String(r.name)}</h1><div className="row"><Link className="btn" to={`/parties/${id}/edit`}>ویرایش</Link>{can('finance.view') && <PdfButtons path={`/parties/${id}/statement.pdf`} name={`statement-${r.name}`} />}</div></div>
      <div className="row">{roles.map((x) => <span key={x} className="badge">{E[x] ?? x}</span>)}</div>
      <Tabs value={tab} onChange={setTab} tabs={[['summary', 'خلاصه'], ...(can('finance.view') ? [['statement', 'صورتحساب'] as [typeof tab, string], ['open', 'اقلام باز'] as [typeof tab, string]] : []), ['weight', 'حساب وزنی']]} />
      {tab === 'summary' && <div className="card"><Details r={r} keys={['name_ar', 'name_en', 'phones', 'country', 'city', 'address', 'national_id', 'default_currency', 'note', 'created_at']} />
        {summary.data && <div style={{ marginTop: '0.75rem' }}><h2>خلاصه</h2><KV items={Object.entries(summary.data).filter(([k]) => k !== 'id').map(([k, v]) => [L[k] ?? k, typeof v === 'object' && v ? Object.entries(v as Record<string, unknown>).map(([c, a]) => <span key={c} className="badge">{money(a, c)}</span>) : ev(v)])} /></div>}</div>}
      {tab === 'statement' && st.data && <div className="card"><Table head={['تاریخ', 'شماره', 'نوع', 'شرح', 'بدهکار', 'بستانکار', 'مانده']} rows={[...Object.entries(st.data.opening).map(([c, v]) => ['', '', 'مانده قبلی', c, '', '', money(v, c)]), ...st.data.rows.map((x) => [jdate(String(x.date)), <Link to={`/documents/${x.id}`}>{fa(String(x.number))}</Link>, ev(x.kind), String(x.description ?? ''), x.debit ? money(x.debit, String(x.currency)) : '', x.credit ? money(x.credit, String(x.currency)) : '', money(x.balance, String(x.currency))])]} /><div className="row" style={{ marginTop: 8 }}>{Object.entries(st.data.closing).map(([c, v]) => <span key={c} className="badge ok">مانده: {money(v, c)}</span>)}</div></div>}
      {tab === 'open' && open.data && <div className="card"><Table head={['شماره', 'نوع', 'تاریخ', 'سررسید', 'مبلغ', 'باقیمانده']} rows={open.data.items.map((x) => [<Link to={`/documents/${x.id}`}>{fa(String(x.number))}</Link>, ev(x.kind), jdate(String(x.date)), jdate(x.due_date as string | null), money(x.amount, String(x.currency)), money(x.remaining, String(x.currency))])} /></div>}
      {tab === 'weight' && weight.data && <div className="card"><KV items={Object.entries(weight.data).filter(([, v]) => typeof v !== 'object').map(([k, v]) => [L[k] ?? k, typeof v === 'string' && /kg/.test(k) ? num(v, 'weight') : ev(v)])} />{Array.isArray(weight.data.items) && <Table head={['نوع', 'شرح', 'کیلو']} rows={(weight.data.items as Array<Record<string, unknown>>).map((x) => [ev(x.kind ?? x.ref_type), String(x.description ?? x.code ?? ''), num(x.kg, 'weight')])} />}</div>}
    </div>
  );
}

// ───────── Products ─────────
const CATEGORIES = ['window', 'door', 'curtain_wall', 'industrial', 'tube', 'sheet', 'other'];
const productSpecs: FieldSpec[] = [{ k: 'code', t: 'ltr' }, { k: 'name_fa', t: 'text', req: true }, { k: 'name_ar', t: 'text' }, { k: 'name_en', t: 'ltr' }, { k: 'category', t: 'select', opts: CATEGORIES }, { k: 'alloy', t: 'ltr' }, { k: 'section_area_mm2', t: 'num', unit: 'mm²' }, { k: 'weight_g_per_m_no_filler', t: 'num', unit: 'گرم/متر' }, { k: 'common_lengths', t: 'tags' }, { k: 'colors', t: 'tags' }, { k: 'drawing_version', t: 'ltr' }, { k: 'description', t: 'textarea' }];
export const ProductsPage = () => <ListPage title="محصولات" path="/products" newTo="/products/new" rowTo={(r) => `/products/${r.id}`} cols={[{ k: 'code' }, { k: 'name_fa' }, { k: 'category' }, { k: 'stock_kg', l: 'موجودی (کیلو)' }, { k: 'active' }]} filters={[{ k: 'q', l: 'جستجو', t: 'text' }, { k: 'category', l: 'دسته', t: 'select', opts: CATEGORIES }, { k: 'in_stock', l: 'فقط موجود', t: 'bool' }]} />;
export function ProductForm() { const { id } = useParams(); const nav = useNavigate(); const isNew = !id || id === 'new'; return <EntityForm title={isNew ? 'محصول جدید' : 'ویرایش محصول'} path="/products" id={isNew ? undefined : id} specs={productSpecs} initial={{}} onSaved={(r) => nav(`/products/${r.id}`)} />; }

export function ProductDetail() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const p = useOne<Record<string, unknown>>(`/products/${id}`);
  const fillers = useOne<{ items: Array<Record<string, unknown>> }>(`/products/${id}/fillers`);
  const [f, setF] = useState<{ filler_mm: string | null; weight_g_per_m: string | null }>({ filler_mm: null, weight_g_per_m: null });
  const add = useAct<Record<string, unknown>>('POST', `/products/${id}/fillers`, { onSuccess: () => { setF({ filler_mm: null, weight_g_per_m: null }); void qc.invalidateQueries(); } });
  const setMain = useAct<Record<string, unknown>>('PATCH', `/products/${id}`, { onSuccess: () => void qc.invalidateQueries() });
  if (!p.data) return <p className="muted">…</p>;
  const r = p.data;
  const dies = useList<Record<string, unknown>>('/dies', { product_id: id });
  return (
    <div className="stack">
      <Back to="/products">محصولات</Back>
      <div className="row between"><h1>{String(r.code ?? '')} {String(r.name_fa)}</h1><Link className="btn" to={`/products/${id}/edit`}>ویرایش</Link></div>
      <div className="card"><div className="row">{r.main_file_id ? <Thumb id={String(r.main_file_id)} size={96} /> : null}<FileUpload kind="product" owner={{ entity: 'products', id }} label="تصویر مقطع" onDone={(x) => setMain.mutate({ version: r.version, main_file_id: x.id })} /></div><Details r={r} keys={['name_ar', 'name_en', 'category', 'alloy', 'section_area_mm2', 'weight_g_per_m_no_filler', 'common_lengths', 'colors', 'drawing_version', 'description', 'stock_kg']} /></div>
      <div className="card"><h2>فیلرها و وزن هر متر (R01/R02)</h2>
        <Table head={['فیلر (mm)', 'وزن هر متر (گرم)', 'منبع', 'تأیید', 'میانگین واقعی', 'نمونه']} rows={(fillers.data?.items ?? []).map((x) => [num(x.filler_mm, 'filler'), num(x.weight_g_per_m, 'g_per_m'), ev(x.source), x.approved_at ? <span className="badge ok">تأییدشده</span> : <Action label="تأیید" perm="technical.approve" path={`/products/${id}/fillers/${x.id}/approve`} version={Number(x.version)} onDone={() => void qc.invalidateQueries()} />, x.actual_avg_g_per_m ? num(x.actual_avg_g_per_m, 'g_per_m') : '—', fa(String(x.sample_count ?? 0))])} />
        <div className="toolbar" style={{ marginTop: 8 }}><label className="field"><span>فیلر (mm)</span><input inputMode="decimal" dir="ltr" value={f.filler_mm ?? ''} onChange={(e) => setF({ ...f, filler_mm: e.target.value || null })} /></label><label className="field"><span>وزن هر متر (گرم) — خالی = پیشنهاد R02</span><input inputMode="decimal" dir="ltr" value={f.weight_g_per_m ?? ''} onChange={(e) => setF({ ...f, weight_g_per_m: e.target.value || null })} /></label><button className="btn primary" disabled={!f.filler_mm || add.isPending} onClick={() => add.mutate({ filler_mm: f.filler_mm, weight_g_per_m: f.weight_g_per_m })}>افزودن</button></div>
        {add.error && <div className="alert danger">{add.error.message}</div>}
      </div>
      <div className="card"><h2>قالب‌ها</h2><Table head={['کد', 'وضعیت', 'مکان']} rows={dies.items.map((d) => [<Link to={`/dies/${d.id}`}>{fa(String(d.code))}</Link>, ev(d.status), String(d.location_name ?? '—')])} /></div>
    </div>
  );
}

// ───────── Dies ─────────
const DIE_STATUS = ['ready', 'in_repair', 'retired', 'missing'];
const dieSpecs: FieldSpec[] = [{ k: 'code', t: 'ltr', req: true }, { k: 'name', t: 'text' }, { k: 'product_id', t: 'pick', path: '/products', show: showProduct }, { k: 'owner_party_id', t: 'pick', path: '/parties', show: showParty }, { k: 'maker_party_id', t: 'pick', path: '/parties', params: { role: 'die_maker' }, show: showParty }, { k: 'location_id', t: 'pick', path: '/locations', show: showLocation }, { k: 'compatible_press', t: 'text' }, { k: 'status', t: 'select', opts: DIE_STATUS, req: true }, { k: 'note', t: 'textarea' }];
export const DiesPage = () => <ListPage title="قالب‌ها" path="/dies" newTo="/dies/new" rowTo={(r) => `/dies/${r.id}`} cols={[{ k: 'code' }, { k: 'product_name' }, { k: 'status' }, { k: 'location_name' }, { k: 'total_produced_kg', l: 'تولید تجمعی (کیلو)' }]} filters={[{ k: 'q', l: 'جستجو', t: 'text' }, { k: 'status', l: 'وضعیت', t: 'select', opts: [...DIE_STATUS, 'in_transit'] }]} />;
export function DieForm() { const { id } = useParams(); const nav = useNavigate(); const isNew = !id || id === 'new'; return <EntityForm title={isNew ? 'قالب جدید' : 'ویرایش قالب'} path="/dies" id={isNew ? undefined : id} specs={dieSpecs} initial={{ status: 'ready' }} onSaved={(r) => nav(`/dies/${r.id}`)} />; }
export function DieDetail() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const d = useOne<Record<string, unknown>>(`/dies/${id}`);
  const ev$ = useOne<{ items: Array<Record<string, unknown>> }>(`/dies/${id}/events`);
  const add = useAct<Record<string, unknown>>('POST', `/dies/${id}/events`, { onSuccess: () => void qc.invalidateQueries() });
  const [e, setE] = useState<Record<string, unknown>>({ kind: 'note' });
  if (!d.data) return <p className="muted">…</p>;
  const r = d.data;
  return (
    <div className="stack">
      <Back to="/dies">قالب‌ها</Back>
      <div className="row between"><h1>قالب {fa(String(r.code))}</h1><Link className="btn" to={`/dies/${id}/edit`}>ویرایش</Link></div>
      <div className="card"><Details r={r} keys={['name', 'product_name', 'status', 'location_name', 'owner_name', 'maker_name', 'compatible_press', 'total_produced_kg', 'run_count', 'last_run_at', 'note']} /></div>
      <div className="card"><h2>رویدادها (تعمیر، چک فیلر، آسیب)</h2>
        <Table head={['زمان', 'نوع', 'فیلر اندازه‌گیری‌شده', 'شرح']} rows={(ev$.data?.items ?? []).map((x) => [jdate(String(x.at)), ({ moved: 'جابجایی', repair: 'تعمیر', filler_check: 'چک فیلر', damage: 'آسیب', note: 'یادداشت' } as Record<string, string>)[String(x.kind)] ?? String(x.kind), x.measured_filler_mm ? num(x.measured_filler_mm, 'filler') : '—', String(x.detail ?? '')])} />
        <div className="toolbar" style={{ marginTop: 8 }}><label className="field"><span>نوع</span><select value={String(e.kind)} onChange={(x) => setE({ ...e, kind: x.target.value })}>{[['repair', 'تعمیر'], ['filler_check', 'چک فیلر'], ['damage', 'آسیب'], ['note', 'یادداشت']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>{e.kind === 'filler_check' && <label className="field"><span>فیلر (mm)</span><input dir="ltr" inputMode="decimal" value={String(e.measured_filler_mm ?? '')} onChange={(x) => setE({ ...e, measured_filler_mm: x.target.value || null })} /></label>}<label className="field" style={{ flex: '2 1 200px' }}><span>شرح</span><input value={String(e.detail ?? '')} onChange={(x) => setE({ ...e, detail: x.target.value })} /></label><button className="btn primary" disabled={add.isPending} onClick={() => add.mutate(e)}>ثبت</button></div>
        {add.error && <div className="alert danger">{add.error.message}</div>}
      </div>
    </div>
  );
}

// ───────── Contracts ─────────
const SERVICES = ['extrusion', 'paint', 'anodize', 'smelting'];
const contractSpecs: FieldSpec[] = [{ k: 'party_id', t: 'pick', path: '/parties', show: showParty, req: true }, { k: 'service', t: 'select', opts: SERVICES, req: true }, { k: 'rate_per_kg', t: 'num' }, { k: 'currency', t: 'select', opts: CUR, req: true }, { k: 'weight_basis', t: 'select', opts: ['input', 'good_output'] }, { k: 'fixed_fee', t: 'num' }, { k: 'scrap_owner', t: 'select', opts: ['vitral', 'factory'] }, { k: 'scrap_credit_rate', t: 'num' }, { k: 'includes_material', t: 'bool' }, { k: 'freight_payer', t: 'select', opts: ['vitral', 'party'] }, { k: 'rework_payer', t: 'select', opts: ['vitral', 'party'] }, { k: 'allowed_loss_percent', t: 'num', unit: '٪' }, { k: 'valid_from', t: 'date' }, { k: 'valid_to', t: 'date' }, { k: 'note', t: 'textarea' }];
export const ContractsPage = () => <ListPage title="قراردادها / نرخ‌ها" path="/contracts" newTo="/contracts/new" perm="finance.view" rowTo={(r) => `/contracts/${r.id}/edit`} cols={[{ k: 'party_name' }, { k: 'service' }, { k: 'rate_per_kg', f: (v, r) => money(v, String(r.currency)) }, { k: 'weight_basis' }, { k: 'valid_from' }, { k: 'valid_to' }]} filters={[{ k: 'party_id', l: 'طرف', t: 'pick', path: '/parties', show: showParty }, { k: 'service', l: 'خدمت', t: 'select', opts: SERVICES }]} />;
export function ContractForm() { const { id } = useParams(); const nav = useNavigate(); const isNew = !id || id === 'new'; return <EntityForm title={isNew ? 'قرارداد جدید' : 'ویرایش قرارداد'} path="/contracts" id={isNew ? undefined : id} specs={contractSpecs} initial={{ currency: 'TOMAN', service: 'extrusion' }} onSaved={() => nav('/contracts')} />; }

// ───────── Locations ─────────
const LOC_KINDS = ['own_warehouse', 'factory', 'painter', 'in_transit', 'customer', 'border'];
const locSpecs: FieldSpec[] = [{ k: 'name', t: 'text', req: true }, { k: 'kind', t: 'select', opts: LOC_KINDS, req: true }, { k: 'party_id', t: 'pick', path: '/parties', show: showParty }, { k: 'address', t: 'textarea' }, { k: 'note', t: 'textarea' }];
export const LocationsPage = () => <ListPage title="مکان‌ها" path="/locations" newTo="/locations/new" rowTo={(r) => `/locations/${r.id}/edit`} cols={[{ k: 'name' }, { k: 'kind' }, { k: 'party_name' }, { k: 'address' }]} filters={[{ k: 'kind', l: 'نوع', t: 'select', opts: LOC_KINDS }]} />;
export function LocationForm() { const { id } = useParams(); const nav = useNavigate(); const isNew = !id || id === 'new'; return <EntityForm title={isNew ? 'مکان جدید' : 'ویرایش مکان'} path="/locations" id={isNew ? undefined : id} specs={locSpecs} initial={{ kind: 'own_warehouse' }} onSaved={() => nav('/locations')} />; }

export { qs };
