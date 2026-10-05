import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Action, Details, EntityForm, ev, FieldEditor, L, ListPage, showParty, showProduct, useForm, type FieldSpec } from '../components/entity.js';
import { Back, ConflictBanner, NumInput, Status, Table, fa, jdt, money, num } from '../components/ui.js';
import { useAuth } from '../lib/auth.js';
import { useAct, useList, useOne } from '../lib/hooks.js';

// ───────── Production runs ─────────
const RUN_STATUS: Record<string, [string, string?]> = { open: ['باز', 'ok'], closed: ['بسته'] };
export const RunsPage = () => <ListPage title="نوبت‌های تولید" path="/production-runs" newTo="/production/new" rowTo={(r) => `/production/${r.id}`} cols={[{ k: 'number' }, { k: 'factory_name' }, { k: 'service' }, { k: 'started_at' }, { k: 'ingot_allocated_kg' }, { k: 'good_kg' }, { k: 'status', f: (v) => <Status s={String(v)} map={RUN_STATUS} /> }]} filters={[{ k: 'status', l: 'وضعیت', t: 'select', opts: ['open', 'closed'] }, { k: 'factory_party_id', l: 'کارخانه', t: 'pick', path: '/parties', show: showParty }]} />;
const runSpecs: FieldSpec[] = [{ k: 'factory_party_id', t: 'pick', path: '/parties', params: { role: 'factory' }, show: showParty, req: true, label: 'کارخانه' }, { k: 'service', t: 'select', opts: ['extrusion', 'smelting'], req: true }, { k: 'started_at', t: 'datetime' }, { k: 'due_at', t: 'datetime' }, { k: 'ingot_allocated_kg', t: 'num', unit: 'کیلو' }, { k: 'press', t: 'text' }, { k: 'shift', t: 'text' }, { k: 'heat_treatment', t: 'text' }, { k: 'note', t: 'textarea' }];
export function RunForm() { const { id } = useParams(); const nav = useNavigate(); const isNew = !id || id === 'new'; return <EntityForm title={isNew ? 'نوبت تولید جدید' : 'ویرایش نوبت'} path="/production-runs" id={isNew ? undefined : id} specs={runSpecs} initial={{ service: 'extrusion' }} onSaved={(r) => nav(`/production/${r.id}`)} />; }

