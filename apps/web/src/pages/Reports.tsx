import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { E, ev, L, showParty } from '../components/entity.js';
import { Back, FileUpload, JalaliInput, NumInput, Picker, Table, fa, money, num } from '../components/ui.js';
import { useAuth } from '../lib/auth.js';
import { downloadBlob, qs, useAct, useOne } from '../lib/hooks.js';
import { isoOfJalali, jalaliOfIso } from './Daily.js';

const REPORTS: Array<[string, string, string?]> = [['sales', 'فروش', 'finance.view'], ['receivables', 'مطالبات', 'finance.view'], ['payables', 'بدهی‌ها', 'finance.view'], ['order-profit', 'سود سفارش‌ها', 'finance.view'], ['coating-gain', 'اضافه‌وزن رنگ'], ['workshops', 'کارنامه کارگاه‌ها'], ['inventory', 'موجودی'], ['stock-moves', 'گردش انبار'], ['dies', 'قالب‌ها'], ['materials', 'مواد'], ['expenses', 'هزینه‌ها', 'finance.view']];

/** One screen per report (§15): table from the server's header/rows, same data as the xlsx download. */
export function ReportsPage() {
  const { can } = useAuth();
  const { name = 'inventory' } = useParams();
  const [sp, setSp] = useSearchParams();
  const params = { from: sp.get('from') ?? undefined, to: sp.get('to') ?? undefined, party_id: sp.get('party_id') ?? undefined };
  const srv = { ...params, from: params.from ? jalaliOfIso(params.from) : undefined, to: params.to ? jalaliOfIso(params.to) : undefined };
  const r = useOne<{ header: string[]; rows: unknown[][] }>(`/reports/${name}${qs(srv)}`);
  const setF = (k: string, v: string | null) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); setSp(n, { replace: true }); };
  const fmt = (v: unknown, h: string): string => { if (v === null || v === undefined || v === '') return '—'; if (typeof v === 'number') return fa(v); if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return jalaliOfIso(v.slice(0, 10)); if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) return /کیلو|وزن|خام|پوشش|افزایش/.test(h) ? num(v, 'weight') : /٪|درصد/.test(h) ? num(v, 'percent') : num(v); return E[String(v)] ?? String(v); };
  return (
    <div className="stack">
      <h1>گزارش‌ها</h1>
      <div className="tabs">{REPORTS.filter(([, , p]) => !p || can(p as 'finance.view')).map(([k, l]) => <Link key={k} to={`/reports/${k}${location.search}`} className={k === name ? 'active' : ''} style={{ padding: '0.5rem 0.8rem', textDecoration: 'none', color: k === name ? 'var(--primary)' : 'var(--muted)', borderBottom: k === name ? '3px solid var(--primary)' : '3px solid transparent', whiteSpace: 'nowrap' }}>{l}</Link>)}</div>
      <div className="toolbar card compact"><label className="field" style={{ margin: 0 }}><span>از</span><JalaliInput value={params.from ?? null} onChange={(d) => setF('from', d)} /></label><label className="field" style={{ margin: 0 }}><span>تا</span><JalaliInput value={params.to ?? null} onChange={(d) => setF('to', d)} /></label><label className="field" style={{ margin: 0 }}><span>طرف</span><Picker path="/parties" value={params.party_id} label={showParty as (x: { id: string }) => string} onChange={(id) => setF('party_id', id)} /></label><button className="btn" onClick={() => void downloadBlob(`/reports/${name}${qs({ ...srv, xlsx: 1 })}`, `${name}.xlsx`)}>دانلود Excel</button></div>
      {r.error && <div className="alert danger">گزارش بارگذاری نشد (دسترسی؟)</div>}
      {r.data && <Table head={r.data.header} rows={r.data.rows.map((row) => row.map((c, i) => fmt(c, r.data!.header[i] ?? '')))} />}
    </div>
  );
}

