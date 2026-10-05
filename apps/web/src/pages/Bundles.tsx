import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Action, Details, E, ev, FieldEditor, L, ListPage, showLocation, showParty, showProduct, useForm, type FieldSpec } from '../components/entity.js';
import { Back, ConflictBanner, FileUpload, NumInput, PdfButtons, Picker, Status, Table, Thumb, fa, jdt, num } from '../components/ui.js';
import { useAuth } from '../lib/auth.js';
import { useAct, useOne, newRequestIdSafe } from '../lib/hooks.js';
import { flushQueue, queue, type QueuedBundle } from '../lib/offline.js';
import { API, isOffline } from '../api/client.js';

const STATUS: Record<string, [string, string?]> = { ok: ['سالم', 'ok'], damaged: ['آسیب‌دیده', 'danger'], wrong_product: ['محصول اشتباه', 'danger'], pending_review: ['در انتظار بررسی', 'warn'], scrapped: ['ضایعات شد'], consumed: ['مصرف شد'] };
export const BundlesPage = () => <ListPage title="بندیل‌ها" path="/bundles" newTo="/bundles/new" rowTo={(r) => `/bundles/${r.id}`}
  cols={[{ k: 'code', f: (v, r) => <>{fa(String(v))}{r.code_is_temp ? <span className="badge warn" style={{ marginInlineStart: 4 }}>موقت</span> : null}{r.draft ? <span className="badge" style={{ marginInlineStart: 4 }}>پیش‌نویس</span> : null}</> }, { k: 'lines', l: 'محصول', f: (v) => ((v as Array<{ product_name?: string; product_code?: string }>) ?? []).map((l) => l.product_code ?? l.product_name).join(' / ') || '—' }, { k: 'weight_kg' }, { k: 'form' }, { k: 'status', f: (v) => <Status s={String(v)} map={STATUS} /> }, { k: 'location_name' }, { k: 'reported_at' }]}
  filters={[{ k: 'q', l: 'کد', t: 'text' }, { k: 'status', l: 'وضعیت', t: 'select', opts: Object.keys(STATUS) }, { k: 'form', l: 'شکل', t: 'select', opts: ['raw', 'painted', 'anodized'] }, { k: 'location_id', l: 'مکان', t: 'pick', path: '/locations', show: showLocation }, { k: 'product_id', l: 'محصول', t: 'pick', path: '/products', show: showProduct }, { k: 'quarantine', l: 'قرنطینه', t: 'bool' }, { k: 'available', l: 'آزاد برای فروش', t: 'bool' }]} />;

type Line = { product_id: string | null; filler_mm: string | null; length_m: string | null; bars: number | null; weight_kg: string | null; order_line_id?: string | null };
const emptyLine = (): Line => ({ product_id: null, filler_mm: null, length_m: null, bars: null, weight_kg: null });

