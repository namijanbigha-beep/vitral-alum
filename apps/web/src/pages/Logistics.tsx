import type React from 'react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Action, Details, E, ev, FieldEditor, L, ListPage, showLocation, showOrder, showParty, showProduct, useForm, type FieldSpec } from '../components/entity.js';
import { Back, ConflictBanner, FileUpload, NumInput, PdfButtons, Picker, Select, Status, Table, Thumb, fa , money, num } from '../components/ui.js';
import { useAuth } from '../lib/auth.js';
import { useAct, useList, useOne } from '../lib/hooks.js';

const KINDS = ['ingot_in', 'to_production', 'raw_delivery', 'to_coating', 'from_coating', 'between_locations', 'to_customer', 'customer_return', 'scrap_out', 'scrap_in', 'die_move', 'general'];
const TSTATUS: Record<string, [string, string?]> = { draft: ['پیش‌نویس'], dispatched: ['حرکت کرده', 'warn'], in_transit: ['در راه', 'warn'], at_border: ['در گذرگاه', 'warn'], partially_received: ['دریافت ناقص', 'warn'], received: ['دریافت شد', 'ok'], delivered: ['تحویل شد', 'ok'] };
export const TransfersPage = () => <ListPage title="بارها و حواله‌ها" path="/transfers" newTo="/transfers/new" rowTo={(r) => `/transfers/${r.id}`} cols={[{ k: 'number' }, { k: 'kind' }, { k: 'from_name' }, { k: 'to_name' }, { k: 'totals', l: 'کیلو', f: (v) => num((v as { kg?: string })?.kg, 'weight') }, { k: 'status', f: (v) => <Status s={String(v)} map={TSTATUS} /> }, { k: 'departed_at' }]} filters={[{ k: 'q', l: 'شماره/پلاک', t: 'text' }, { k: 'kind', l: 'نوع', t: 'select', opts: KINDS }, { k: 'status', l: 'وضعیت', t: 'select', opts: Object.keys(TSTATUS) }, { k: 'order_id', l: 'سفارش', t: 'pick', path: '/orders', show: showOrder }]} />;

type TLine = { bundle_id?: string | null; material_lot_id?: string | null; die_id?: string | null; kg?: string | null; bars?: number | null; packages?: number | null; order_id?: string | null; label?: string };
const transport: FieldSpec[] = [{ k: 'transport_mode', t: 'text' }, { k: 'vehicle_type', t: 'text' }, { k: 'plate', t: 'ltr' }, { k: 'driver_name', t: 'text' }, { k: 'driver_phone', t: 'ltr' }, { k: 'carrier_party_id', t: 'pick', path: '/parties', params: { role: 'carrier' }, show: showParty }, { k: 'waybill_no', t: 'ltr' }, { k: 'eta', t: 'datetime' }, { k: 'is_export', t: 'bool' }, { k: 'border', t: 'text', hidden: (f) => !f.is_export }, { k: 'consignee', t: 'text', hidden: (f) => !f.is_export }, { k: 'destination_country', t: 'text' }, { k: 'destination_city', t: 'text' }, { k: 'destination_address', t: 'textarea' }, { k: 'bill_to_party_id', t: 'pick', path: '/parties', show: showParty, hidden: (f) => !f.is_export }, { k: 'delivery_term', t: 'ltr', hidden: (f) => !f.is_export }, { k: 'freight_cost', t: 'num' }, { k: 'freight_currency', t: 'select', opts: ['TOMAN', 'USD', 'IQD'] }, { k: 'freight_payer', t: 'select', opts: ['vitral', 'customer', 'party'] }, { k: 'note', t: 'textarea' }];