/** Order costing (module 9, R14/R15/R21): components with status, estimated vs realised profit, suggested price. */
export function CostingPage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const [markup, setMarkup] = useState<string | null>(null);
  const [manual, setManual] = useState<string | null>(null);
  const c = useOne<Record<string, unknown>>(`/orders/${id}/costing${qs({ markup_percent: markup ?? undefined, manual_price_per_kg: manual ?? undefined })}`);
  const o = useOne<Record<string, unknown>>(`/orders/${id}`);
  const confirm = useAct<Record<string, unknown>>('POST', `/orders/${id}/confirm-cost`, { onSuccess: () => void qc.invalidateQueries() });
  if (!c.data) return <p className="muted">…</p>;
  const x = c.data;
  const cur = String(x.currency);
  const comps = (x.components as Array<Record<string, unknown>>) ?? [];
  const profit = x.profit as { estimated: Record<string, string> | null; realised: Record<string, string> | null; collected: Record<string, string>; split: Record<string, string> | null };
  const sales = x.sales as { proforma: string; invoiced: string; status: string };
  const pricing = x.pricing as Record<string, string | null>;
  const ST: Record<string, [string, string]> = { estimated: ['برآوردی', 'warn'], final: ['قطعی', 'ok'], unknown: ['نامشخص', 'danger'] };
  const to = (t: string | null, i: string | null) => (t && i ? ({ documents: `/documents/${i}`, production_runs: `/production/${i}`, coating_runs: `/coating/${i}`, transfers: `/transfers/${i}`, material_lots: `/materials/lots/${i}` } as Record<string, string>)[t] : undefined);
  return (
    <div className="stack">
      <Back to={`/orders/${id}`}>سفارش {fa(String(o.data?.number ?? ''))}</Back>
      <div className="row between"><h1>بهای تمام‌شده و سود</h1>{x.cost_confirmed_at ? <span className="badge ok">بها تأییدشده</span> : <button className="btn primary" disabled={confirm.isPending || !!x.cost_incomplete} onClick={() => confirm.mutate({ version: o.data?.version })}>تأیید بهای تمام‌شده</button>}</div>
      {x.cost_incomplete ? <div className="alert warn">بها ناقص است: {((x.incomplete_keys as string[]) ?? []).map((k) => comps.find((cc) => cc.key === k)?.label ?? k).join('، ')}</div> : null}
      <div className="card"><h2>اجزای بها</h2><Table head={['جزء', 'مبنا (کیلو)', 'نرخ', 'مبلغ', 'وضعیت', 'مرجع']} rows={comps.map((cc) => { const s = ST[String(cc.status)] ?? [String(cc.status), '']; const href = to(cc.ref_type as string | null, cc.ref_id as string | null); return [<>{String(cc.label)}{cc.note ? <div className="muted">{String(cc.note)}</div> : null}</>, cc.basis_kg ? num(cc.basis_kg, 'weight') : '—', cc.rate ? money(cc.rate, cur) : '—', cc.amount ? money(cc.amount, cur) : '—', <span className={`badge ${s[1]}`}>{s[0]}</span>, href ? <Link to={href}>{fa(String(cc.ref_number ?? ''))}</Link> : String(cc.ref_number ?? '—')]; })} />
        <div className="row" style={{ marginTop: 6 }}><b>جمع بها: {x.total_cost ? money(x.total_cost, cur) : '—'}</b><span className="badge">خام {num(x.raw_kg, 'weight')} کیلو</span>{x.coated_kg ? <span className="badge">رنگ‌شده {num(x.coated_kg, 'weight')}</span> : null}<span className="badge">ارسال‌شده {num(x.dispatched_final_kg, 'weight')}</span>{Number(x.sold_gain_kg) ? <span className="badge ok">اضافه‌وزن فروخته‌شده {num(x.sold_gain_kg, 'weight')}</span> : null}</div></div>
      <div className="grid2">
        <div className="card"><h2>فروش</h2><div>پیش‌فاکتور: {money(sales.proforma, cur)}</div><div>فاکتورشده: {money(sales.invoiced, cur)} <span className="badge">{ST[sales.status]?.[0]}</span></div></div>
        <div className="card"><h2>سود</h2>{profit.estimated && <div>برآوردی: {money(profit.estimated.profit, cur)} <span className="muted">(فروش {money(profit.estimated.sales, cur)} − بها {money(profit.estimated.cost, cur)})</span></div>}{profit.realised ? <div><b>محقق (R14): {money(profit.realised.profit, cur)}</b></div> : <div className="muted">سود قطعی پس از فاکتور نهایی و بهای کامل.</div>}<div>وصول خالص: {money(profit.collected.net, cur)} <span className="muted">(دریافت {money(profit.collected.received, cur)} − پرداخت {money(profit.collected.paid, cur)})</span></div>{profit.split && <div className="muted">تفکیک R15: سهم پایه {money(profit.split.base_share, cur)} · سهم اضافه‌وزن {money(profit.split.gain_share, cur)}</div>}</div>
        <div className="card"><h2>قیمت پیشنهادی (R21)</h2><div>بها هر کیلو: {pricing.base_per_kg ? money(pricing.base_per_kg, cur) : '—'}</div><label className="field"><span>درصد سود</span><NumInput value={markup ?? pricing.markup_percent} unit="٪" onChange={setMarkup} /></label><div>پیشنهاد: <b>{pricing.suggested_per_kg ? money(pricing.suggested_per_kg, cur) : '—'}</b> هر کیلو</div><label className="field"><span>قیمت دستی هر کیلو</span><NumInput value={manual} onChange={setManual} /></label><div>قیمت مؤثر: {pricing.effective_price_per_kg ? money(pricing.effective_price_per_kg, cur) : '—'}</div></div>
      </div>
    </div>
  );
}