/** Bundle entry form (spec §13): fast, offline-capable; photos queue with the entry; temp code when offline. */
export function BundleForm() {
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const { form, set } = useForm({ production_run_id: sp.get('run') ?? null, location_id: null, factory_party_id: null, code: null, weight_kg: null, packaging_kg: null, form: 'raw', color: null, source: 'production', draft: false, note: null });
  const [lines, setLines] = useState<Line[]>([emptyLine()]);
  const [photos, setPhotos] = useState<Array<{ name: string; blob: Blob }>>([]);
  const [queued, setQueued] = useState<QueuedBundle[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const qc = useQueryClient();
  const refreshQueue = () => void queue.list().then(setQueued).catch(() => setQueued([]));
  useEffect(() => { refreshQueue(); const on = () => void flushQueue().then((r) => { refreshQueue(); if (r.sent) setMsg(`${fa(r.sent)} بندیل صف‌شده ارسال شد`); }); window.addEventListener('online', on); return () => window.removeEventListener('online', on); }, []);
  const act = useAct<Record<string, unknown>, { id: string; code: string }>('POST', '/bundles', { onSuccess: async (r) => { for (const p of photos) { const fd = new FormData(); fd.set('kind', 'bundle'); fd.set('owner_entity', 'bundles'); fd.set('owner_id', r.id); fd.set('file', p.blob, p.name); await fetch(`${API}/files`, { method: 'POST', body: fd, headers: { 'X-Requested-With': 'vitral', 'Idempotency-Key': newRequestIdSafe() } }); } void qc.invalidateQueries(); nav(`/bundles/${r.id}`); } });
  const body = () => ({ ...form, lines: lines.filter((l) => l.product_id).map((l) => ({ ...l, bars: l.bars == null ? null : Number(l.bars) })) });
  const submit = async () => {
    if (isOffline()) { await queue.add(body(), photos); setMsg('اینترنت نیست؛ بندیل در صف ذخیره شد و با اتصال ارسال می‌شود. کد موقت بعداً صادر می‌شود.'); setLines([emptyLine()]); set('weight_kg', null); setPhotos([]); refreshQueue(); return; }
    act.mutate(body());
  };
  const sumLines = lines.reduce((a, l) => a + Number(l.weight_kg ?? 0), 0);
  const specs: FieldSpec[] = [
    { k: 'production_run_id', t: 'pick', path: '/production-runs', params: { status: 'open' }, show: (r) => `${r.number} — ${r.factory_name ?? ''}`, label: 'نوبت تولید', onPick: (r) => ({ factory_party_id: r?.factory_party_id ?? null, location_id: r?.location_id ?? null }) },
    { k: 'location_id', t: 'pick', path: '/locations', show: showLocation, label: 'مکان (خالی = مکان نوبت/انبار)' }, { k: 'factory_party_id', t: 'pick', path: '/parties', params: { role: 'factory' }, show: showParty, label: 'کارخانه' },
    { k: 'code', t: 'ltr', label: 'کد (خالی = کد موقت)' }, { k: 'weight_kg', t: 'num', unit: 'کیلو', req: true }, { k: 'packaging_kg', t: 'num', unit: 'کیلو' }, { k: 'form', t: 'select', opts: ['raw', 'painted', 'anodized'], req: true }, { k: 'color', t: 'text', hidden: (f) => f.form === 'raw' }, { k: 'source', t: 'select', opts: ['production', 'purchase', 'opening', 'return'], req: true }, { k: 'draft', t: 'bool', label: 'پیش‌نویس (بعداً نهایی می‌شود)' }, { k: 'note', t: 'textarea' },
  ];
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <Back to="/bundles">بندیل‌ها</Back>
      <h1>بندیل جدید</h1>
      {msg && <div className="alert ok">{msg}</div>}
      {queued.length > 0 && <div className="alert warn">{fa(queued.length)} بندیل در صف آفلاین است. <button type="button" className="btn" onClick={() => void flushQueue().then(refreshQueue)}>ارسال اکنون</button>{queued.filter((q) => q.error).map((q) => <div key={q.id} className="error">{String(q.body.weight_kg)} کیلو: {q.error} <button type="button" className="btn" onClick={() => void queue.remove(q.id).then(refreshQueue)}>حذف</button></div>)}</div>}
      <ConflictBanner err={act.error} fields={L} />
      <div className="card"><div className="grid2">{specs.map((s) => <FieldEditor key={s.k} spec={s} form={form} set={set} error={act.error?.fields?.[s.k]} />)}</div></div>
      <div className="card"><h2>ردیف‌ها (محصول، فیلر، طول، شاخه)</h2>
        {lines.map((l, i) => (
          <div key={i} className="grid2" style={{ borderBottom: '1px solid var(--border)', paddingBottom: 6, marginBottom: 6 }}>
            <label className="field"><span>محصول<b className="req">*</b></span><Picker path="/products" value={l.product_id} label={showProduct as (r: { id: string }) => string} onChange={(id, row) => { const r = row as Record<string, unknown> | null; const fl = (r?.fillers as Array<{ filler_mm: string }> | undefined)?.[0]; setLines(lines.map((x, j) => (j === i ? { ...x, product_id: id, filler_mm: x.filler_mm ?? fl?.filler_mm ?? null } : x))); }} /></label>
            <label className="field"><span>فیلر (mm)</span><NumInput value={l.filler_mm} onChange={(v) => setLines(lines.map((x, j) => (j === i ? { ...x, filler_mm: v } : x)))} /></label>
            <label className="field"><span>طول (متر)</span><NumInput value={l.length_m} onChange={(v) => setLines(lines.map((x, j) => (j === i ? { ...x, length_m: v } : x)))} /></label>
            <label className="field"><span>تعداد شاخه</span><NumInput value={l.bars == null ? null : String(l.bars)} onChange={(v) => setLines(lines.map((x, j) => (j === i ? { ...x, bars: v == null ? null : Number(v) } : x)))} /></label>
            <label className="field"><span>وزن ردیف (کیلو) — برای بندیل مخلوط</span><NumInput value={l.weight_kg} onChange={(v) => setLines(lines.map((x, j) => (j === i ? { ...x, weight_kg: v } : x)))} /></label>
            <div className="row" style={{ alignItems: 'end' }}>{lines.length > 1 && <button type="button" className="btn danger" onClick={() => setLines(lines.filter((_, j) => j !== i))}>حذف ردیف</button>}</div>
          </div>
        ))}
        <div className="row"><button type="button" className="btn" onClick={() => setLines([...lines, emptyLine()])}>+ ردیف (بندیل مخلوط)</button>{lines.length > 1 && <span className="muted">جمع ردیف‌ها: {num(sumLines.toFixed(3), 'weight')} کیلو{form.weight_kg && Math.abs(sumLines - Number(form.weight_kg)) > 0.0005 ? ' ≠ وزن بندیل' : ''}</span>}</div>
      </div>
      <div className="card"><h2>عکس</h2><div className="row"><label className="btn">📷 گرفتن عکس<input type="file" accept="image/*" capture="environment" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) setPhotos([...photos, { name: f.name, blob: f }]); e.target.value = ''; }} /></label><label className="btn">از گالری<input type="file" accept="image/*" multiple hidden onChange={(e) => { setPhotos([...photos, ...Array.from(e.target.files ?? []).map((f) => ({ name: f.name, blob: f }))]); e.target.value = ''; }} /></label>{photos.map((p, i) => <span key={i} className="badge">{p.name} <button type="button" className="btn" style={{ minHeight: 24, padding: '0 6px' }} onClick={() => setPhotos(photos.filter((_, j) => j !== i))}>×</button></span>)}</div></div>
      <div className="row"><button className="btn primary" type="submit" disabled={act.isPending}>{act.isPending ? 'در حال ثبت…' : 'ثبت بندیل'}</button><button className="btn" type="button" onClick={() => nav(-1)}>انصراف</button></div>
    </form>
  );
}