/** Transfer form: kind, from/to, lines (bundles / material lots / dies) and transport. Freight becomes an expense on dispatch (R16). */
export function TransferForm() {
  const { id } = useParams();
  const isNew = !id || id === 'new';
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const existing = useOne<Record<string, unknown>>(isNew ? null : `/transfers/${id}`);
  const { form, set, setForm } = useForm({ kind: sp.get('order_id') ? 'to_customer' : 'between_locations', from_location_id: null, to_location_id: null, order_ids: sp.get('order_id') ? [sp.get('order_id')] : [], freight_currency: 'TOMAN', is_export: false });
  const [lines, setLines] = useState<TLine[]>([]);
  const [q, setQ] = useState('');
  useEffect(() => { if (existing.data) { setForm({ ...existing.data }); setLines(((existing.data.lines as Array<Record<string, unknown>>) ?? []).map((l) => ({ bundle_id: l.bundle_id as string | null, material_lot_id: l.material_lot_id as string | null, die_id: l.die_id as string | null, kg: l.kg as string | null, bars: l.bars as number | null, packages: l.packages as number | null, label: String(l.bundle_code ?? l.lot_description ?? l.die_code ?? '') }))); } }, [existing.data]);
  const bundles = useList<Record<string, unknown>>('/bundles', { location_id: (form.from_location_id as string) ?? undefined, q: q || undefined, draft: 'false' }, { enabled: !!form.from_location_id, limit: 100 });
  const lots = useList<Record<string, unknown>>('/material-lots', { location_id: (form.from_location_id as string) ?? undefined }, { enabled: !!form.from_location_id && ['ingot_in', 'to_production', 'scrap_out', 'scrap_in', 'general'].includes(String(form.kind)) });
  const act = useAct<Record<string, unknown>, { id: string }>(isNew ? 'POST' : 'PATCH', isNew ? '/transfers' : `/transfers/${id}`, { onSuccess: (r) => nav(`/transfers/${r.id}`) });
  const head: FieldSpec[] = [{ k: 'kind', t: 'select', opts: KINDS, req: true }, { k: 'from_location_id', t: 'pick', path: '/locations', show: showLocation, req: true, label: 'از' }, { k: 'to_location_id', t: 'pick', path: '/locations', show: showLocation, label: 'به (برای مشتری خالی بگذارید؛ از سفارش ساخته می‌شود)' }];
  const toggle = (l: TLine, on: boolean) => setLines(on ? [...lines, l] : lines.filter((x) => !(x.bundle_id === l.bundle_id && x.material_lot_id === l.material_lot_id && x.die_id === l.die_id)));
  const has = (k: 'bundle_id' | 'material_lot_id' | 'die_id', v: string) => lines.some((x) => x[k] === v);
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); const b: Record<string, unknown> = {}; for (const s of [...head, ...transport]) if (form[s.k] !== undefined) b[s.k] = form[s.k]; b.order_ids = form.order_ids; b.lines = lines.map(({ label, ...l }) => { void label; return l; }); if (!isNew) b.version = form.version; act.mutate(b); }}>
      <Back to="/transfers">بارها</Back><h1>{isNew ? 'حواله / بار جدید' : `ویرایش حواله ${fa(String(form.number ?? ''))}`}</h1>
      <ConflictBanner err={act.error} fields={L} onReload={() => void existing.refetch()} />
      <div className="card"><div className="grid2">{head.map((s) => <FieldEditor key={s.k} spec={s} form={form} set={set} error={act.error?.fields?.[s.k]} />)}
        <label className="field"><span>سفارش‌ها</span><Picker path="/orders" value={null} label={showOrder as (r: { id: string }) => string} onChange={(oid) => { if (oid && !(form.order_ids as string[]).includes(oid)) set('order_ids', [...(form.order_ids as string[]), oid]); }} /><div className="row">{((form.order_ids as string[]) ?? []).map((o) => <span key={o} className="badge">{String(o).slice(0, 8)} <button type="button" className="btn" style={{ minHeight: 22, padding: '0 6px' }} onClick={() => set('order_ids', (form.order_ids as string[]).filter((x) => x !== o))}>×</button></span>)}</div></label>
      </div></div>
      <div className="card"><h2>ردیف‌های بار ({fa(lines.length)} ردیف، {num(lines.reduce((a, l) => a + Number(l.kg ?? 0), 0).toFixed(3), 'weight')} کیلو)</h2>
        {!form.from_location_id && <p className="muted">اول مکان مبدأ را انتخاب کنید.</p>}
        {lines.length > 0 && <Table head={['ردیف', 'کیلو', 'شاخه', 'بسته', '']} rows={lines.map((l, i): React.ReactNode[] => [String(l.label ?? ''), <NumInput value={l.kg ?? null} onChange={(v) => setLines(lines.map((x, j) => (j === i ? { ...x, kg: v } : x)))} />, <NumInput value={l.bars == null ? null : String(l.bars)} onChange={(v) => setLines(lines.map((x, j) => (j === i ? { ...x, bars: v == null ? null : Number(v) } : x)))} />, <NumInput value={l.packages == null ? null : String(l.packages)} onChange={(v) => setLines(lines.map((x, j) => (j === i ? { ...x, packages: v == null ? null : Number(v) } : x)))} />, <button type="button" className="btn danger" onClick={() => setLines(lines.filter((_, j) => j !== i))}>حذف</button>])} />}
        {!!form.from_location_id && <><input placeholder="جستجوی کد بندیل" value={q} onChange={(e) => setQ(e.target.value)} style={{ marginTop: 8 }} />
          <Table head={['', 'بندیل', 'محصول', 'وزن', 'وضعیت']} rows={bundles.items.filter((b) => !has('bundle_id', String(b.id))).slice(0, 60).map((b) => [<input type="checkbox" onChange={(e) => toggle({ bundle_id: String(b.id), kg: String(b.weight_kg), label: `بندیل ${b.code}` }, e.target.checked)} />, fa(String(b.code)), ((b.lines as Array<{ product_code?: string }>) ?? []).map((l) => l.product_code).join('/'), num(b.weight_kg, 'weight'), ev(b.status)])} />
          {lots.items.length > 0 && <Table head={['', 'پارت مواد', 'نوع', 'موجود (کیلو)']} rows={lots.items.filter((l) => !has('material_lot_id', String(l.id))).map((l) => [<input type="checkbox" onChange={(e) => toggle({ material_lot_id: String(l.id), kg: String(l.kg ?? ''), label: `مواد ${l.description ?? l.kind}` }, e.target.checked)} />, String(l.description ?? ''), ev(l.kind), num(l.kg, 'weight')])} />}
          {form.kind === 'die_move' && <label className="field"><span>قالب</span><Picker path="/dies" value={null} label={((d: Record<string, unknown>) => `${d.code}`) as (r: { id: string }) => string} onChange={(did, row) => { if (did) toggle({ die_id: did, label: `قالب ${(row as Record<string, unknown> | null)?.code}` }, true); }} /></label>}
        </>}
      </div>
      <div className="card"><h2>حمل</h2><div className="grid2">{transport.map((s) => <FieldEditor key={s.k} spec={s} form={form} set={set} error={act.error?.fields?.[s.k]} />)}</div></div>
      <div className="row"><button className="btn primary" type="submit" disabled={act.isPending}>ذخیره پیش‌نویس</button><button className="btn" type="button" onClick={() => nav(-1)}>انصراف</button></div>
    </form>
  );
}