// ───────── Import (§18) ─────────
const KINDS: Array<[string, string]> = [['products', 'محصولات'], ['dies', 'قالب‌ها'], ['parties', 'طرف‌های حساب'], ['contracts', 'قراردادها'], ['opening_stock', 'موجودی اول دوره'], ['open_orders', 'سفارش‌های باز'], ['factor_app', 'خروجی برنامه فاکتور (JSON)'], ['chatgpt', 'خروجی ChatGPT (JSON)']];
/** Upload (POST /files, kind=import) → preview (POST /import/preview {kind, file_id}, nothing written) → commit (trial = revertable). */
export function ImportPage() {
  const qc = useQueryClient();
  const [kind, setKind] = useState('products');
  const [fileId, setFileId] = useState<string | null>(null);
  const [trial, setTrial] = useState(true);
  const preview = useAct<Record<string, unknown>, Record<string, unknown>>('POST', '/import/preview');
  const commit = useAct<Record<string, unknown>, Record<string, unknown>>('POST', (b) => `/import/${b.id}/commit`, { onSuccess: () => void qc.invalidateQueries() });
  const revert = useAct<Record<string, unknown>>('POST', (b) => `/import/${b.id}/revert`, { onSuccess: () => void qc.invalidateQueries() });
  const fields = useOne<{ fields: Array<{ field: string; label: string; required: boolean }> }>(['factor_app', 'chatgpt'].includes(kind) ? null : `/import/fields/${kind}`);
  const batches = useOne<{ items: Array<Record<string, unknown>> }>('/import');
  const p = preview.data;
  return (
    <div className="stack">
      <h1>ورود اطلاعات (Excel / JSON)</h1>
      <div className="card"><div className="grid2"><label className="field"><span>نوع</span><select value={kind} onChange={(e) => { setKind(e.target.value); setFileId(null); preview.reset(); }}>{KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
        <div className="field"><span className="muted">قالب خالی</span><div><button className="btn" onClick={() => void downloadBlob(`/import/templates/${kind}.xlsx`, `${kind}-template.xlsx`)}>دانلود قالب Excel</button></div></div></div>
        {fields.data && <p className="muted">ستون‌ها: {fields.data.fields.map((f) => `${f.label}${f.required ? '*' : ''}`).join('، ')}</p>}
        <div className="row"><FileUpload kind="import" accept=".xlsx,.csv,.json,application/json,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" label={fileId ? 'فایل انتخاب شد ✓ (تغییر)' : 'انتخاب فایل'} onDone={(f) => { setFileId(f.id); preview.mutate({ kind, file_id: f.id }); }} /><button className="btn primary" disabled={!fileId || preview.isPending} onClick={() => preview.mutate({ kind, file_id: fileId })}>پیش‌نمایش (بدون ثبت)</button></div>
        {preview.error && <div className="alert danger">{preview.error.message}</div>}
      </div>
      {p && <div className="card"><h2>پیش‌نمایش: {fa(String(p.row_count))} ردیف</h2>
        {(p.unmapped_required as string[])?.length > 0 && <div className="alert danger">ستون‌های لازم پیدا نشد: {(p.unmapped_required as string[]).join('، ')}</div>}
        {(p.errors as Array<Record<string, unknown>>)?.length > 0 && <div className="alert danger"><b>{fa((p.errors as unknown[]).length)} خطا</b> — هیچ ردیفی ثبت نمی‌شود تا رفع شوند:<ul>{(p.errors as Array<Record<string, unknown>>).slice(0, 30).map((e, i) => <li key={i}>ردیف {fa(String(e.row))}: {String(e.message ?? e.error)}</li>)}</ul></div>}
        {(p.duplicates as Array<Record<string, unknown>>)?.length > 0 && <div className="alert warn">{fa((p.duplicates as unknown[]).length)} ردیف تکراری (رد می‌شوند): {(p.duplicates as Array<Record<string, unknown>>).slice(0, 10).map((d) => String(d.key ?? d.row)).join('، ')}</div>}
        <Table head={Object.keys(((p.rows as Array<Record<string, unknown>>)?.[0]) ?? {}).map((k) => L[k] ?? k)} rows={((p.rows as Array<Record<string, unknown>>) ?? []).slice(0, 50).map((r) => Object.values(r).map((v) => (Array.isArray(v) ? (v.length ? v.map(ev).join('، ') : '—') : typeof v === 'object' && v ? JSON.stringify(v).slice(0, 40) : ev(v))))} />
        <div className="row" style={{ marginTop: 8 }}><label className="row"><input type="checkbox" checked={trial} onChange={(e) => setTrial(e.target.checked)} /> <span>آزمایشی (قابل برگشت)</span></label><button className="btn primary" disabled={!p.can_commit || commit.isPending} onClick={() => commit.mutate({ id: p.id, trial, skip_duplicates: true })}>ثبت نهایی</button></div>
        {commit.data && <div className="alert ok">ثبت شد: {Object.entries((commit.data.created as Record<string, number>) ?? {}).map(([k, v]) => `${L[k] ?? k}: ${fa(v)}`).join('، ')}{commit.data.trial ? ' (آزمایشی)' : ''}</div>}
        {commit.error && <div className="alert danger">{commit.error.message}</div>}
      </div>}
      <div className="card"><h2>ورودهای قبلی</h2><Table head={['زمان', 'نوع', 'وضعیت', 'آزمایشی', 'کاربر', '']} rows={(batches.data?.items ?? []).map((b) => [String(b.created_at).slice(0, 10), KINDS.find(([k]) => k === b.kind)?.[1] ?? String(b.kind), ev(b.status), b.trial ? 'بله' : 'خیر', String(b.user_name ?? ''), b.status === 'committed' && b.trial ? <button className="btn danger" onClick={() => revert.mutate({ id: b.id })}>برگشت</button> : ''])} /></div>
    </div>
  );
}
export { isoOfJalali };