export function RunDetail() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const r = useOne<Record<string, unknown>>(`/production-runs/${id}`);
  const ingot = useOne<{ items: Array<Record<string, unknown>> }>(`/production-runs/${id}/ingot`);
  const bundles = useList<Record<string, unknown>>('/bundles', { production_run_id: id });
  const { form: ln, set: setLn, setForm: setLnForm } = useForm({ product_id: null, die_id: null, filler_mm: null, length_m: null, target_kg: null, target_bars: null });
  const addLine = useAct<Record<string, unknown>>('POST', `/production-runs/${id}/lines`, { onSuccess: () => { setLnForm({ product_id: null, die_id: null, filler_mm: null, length_m: null, target_kg: null, target_bars: null }); void qc.invalidateQueries(); } });
  if (!r.data) return <p className="muted">…</p>;
  const x = r.data;
  const version = Number(x.version);
  const lines = (x.lines as Array<Record<string, unknown>>) ?? [];
  const sum = (x.bundle_summary as { good_kg: string; rejected_kg: string; bundle_count: number; per_product?: Array<{ product_name: string; kg: string; count: number }> } | undefined);
  const bal = x.balance as { diff_kg?: string; diff_percent?: string; ok?: boolean; unexplained_kg?: string } | undefined;
  const refresh = () => void qc.invalidateQueries();
  return (
    <div className="stack">
      <Back to="/production">نوبت‌های تولید</Back>
      <div className="row between"><h1>نوبت {fa(String(x.number))} — {String(x.factory_name ?? '')}</h1><div className="row"><Status s={String(x.status)} map={RUN_STATUS} />{x.status === 'open' && <Link className="btn" to={`/production/${id}/edit`}>ویرایش</Link>}<Link className="btn primary" to={`/bundles/new?run=${id}`}>+ بندیل</Link></div></div>
      <div className="card"><Details r={x} keys={['service', 'started_at', 'due_at', 'ingot_allocated_kg', 'ingot_consumed_kg', 'good_kg', 'rejected_kg', 'scrap_kg', 'returned_material_kg', 'unexplained_kg', 'press', 'shift', 'heat_treatment', 'scrap_owner', 'weight_basis', 'close_reason', 'closed_at', 'note']} />
        {can('finance.view') && <div className="row" style={{ marginTop: 6 }}><span className="badge">نرخ: {x.rate_per_kg ? money(x.rate_per_kg, String(x.rate_currency)) : 'ندارد (سند اجرت ناقص می‌شود)'}</span>{x.fee_document_id ? <Link className="badge ok" to={`/documents/${x.fee_document_id}`}>سند اجرت</Link> : null}{x.shortage_document_id ? <Link className="badge warn" to={`/documents/${x.shortage_document_id}`}>سند کسری شمش</Link> : null}</div>}
      </div>
      <div className="card"><h2>ردیف‌های تولید</h2>
        <Table head={['محصول', 'قالب', 'فیلر', 'طول', 'هدف (کیلو)', 'هدف (شاخه)', 'سفارش']} rows={lines.map((l) => [`${String(l.product_code ?? '')} ${String(l.product_name ?? '')}`, String(l.die_code ?? '—'), l.filler_mm ? num(l.filler_mm, 'filler') : '—', l.length_m ? num(l.length_m, 'length') : '—', l.target_kg ? num(l.target_kg, 'weight') : '—', l.target_bars == null ? '—' : fa(String(l.target_bars)), l.order_number ? <Link to={`/orders/${l.order_id}`}>{fa(String(l.order_number))}</Link> : '—'])} />
        {x.status === 'open' && <div className="grid2" style={{ marginTop: 8 }}>
          <FieldEditor spec={{ k: 'product_id', t: 'pick', path: '/products', show: showProduct, req: true }} form={ln} set={setLn} /><FieldEditor spec={{ k: 'die_id', t: 'pick', path: '/dies', show: (d) => `${d.code} ${d.name ?? ''}` }} form={ln} set={setLn} />
          <FieldEditor spec={{ k: 'filler_mm', t: 'num' }} form={ln} set={setLn} /><FieldEditor spec={{ k: 'length_m', t: 'num' }} form={ln} set={setLn} /><FieldEditor spec={{ k: 'target_kg', t: 'num', label: 'هدف (کیلو)' }} form={ln} set={setLn} /><FieldEditor spec={{ k: 'target_bars', t: 'int', label: 'هدف (شاخه)' }} form={ln} set={setLn} />
          <div className="row" style={{ alignItems: 'end' }}><button className="btn" disabled={!ln.product_id || addLine.isPending} onClick={() => addLine.mutate(ln)}>+ ردیف</button></div>
          {addLine.error && <div className="alert danger">{addLine.error.message}</div>}
        </div>}
      </div>
      <div className="card"><h2>بندیل‌های این نوبت (R23)</h2>
        {sum && <div className="row" style={{ marginBottom: 6 }}><span className="badge ok">سالم {num(sum.good_kg, 'weight')} کیلو</span><span className="badge danger">مردودی {num(sum.rejected_kg, 'weight')}</span><span className="badge">{fa(String(sum.bundle_count))} بندیل</span>{bal && <span className={`badge ${bal.ok === false ? 'warn' : ''}`}>توازن R08: اختلاف {bal.diff_kg ? num(bal.diff_kg, 'weight') : '—'} کیلو {bal.diff_percent ? `(${num(bal.diff_percent, 'percent')}٪)` : ''}</span>}</div>}
        <Table head={['کد', 'محصول', 'وزن', 'وضعیت', 'مکان']} rows={bundles.items.map((b) => [<Link to={`/bundles/${b.id}`}>{fa(String(b.code))}</Link>, ((b.lines as Array<{ product_code?: string }>) ?? []).map((l) => l.product_code).join('/'), num(b.weight_kg, 'weight'), ev(b.status), String(b.location_name ?? '')])} />
      </div>
      {x.status === 'open' && (
        <div className="card"><h2>بستن نوبت</h2>
          <p className="muted">شمش ویترال در این مکان: {(ingot.data?.items ?? []).map((i) => `${String(i.description ?? i.alloy ?? 'شمش')}: ${num(i.kg, 'weight')}`).join('، ') || '—'}</p>
          <Action label="بستن نوبت (R08)" perm="technical.approve" path={`/production-runs/${id}/close`} version={version} onDone={refresh} fields={[{ k: 'ingot_consumed_kg', t: 'num', unit: 'کیلو', req: true, label: 'شمش مصرفی' }, { k: 'scrap_kg', t: 'num', unit: 'کیلو', label: 'ضایعات' }, { k: 'returned_material_kg', t: 'num', unit: 'کیلو', label: 'شمش برگشتی' }, { k: 'rework_cost', t: 'num', label: 'هزینه بازکاری' }, { k: 'close_reason', t: 'textarea', label: 'توضیح اختلاف' }]} />
        </div>
      )}
    </div>
  );
}