export function TransferDetail() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const t = useOne<Record<string, unknown>>(`/transfers/${id}`);
  const weights = useOne<{ declared_kg: string; received_kg: string; tickets: Record<string, unknown> }>(`/transfers/${id}/weights`);
  const [rec, setRec] = useState<Record<string, { received_kg: string | null; diff_reason: string | null; diff_note: string | null }>>({});
  const receive = useAct<Record<string, unknown>>('POST', `/transfers/${id}/receive`, { onSuccess: () => void qc.invalidateQueries() });
  const refresh = () => void qc.invalidateQueries();
  if (!t.data) return <p className="muted">…</p>;
  const x = t.data;
  const version = Number(x.version);
  const lines = (x.lines as Array<Record<string, unknown>>) ?? [];
  const tickets = (x.scale_tickets as Array<Record<string, unknown>>) ?? [];
  // Server lists what the document policy still lacks; older servers sent only the policy, so absent → no banner.
  const missingDocs = Array.isArray(x.documents_missing) ? (x.documents_missing as string[]) : [];
  const status = String(x.status);
  const canReceive = !['draft', 'received', 'delivered'].includes(status);
  return (
    <div className="stack">
      <Back to="/transfers">بارها</Back>
      <div className="row between"><h1>حواله {fa(String(x.number))} — {ev(x.kind)}</h1><div className="row"><Status s={status} map={TSTATUS} />{status === 'draft' && <Link className="btn" to={`/transfers/${id}/edit`}>ویرایش</Link>}</div></div>
      {missingDocs.length ? <div className="alert warn">مدارک ناقص: {missingDocs.map((m) => DOC_FA[m] ?? E[m] ?? m).join('، ')}</div> : null}
      <div className="card"><Details r={x} keys={['from_name', 'to_name', 'order_numbers', 'departed_at', 'eta', 'received_at', 'receiver_name', 'transport_mode', 'vehicle_type', 'plate', 'driver_name', 'driver_phone', 'waybill_no', 'border', 'is_export', 'consignee', 'destination_country', 'destination_city', 'destination_address', 'delivery_term', 'freight_payer', 'print_count', 'note']} />
        {can('finance.view') && x.freight_cost ? <div className="row" style={{ marginTop: 6 }}><span className="badge">کرایه {money(x.freight_cost, String(x.freight_currency))}</span>{x.freight_document_id ? <Link className="badge ok" to={`/documents/${x.freight_document_id}`}>سند هزینه کرایه</Link> : null}</div> : null}
        {weights.data && <div className="row" style={{ marginTop: 6 }}><span className="badge">اعلامی {num(weights.data.declared_kg, 'weight')} کیلو</span><span className="badge">دریافتی {num(weights.data.received_kg, 'weight')} کیلو</span></div>}
      </div>
      <div className="card"><h2>ردیف‌ها</h2>
        <Table head={['ردیف', 'کیلو', 'شاخه', 'بسته', 'دریافتی', 'اختلاف']} rows={lines.map((l) => [l.bundle_id ? <Link to={`/bundles/${l.bundle_id}`}>بندیل {fa(String(l.bundle_code))}</Link> : l.die_id ? `قالب ${String(l.die_code ?? '')}` : `مواد ${String(l.lot_description ?? l.lot_kind ?? '')}`, num(l.kg, 'weight'), l.bars == null ? '—' : fa(String(l.bars)), l.packages == null ? '—' : fa(String(l.packages)),
          canReceive ? <span className="row"><NumInput value={rec[String(l.id)]?.received_kg ?? (l.kg as string)} onChange={(v) => setRec({ ...rec, [String(l.id)]: { received_kg: v, diff_reason: rec[String(l.id)]?.diff_reason ?? null, diff_note: rec[String(l.id)]?.diff_note ?? null } })} /><Select value={rec[String(l.id)]?.diff_reason ?? ''} allowEmpty="بی‌اختلاف" options={[['scale_difference', 'اختلاف باسکول'], ['packaging', 'بسته‌بندی'], ['shortage', 'کسری'], ['partial_unload', 'تخلیه ناقص'], ['other', 'دیگر']]} onChange={(v) => setRec({ ...rec, [String(l.id)]: { received_kg: rec[String(l.id)]?.received_kg ?? (l.kg as string), diff_reason: v, diff_note: null } })} /></span> : l.received_kg ? num(l.received_kg, 'weight') : '—',
          l.diff_reason ? `${ev(l.diff_reason)} ${String(l.diff_note ?? '')}` : '—'])} />
      </div>
      <div className="card"><h2>اقدام‌ها</h2><ConflictBanner err={receive.error} fields={L} /><div className="row">
        {status === 'draft' && <Action label="ارسال (حرکت بار)" path={`/transfers/${id}/dispatch`} version={version} onDone={refresh} fields={[{ k: 'departed_at', t: 'datetime', label: 'زمان حرکت (خالی = اکنون)' }]} />}
        {(status === 'dispatched' || status === 'in_transit') && x.is_export ? <Action label="رسید به گذرگاه" path={`/transfers/${id}/border`} version={version} onDone={refresh} fields={[{ k: 'border', t: 'text' }]} /> : null}
        {canReceive && <button className="btn primary" disabled={receive.isPending} onClick={() => receive.mutate({ version, lines: lines.map((l) => ({ line_id: l.id, received_kg: rec[String(l.id)]?.received_kg ?? l.kg, diff_reason: rec[String(l.id)]?.diff_reason ?? null, diff_note: rec[String(l.id)]?.diff_note ?? null })) })}>ثبت دریافت در مقصد</button>}
        <PdfButtons path={`/transfers/${id}/packing-list`} name={`packing-${x.number}`} langs={['fa']} />
        {can('finance.view') && x.is_export ? <PdfButtons path={`/transfers/${id}/commercial-invoice`} name={`ci-${x.number}`} langs={['fa']} /> : null}
        <Link className="btn" to={`/transfers/${id}/packing`}>ریز بسته‌بندی</Link>
        <Link className="btn" to={`/scale/new?transfer_id=${id}`}>+ قبض باسکول</Link>
      </div></div>
      <div className="card"><h2>قبض‌های باسکول</h2><Table head={['مرحله', 'باسکول', 'ناخالص', 'خالی', 'خالص', 'وضعیت', '']} rows={tickets.map((s) => [ev(s.stage), String(s.site ?? ''), num(s.gross_kg, 'weight'), num(s.tare_kg, 'weight'), num(s.net_kg, 'weight'), ev(s.status), <Link to={`/scale/${s.id}`}>باز کردن</Link>])} /></div>
      <div className="card"><h2>مدارک بار (عکس بار، بارنامه، رسید تحویل)</h2><div className="row">{((x.files as Array<{ id: string; mime: string }>) ?? []).filter((f) => f.mime.startsWith('image/')).map((f) => <Thumb key={f.id} id={f.id} />)}<FileUpload kind="load" owner={{ entity: 'transfers', id }} capture label="📷 عکس بار" accept="image/*" onDone={refresh} /><FileUpload kind="waybill" owner={{ entity: 'transfers', id }} label="بارنامه" onDone={refresh} /><FileUpload kind="delivery_receipt" owner={{ entity: 'transfers', id }} label="رسید تحویل" onDone={refresh} /></div></div>
    </div>
  );
}