export function BundleDetail() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const b = useOne<Record<string, unknown>>(`/bundles/${id}`);
  const files = useOne<{ items: Array<{ id: string; mime: string }> }>(`/bundles/${id}/files`);
  const [editW, setEditW] = useState<string | null>(null);
  const patch = useAct<Record<string, unknown>>('PATCH', `/bundles/${id}`, { onSuccess: () => { setEditW(null); void qc.invalidateQueries(); } });
  const del = useAct<Record<string, unknown>>('DELETE', `/bundles/${id}`, { onSuccess: () => history.back() });
  const attach = useAct<Record<string, unknown>>('POST', `/bundles/${id}/files`, { onSuccess: () => void qc.invalidateQueries() });
  if (!b.data) return <p className="muted">…</p>;
  const r = b.data;
  const version = Number(r.version);
  const refresh = () => void qc.invalidateQueries();
  const warnings = (r.warnings as Array<{ code?: string; message?: string }>) ?? [];
  const lines = (r.lines as Array<Record<string, unknown>>) ?? [];
  const moves = (r.moves as Array<Record<string, unknown>>) ?? [];
  const inQuarantine = ['damaged', 'wrong_product', 'pending_review'].includes(String(r.status)) && !r.decision;
  return (
    <div className="stack">
      <Back to="/bundles">بندیل‌ها</Back>
      <div className="row between"><h1>بندیل {fa(String(r.code))} {r.code_is_temp ? <span className="badge warn">کد موقت</span> : null} {r.draft ? <span className="badge">پیش‌نویس</span> : null}</h1><Status s={String(r.status)} map={STATUS} /></div>
      {warnings.length > 0 && <div className="alert warn">{warnings.map((w, i) => <div key={i}>⚠ {w.message ?? w.code}</div>)}</div>}
      <div className="card"><Details r={r} keys={['weight_kg', 'packaging_kg', 'raw_weight_kg', 'form', 'color', 'location_name', 'run_number', 'source', 'reserved_kg', 'free_kg', 'measured_filler_mm', 'measured_length_m', 'defect', 'qc_note', 'decision', 'decision_note', 'note', 'reported_at']} />
        <Table head={['محصول', 'فیلر', 'طول', 'شاخه', 'وزن', 'گرم/متر']} rows={lines.map((l) => { const lw = l.weight_kg ?? (lines.length === 1 && r.weight_kg != null ? (Number(r.weight_kg) - Number(r.packaging_kg ?? 0)).toFixed(3) : null); const gpm = l.g_per_m ?? (lw && l.bars && l.length_m ? ((Number(lw) * 1000) / (Number(l.bars) * Number(l.length_m))).toFixed(1) : null); return [`${String(l.product_code ?? '')} ${String(l.product_name ?? '')}`, l.filler_mm ? num(l.filler_mm, 'filler') : '—', l.length_m ? num(l.length_m, 'length') : '—', l.bars == null ? '—' : fa(String(l.bars)), lw ? num(lw, 'weight') : '—', gpm ? num(gpm, 'g_per_m') : '—']; })} />
      </div>
      <div className="card"><h2>اقدام‌ها</h2>
        <ConflictBanner err={patch.error ?? del.error} fields={L} />
        <div className="row">
          {r.draft ? <><Action label="نهایی‌سازی" path={`/bundles/${id}/finalize`} version={version} onDone={refresh} /><button className="btn danger" onClick={() => del.mutate({})}>حذف پیش‌نویس</button></> : null}
          {!inQuarantine && String(r.status) === 'ok' && <Action label="ارسال به قرنطینه" path={`/bundles/${id}/quarantine`} version={version} onDone={refresh} fields={[{ k: 'status', t: 'select', opts: ['damaged', 'wrong_product', 'pending_review'], req: true }, { k: 'defect', t: 'text' }, { k: 'measured_filler_mm', t: 'num' }, { k: 'measured_length_m', t: 'num' }, { k: 'qc_note', t: 'textarea' }]} />}
          {inQuarantine && <Action label="تصمیم قرنطینه" perm="technical.approve" path={`/bundles/${id}/decide`} version={version} onDone={refresh} fields={[{ k: 'decision', t: 'select', opts: ['accept', 'rework', 'discount_sale', 'scrap'], req: true }, { k: 'note', t: 'textarea' }]} />}
          {editW === null ? <button className="btn" onClick={() => setEditW(String(r.weight_kg))}>اصلاح وزن</button> : <span className="row"><NumInput value={editW} onChange={(v) => setEditW(v ?? '')} unit="کیلو" /><input placeholder="دلیل (برای بندیل نهایی لازم است)" id="wreason" /><button className="btn primary" onClick={() => patch.mutate({ version, weight_kg: editW, reason: (document.getElementById('wreason') as HTMLInputElement).value || undefined })}>ثبت</button><button className="btn" onClick={() => setEditW(null)}>انصراف</button></span>}
          <SplitAction id={id} version={version} weight={String(r.weight_kg)} onDone={refresh} />
          <PdfButtons path={`/bundles/${id}/label`} name={`label-${r.code}`} langs={['fa']} />
        </div>
      </div>
      <div className="card"><h2>عکس‌ها</h2><div className="row">{(files.data?.items ?? []).filter((f) => f.mime.startsWith('image/')).map((f) => <Thumb key={f.id} id={f.id} size={96} />)}<FileUpload kind="bundle" owner={{ entity: 'bundles', id }} capture label="📷 عکس" accept="image/*" onDone={(f) => attach.mutate({ file_ids: [f.id] })} /></div></div>
      {moves.length > 0 && <div className="card"><h2>گردش انبار</h2><Table head={['زمان', 'از', 'به', 'کیلو', 'حالت', 'مرجع']} rows={moves.map((m) => [jdt(String(m.at)), String(m.from_name ?? '—'), String(m.to_name ?? '—'), num(m.kg, 'weight'), `${ev(m.state_from)} → ${ev(m.state_to)}`, ev(m.ref_type)])} /></div>}
      {can('technical.approve') && r.production_run_id ? <Link className="muted" to={`/production/${r.production_run_id}`}>نوبت تولید {fa(String(r.run_number ?? ''))}</Link> : null}
    </div>
  );
}