// ───────── Coating runs ─────────
const COAT_STATUS: Record<string, [string, string?]> = { open: ['نزد رنگکار', 'warn'], partially_returned: ['برگشت ناقص', 'warn'], returned: ['برگشته', 'ok'], closed: ['بسته'] };
export const CoatingPage = () => <ListPage title="نوبت‌های رنگ / آنادایز" path="/coating-runs" newTo="/coating/new" rowTo={(r) => `/coating/${r.id}`} cols={[{ k: 'number' }, { k: 'party_name', l: 'رنگکار' }, { k: 'service' }, { k: 'color_code' }, { k: 'sent_at', l: 'ارسال' }, { k: 'totals', l: 'خام (کیلو)', f: (v) => num((v as { raw_kg?: string })?.raw_kg, 'weight') }, { k: 'status', f: (v) => <Status s={String(v)} map={COAT_STATUS} /> }]} filters={[{ k: 'status', l: 'وضعیت', t: 'select', opts: Object.keys(COAT_STATUS) }, { k: 'party_id', l: 'رنگکار', t: 'pick', path: '/parties', show: showParty }]} />;

/** Send bundles to a painter: pick raw bundles, the run and the to_coating transfer are created together. */
export function CoatingForm() {
  const nav = useNavigate();
  const { form, set } = useForm({ party_id: null, service: 'paint', color_code: null, due_at: null, includes_material: null, material_lot_id: null, material_units: null, input_basis: 'bundle_sum', input_basis_kg: null, basis_reason: null, note: null });
  const [ids, setIds] = useState<string[]>([]);
  const [q, setQ] = useState('');
  const avail = useList<Record<string, unknown>>('/bundles', { form: 'raw', status: 'ok', draft: 'false', q: q || undefined }, { limit: 100 });
  const act = useAct<Record<string, unknown>, { id: string }>('POST', '/coating-runs', { onSuccess: (r) => nav(`/coating/${r.id}`) });
  const specs: FieldSpec[] = [{ k: 'party_id', t: 'pick', path: '/parties', params: { role: 'painter' }, show: showParty, req: true, label: 'رنگکار / آنادایزکار' }, { k: 'service', t: 'select', opts: ['paint', 'anodize'], req: true }, { k: 'color_code', t: 'text' }, { k: 'due_at', t: 'datetime' }, { k: 'includes_material', t: 'bool', label: 'نرخ شامل پودر رنگ است' }, { k: 'material_lot_id', t: 'pick', path: '/material-lots', params: { kind: 'paint_powder' }, show: (r) => `${r.description ?? ''} ${r.batch_no ?? ''}`, label: 'پارت پودر رنگ (اگر ویترال می‌دهد)', hidden: (f) => f.includes_material === true }, { k: 'material_units', t: 'num', unit: 'کارتن', hidden: (f) => f.includes_material === true }, { k: 'input_basis', t: 'select', opts: ['bundle_sum', 'scale_ticket', 'agreed'], req: true }, { k: 'input_basis_kg', t: 'num', unit: 'کیلو', hidden: (f) => f.input_basis === 'bundle_sum' }, { k: 'basis_reason', t: 'text', hidden: (f) => f.input_basis === 'bundle_sum' }, { k: 'note', t: 'textarea' }];
  const sel = avail.items.filter((b) => ids.includes(String(b.id)));
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); act.mutate({ ...form, bundle_ids: ids }); }}>
      <Back to="/coating">نوبت‌های رنگ</Back><h1>ارسال به رنگ / آنادایز</h1>
      <ConflictBanner err={act.error} fields={L} />
      <div className="card"><div className="grid2">{specs.map((s) => <FieldEditor key={s.k} spec={s} form={form} set={set} error={act.error?.fields?.[s.k]} />)}</div></div>
      <div className="card"><h2>بندیل‌های خام ({fa(ids.length)} انتخاب‌شده، {num(sel.reduce((a, b) => a + Number(b.weight_kg), 0).toFixed(3), 'weight')} کیلو)</h2>
        <input placeholder="جستجوی کد" value={q} onChange={(e) => setQ(e.target.value)} />
        <Table head={['', 'کد', 'محصول', 'وزن', 'مکان']} rows={avail.items.map((b) => [<input type="checkbox" checked={ids.includes(String(b.id))} onChange={(e) => setIds(e.target.checked ? [...ids, String(b.id)] : ids.filter((x) => x !== b.id))} />, fa(String(b.code)), ((b.lines as Array<{ product_code?: string }>) ?? []).map((l) => l.product_code).join('/'), num(b.weight_kg, 'weight'), String(b.location_name ?? '')])} />
      </div>
      <div className="row"><button className="btn primary" disabled={!ids.length || act.isPending} type="submit">ارسال</button><button className="btn" type="button" onClick={() => nav(-1)}>انصراف</button></div>
    </form>
  );
}