const DOC_FA: Record<string, string> = { load_photo: 'عکس بار', load: 'عکس بار', vehicle: 'عکس ماشین', package: 'عکس بسته‌بندی', waybill: 'بارنامه', scale_ticket: 'قبض باسکول', delivery_receipt: 'رسید تحویل', receipt: 'رسید', packing_list: 'لیست بسته‌بندی' };

/** Packing list editor (R04): per product/filler/colour/length, packages × bars per package, weight mode. */
export function PackingPage() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const t = useOne<Record<string, unknown>>(`/transfers/${id}`);
  const p = useOne<{ items: Array<Record<string, unknown>> }>(`/transfers/${id}/packing`);
  const [rows, setRows] = useState<Array<Record<string, unknown>> | null>(null);
  useEffect(() => { if (p.data && rows === null) setRows(p.data.items.map((r) => ({ ...r }))); }, [p.data, rows]);
  const save = useAct<Record<string, unknown>>('PUT', `/transfers/${id}/packing`, { onSuccess: () => nav(`/transfers/${id}`) });
  const list = rows ?? [];
  const upd = (i: number, patch: Record<string, unknown>) => setRows(list.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="stack">
      <Back to={`/transfers/${id}`}>حواله</Back><h1>ریز بار و بسته‌بندی</h1>
      <ConflictBanner err={save.error} fields={L} />
      {list.map((r, i) => (
        <div key={i} className="card compact"><div className="grid2">
          <label className="field"><span>محصول</span><Picker path="/products" value={r.product_id as string | null} label={showProduct as (x: { id: string }) => string} onChange={(pid) => upd(i, { product_id: pid })} /></label>
          <label className="field"><span>فیلر</span><NumInput value={r.filler_mm as string | null} onChange={(v) => upd(i, { filler_mm: v })} /></label>
          <label className="field"><span>رنگ</span><input value={String(r.color ?? '')} onChange={(e) => upd(i, { color: e.target.value || null })} /></label>
          <label className="field"><span>طول (متر)</span><NumInput value={r.length_m as string | null} onChange={(v) => upd(i, { length_m: v })} /></label>
          <label className="field"><span>تعداد بسته</span><NumInput value={String(r.packages ?? '')} onChange={(v) => upd(i, { packages: v == null ? 0 : Number(v) })} /></label>
          <label className="field"><span>شاخه در هر بسته</span><NumInput value={r.bars_per_package == null ? null : String(r.bars_per_package)} onChange={(v) => upd(i, { bars_per_package: v == null ? null : Number(v) })} /></label>
          <label className="field"><span>وزن (کیلو)</span><NumInput value={r.weight_kg as string | null} onChange={(v) => upd(i, { weight_kg: v })} /></label>
          <label className="field"><span>مبنای وزن</span><Select value={String(r.weight_mode ?? 'group_total')} options={[['group_total', 'جمع گروه'], ['per_package', 'هر بسته']]} onChange={(v) => upd(i, { weight_mode: v })} /></label>
          <label className="field"><span>وزن ناخالص</span><NumInput value={r.gross_kg as string | null} onChange={(v) => upd(i, { gross_kg: v })} /></label>
          <label className="field row"><input type="checkbox" checked={!!r.is_partial} onChange={(e) => upd(i, { is_partial: e.target.checked })} /> <span>بسته ناقص</span></label>
        </div><button className="btn danger" onClick={() => setRows(list.filter((_, j) => j !== i))}>حذف</button></div>
      ))}
      <div className="row"><button className="btn" onClick={() => setRows([...list, { product_id: null, packages: 1, weight_mode: 'group_total', is_partial: false }])}>+ گروه</button><button className="btn primary" disabled={!t.data || save.isPending} onClick={() => save.mutate({ version: t.data!.version, lines: list.map((r) => ({ ...r, packages: Number(r.packages ?? 0), bars: r.bars_per_package && r.packages ? Number(r.bars_per_package) * Number(r.packages) : r.bars ?? null })) })}>ذخیره</button></div>
    </div>
  );
}