function SplitAction({ id, version, weight, onDone }: { id: string; version: number; weight: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [parts, setParts] = useState<Array<{ weight_kg: string | null; bars: number | null }>>([{ weight_kg: null, bars: null }, { weight_kg: null, bars: null }]);
  const act = useAct<Record<string, unknown>>('POST', `/bundles/${id}/split`, { onSuccess: () => { setOpen(false); onDone(); } });
  if (!open) return <button className="btn" onClick={() => setOpen(true)}>تفکیک</button>;
  const sum = parts.reduce((a, p) => a + Number(p.weight_kg ?? 0), 0);
  return <div className="modal-bg" onClick={() => setOpen(false)}><div className="modal card" onClick={(e) => e.stopPropagation()}><h2>تفکیک بندیل ({num(weight, 'weight')} کیلو)</h2><ConflictBanner err={act.error} fields={L} />
    {parts.map((p, i) => <div key={i} className="row"><NumInput value={p.weight_kg} unit="کیلو" onChange={(v) => setParts(parts.map((x, j) => (j === i ? { ...x, weight_kg: v } : x)))} /><NumInput value={p.bars == null ? null : String(p.bars)} unit="شاخه" onChange={(v) => setParts(parts.map((x, j) => (j === i ? { ...x, bars: v == null ? null : Number(v) } : x)))} /></div>)}
    <div className="row"><button className="btn" onClick={() => setParts([...parts, { weight_kg: null, bars: null }])}>+ قسمت</button><span className={`muted ${Math.abs(sum - Number(weight)) > 0.0005 ? 'error' : ''}`}>جمع: {num(sum.toFixed(3), 'weight')}</span></div>
    <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn" onClick={() => setOpen(false)}>انصراف</button><button className="btn primary" disabled={act.isPending} onClick={() => act.mutate({ version, parts })}>تفکیک</button></div></div></div>;
}

export { E };