export function CoatingDetail() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const r = useOne<Record<string, unknown>>(`/coating-runs/${id}`);
  const [ret, setRet] = useState<Record<string, { coated_kg: string | null; bars_returned: number | null; qc: string }>>({});
  const doReturn = useAct<Record<string, unknown>>('POST', `/coating-runs/${id}/return`, { onSuccess: () => { setRet({}); void qc.invalidateQueries(); } });
  if (!r.data) return <p className="muted">…</p>;
  const x = r.data;
  const version = Number(x.version);
  const items = (x.items as Array<Record<string, unknown>>) ?? [];
  const totals = x.totals as Record<string, unknown> | undefined;
  const refresh = () => void qc.invalidateQueries();
  const pending = items.filter((i) => i.coated_kg === null);
  return (
    <div className="stack">
      <Back to="/coating">نوبت‌های رنگ</Back>
      <div className="row between"><h1>نوبت رنگ {fa(String(x.number))} — {String(x.party_name ?? '')}</h1><Status s={String(x.status)} map={COAT_STATUS} /></div>
      <div className="card"><Details r={x} keys={['service', 'color_code', 'sent_at', 'due_at', 'input_basis', 'input_basis_kg', 'basis_reason', 'includes_material', 'material_units', 'closed_at', 'note']} />
        {totals && <div className="row" style={{ marginTop: 6 }}><span className="badge">خام {num(totals.raw_kg, 'weight')}</span>{totals.coated_kg ? <span className="badge ok">پوشش‌شده {num(totals.coated_kg, 'weight')}</span> : null}{totals.gain_percent ? <span className="badge">اضافه‌وزن {num(totals.gain_percent, 'percent')}٪</span> : null}{can('finance.view') && totals.fee ? <span className="badge">اجرت {money(totals.fee, String(x.rate_currency))}</span> : null}{can('finance.view') && x.fee_document_id ? <Link className="badge ok" to={`/documents/${x.fee_document_id}`}>سند اجرت</Link> : null}{x.transfer_id ? <Link className="badge" to={`/transfers/${x.transfer_id}`}>حواله ارسال</Link> : null}</div>}
      </div>
      <div className="card"><h2>بندیل‌ها</h2>
        <Table head={['کد', 'خام', 'پوشش‌شده', 'افزایش', 'کیفیت', 'برگشت']} rows={items.map((i) => { const g = i.gain as { percent?: string } | null; return [<Link to={`/bundles/${i.bundle_id}`}>{fa(String(i.bundle_code))}</Link>, num(i.raw_kg, 'weight'), i.coated_kg === null ? <span className="row"><NumInput value={ret[String(i.id)]?.coated_kg ?? null} unit="کیلو" onChange={(v) => setRet({ ...ret, [String(i.id)]: { coated_kg: v, bars_returned: ret[String(i.id)]?.bars_returned ?? null, qc: ret[String(i.id)]?.qc ?? 'ok' } })} /><select value={ret[String(i.id)]?.qc ?? 'ok'} onChange={(e) => setRet({ ...ret, [String(i.id)]: { coated_kg: ret[String(i.id)]?.coated_kg ?? null, bars_returned: null, qc: e.target.value } })}><option value="ok">سالم</option><option value="needs_review">نیاز به بررسی</option><option value="rejected">مردود</option></select></span> : num(i.coated_kg, 'weight'), g?.percent ? <span className={i.gain_needs_review ? 'warnbox' : ''}>{num(g.percent, 'percent')}٪{i.gain_needs_review ? ' ⚠' : ''}</span> : '—', ev(i.qc), i.returned_at ? jdt(String(i.returned_at)) : '—']; })} />
        {pending.length > 0 && <div className="row" style={{ marginTop: 8 }}><button className="btn primary" disabled={doReturn.isPending || !Object.values(ret).some((v) => v.coated_kg)} onClick={() => doReturn.mutate({ version, items: Object.entries(ret).filter(([, v]) => v.coated_kg).map(([item_id, v]) => ({ item_id, coated_kg: v.coated_kg, bars_returned: v.bars_returned, qc: v.qc })) })}>ثبت برگشت از رنگ (R06)</button></div>}
        <ConflictBanner err={doReturn.error} fields={L} />
      </div>
      {x.status !== 'closed' && <div className="card"><h2>اقدام‌ها</h2><div className="row">
        <Action label="تعیین مبنای وزن اجرت (R05)" perm="technical.approve" path={`/coating-runs/${id}/basis`} version={version} onDone={refresh} fields={[{ k: 'input_basis', t: 'select', opts: ['bundle_sum', 'scale_ticket', 'agreed'], req: true }, { k: 'input_basis_kg', t: 'num', unit: 'کیلو' }, { k: 'basis_reason', t: 'text' }]} />
        <Action label="بستن نوبت و صدور اجرت" perm="technical.approve" path={`/coating-runs/${id}/close`} version={version} onDone={refresh} fields={[{ k: 'reason', t: 'text', label: 'توضیح (اگر بندیلی برنگشته)' }]} />
      </div></div>}
    </div>
  );
}