// ───────── Scale tickets ─────────
const STAGES = ['origin', 'destination', 'factory_in', 'factory_out', 'painter_in', 'painter_out', 'border'];
const TKT: Record<string, [string, string?]> = { needs_completion: ['ناقص', 'warn'], recorded: ['ثبت‌شده'], approved: ['تأییدشده', 'ok'] };
export const ScalePage = () => <ListPage title="قبض‌های باسکول" path="/scale-tickets" newTo="/scale/new" rowTo={(r) => `/scale/${r.id}`} cols={[{ k: 'at' }, { k: 'stage' }, { k: 'transfer_number', l: 'حواله' }, { k: 'site' }, { k: 'gross_kg' }, { k: 'tare_kg' }, { k: 'net_kg' }, { k: 'status', f: (v) => <Status s={String(v)} map={TKT} /> }]} filters={[{ k: 'status', l: 'وضعیت', t: 'select', opts: Object.keys(TKT) }]} />;
export function ScaleForm() {
  const { id } = useParams();
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const isNew = !id || id === 'new';
  const existing = useOne<Record<string, unknown>>(isNew ? null : `/scale-tickets/${id}`);
  const { form, set, setForm } = useForm({ transfer_id: sp.get('transfer_id'), stage: 'origin', site: null, ticket_no: null, at: new Date().toISOString(), gross_kg: null, tare_kg: null, packaging_kg: null, net_direct_kg: null, file_id: null, note: null });
  useEffect(() => { if (existing.data) setForm({ ...existing.data }); }, [existing.data]);
  const act = useAct<Record<string, unknown>, { id: string }>(isNew ? 'POST' : 'PATCH', isNew ? '/scale-tickets' : `/scale-tickets/${id}`, { onSuccess: (r) => { void qc.invalidateQueries(); nav(isNew ? `/scale/${r.id}` : -1 as never); } });
  const specs: FieldSpec[] = [{ k: 'transfer_id', t: 'pick', path: '/transfers', show: (r) => `${r.number} ${E[String(r.kind)] ?? ''}`, label: 'حواله' }, { k: 'production_run_id', t: 'pick', path: '/production-runs', show: (r) => `${r.number} ${r.factory_name ?? ''}`, label: 'نوبت تولید' }, { k: 'coating_run_id', t: 'pick', path: '/coating-runs', show: (r) => `${r.number} ${r.party_name ?? ''}`, label: 'نوبت رنگ' }, { k: 'stage', t: 'select', opts: STAGES, req: true }, { k: 'site', t: 'text' }, { k: 'ticket_no', t: 'ltr' }, { k: 'at', t: 'datetime' }, { k: 'gross_kg', t: 'num', unit: 'کیلو' }, { k: 'tare_kg', t: 'num', unit: 'کیلو' }, { k: 'packaging_kg', t: 'num', unit: 'کیلو' }, { k: 'net_direct_kg', t: 'num', unit: 'کیلو', label: 'خالص مستقیم (اگر باسکول خالص می‌دهد)' }, { k: 'note', t: 'textarea' }];
  const net = form.net_direct_kg ?? (form.gross_kg && form.tare_kg ? (Number(form.gross_kg) - Number(form.tare_kg) - Number(form.packaging_kg ?? 0)).toFixed(3) : null);
  const x = existing.data;
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); const b: Record<string, unknown> = {}; for (const s of specs) if (form[s.k] !== undefined) b[s.k] = form[s.k]; b.file_id = form.file_id; if (!isNew) b.version = form.version; act.mutate(b); }}>
      <Back to="/scale">قبض‌ها</Back><h1>{isNew ? 'قبض باسکول جدید' : 'قبض باسکول'}</h1>
      {x && <div className="row"><Status s={String(x.status)} map={TKT} />{Array.isArray(x.approved_for) && (x.approved_for as string[]).length > 0 && <span className="badge ok">تأیید برای: {(x.approved_for as string[]).map(ev).join('، ')}</span>}</div>}
      <ConflictBanner err={act.error} fields={L} />
      <div className="card"><div className="grid2">{specs.map((s) => <FieldEditor key={s.k} spec={s} form={form} set={set} error={act.error?.fields?.[s.k]} />)}</div>
        <div className="row"><span className="badge">{net ? `خالص: ${num(net, 'weight')} کیلو` : 'خالص محاسبه نشده (ناقص)'}</span>{form.file_id ? <Thumb id={String(form.file_id)} /> : null}<FileUpload kind="scale_ticket" capture accept="image/*" label="📷 عکس قبض" onDone={(f) => set('file_id', f.id)} /></div>
      </div>
      <div className="row"><button className="btn primary" type="submit" disabled={act.isPending}>ذخیره</button><button className="btn" type="button" onClick={() => nav(-1)}>انصراف</button>
        {x && x.status !== 'approved' && <Action label="تأیید قبض (R09)" perm="technical.approve" path={`/scale-tickets/${id}/approve`} version={Number(x.version)} onDone={() => void existing.refetch()} fields={[{ k: 'approved_for', t: 'multi', opts: ['receipt', 'toll_fee', 'sale'], req: true, label: 'قابل استفاده برای' }]} />}
      </div>
    </form>
  );
}
