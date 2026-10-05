import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Action, Details, E, EntityForm, ev, FieldEditor, L, ListPage, showLocation, showParty, showProduct, useForm, type FieldSpec } from '../components/entity.js';
import { Back, ConflictBanner, FileUpload, JalaliInput, MoreButton, NumInput, Picker, Select, Status, Table, Tabs, fa, jdt, money, num } from '../components/ui.js';
import { useAuth } from '../lib/auth.js';
import { useAct, useList, useOne } from '../lib/hooks.js';
import { STATE_FA } from './Home.js';

type Pos = { location_id: string; location_name: string; location_kind: string; item_type: 'bundle' | 'material_lot'; item_id: string; kg: string; state: string | null; owner_party_id: string | null; bundle?: Record<string, unknown>; lot?: Record<string, unknown> };

/** «Where is the weight»: positions from the ledger, grouped per location/state; moves log; opening & count adjustments. */
export function StockPage() {
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const [tab, setTab] = useState<'positions' | 'available' | 'moves'>('positions');
  const filt = { location_id: sp.get('location_id') ?? undefined, state: sp.get('state') ?? undefined, item_type: sp.get('item_type') ?? undefined, product_id: sp.get('product_id') ?? undefined };
  const pos = useOne<{ items: Pos[] }>(tab === 'positions' ? `/stock/positions?${new URLSearchParams(Object.entries(filt).filter(([, v]) => v) as string[][]).toString()}` : null);
  const avail = useOne<{ items: Array<Record<string, unknown>> }>(tab === 'available' ? '/stock/available' : null);
  const moves = useList<Record<string, unknown>>('/stock/moves', { location_id: filt.location_id, item_type: filt.item_type }, { enabled: tab === 'moves' });
  const setF = (k: string, v: string | null) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); setSp(n, { replace: true }); };
  const groups = new Map<string, { name: string; kind: string; kg: number; states: Record<string, number>; items: Pos[] }>();
  for (const p of pos.data?.items ?? []) { const g = groups.get(p.location_id) ?? groups.set(p.location_id, { name: p.location_name, kind: p.location_kind, kg: 0, states: {}, items: [] }).get(p.location_id)!; g.kg += Number(p.kg); g.states[p.state ?? '?'] = (g.states[p.state ?? '?'] ?? 0) + Number(p.kg); g.items.push(p); }
  return (
    <div className="stack">
      <div className="row between"><h1>انبار — وزن کجاست</h1><div className="row">{can('inventory.adjust') && <Link className="btn" to="/stock/opening">موجودی اول دوره</Link>}{can('inventory.adjust') && <Link className="btn" to="/stock/adjust">شمارش / اصلاح</Link>}<Link className="btn" to="/materials">مواد و خرید</Link></div></div>
      <div className="toolbar card compact">
        <label className="field" style={{ margin: 0 }}><span>مکان</span><Picker path="/locations" value={filt.location_id} label={showLocation as (r: { id: string }) => string} onChange={(id) => setF('location_id', id)} /></label>
        <label className="field" style={{ margin: 0 }}><span>حالت</span><Select value={filt.state ?? ''} allowEmpty="همه" options={Object.entries(STATE_FA)} onChange={(v) => setF('state', v)} /></label>
        <label className="field" style={{ margin: 0 }}><span>نوع</span><Select value={filt.item_type ?? ''} allowEmpty="همه" options={[['bundle', 'بندیل'], ['material_lot', 'مواد']]} onChange={(v) => setF('item_type', v)} /></label>
        <label className="field" style={{ margin: 0 }}><span>محصول</span><Picker path="/products" value={filt.product_id} label={showProduct as (r: { id: string }) => string} onChange={(id) => setF('product_id', id)} /></label>
      </div>
      <Tabs value={tab} onChange={setTab} tabs={[['positions', 'موجودی به مکان'], ['available', 'آزاد برای فروش'], ['moves', 'گردش']]} />
      {tab === 'positions' && [...groups.entries()].sort((a, b) => b[1].kg - a[1].kg).map(([lid, g]) => (
        <details key={lid} className="card compact" open={groups.size <= 3}>
          <summary className="row between" style={{ cursor: 'pointer' }}><b>{g.name} <span className="muted">({ev(g.kind)})</span></b><span className="row">{Object.entries(g.states).map(([s, kg]) => <span key={s} className="badge">{STATE_FA[s] ?? s}: {num(kg.toFixed(3), 'weight')}</span>)}<b className="num">{num(g.kg.toFixed(3), 'weight')} کیلو</b></span></summary>
          <Table head={['نوع', 'کد / شرح', 'محصول', 'حالت', 'مالک', 'کیلو']} rows={g.items.map((p) => [p.item_type === 'bundle' ? 'بندیل' : ev(p.lot?.kind), p.item_type === 'bundle' ? <Link to={`/bundles/${p.item_id}`}>{fa(String(p.bundle?.code ?? ''))}</Link> : <Link to={`/materials/lots/${p.item_id}`}>{String(p.lot?.description ?? p.lot?.alloy ?? '—')}</Link>, p.item_type === 'bundle' ? String(p.bundle?.product_codes ?? p.bundle?.product_name ?? '') : '—', STATE_FA[p.state ?? ''] ?? p.state ?? '—', p.owner_party_id ? String(p.lot?.owner_name ?? 'طرف') : 'ویترال', num(p.kg, 'weight')])} />
        </details>
      ))}
      {tab === 'positions' && pos.data && groups.size === 0 && <p className="muted">موجودی‌ای نیست.</p>}
      {tab === 'available' && <div className="card"><Table head={['محصول', 'شکل', 'رنگ', 'طول', 'فیلر', 'بندیل', 'کیلو', 'آزاد (کیلو)']} rows={(avail.data?.items ?? []).map((a) => [`${String(a.product_code ?? '')} ${String(a.product_name ?? '')}`, ev(a.form), String(a.color ?? '—'), a.length_m ? num(a.length_m, 'length') : '—', a.filler_mm ? num(a.filler_mm, 'filler') : '—', fa(String(a.bundles)), num(a.kg, 'weight'), num(a.free_kg ?? a.kg, 'weight')])} /></div>}
      {tab === 'moves' && <div className="card"><Table head={['زمان', 'نوع', 'کد', 'از', 'به', 'کیلو', 'حالت', 'مرجع', 'کاربر']} rows={moves.items.map((m) => [jdt(String(m.at)), m.item_type === 'bundle' ? 'بندیل' : 'مواد', String(m.bundle_code ?? m.lot_description ?? ''), String(m.from_name ?? '—'), String(m.to_name ?? '—'), num(m.kg, 'weight'), `${STATE_FA[String(m.state_from)] ?? m.state_from ?? ''} → ${STATE_FA[String(m.state_to)] ?? m.state_to ?? ''}`, ev(m.ref_type), String(m.user_name ?? '')])} /><MoreButton list={moves} /></div>}
    </div>
  );
}

/** Opening stock (inventory.adjust): bundles and lots as of a date; locked once a later move exists. */
export function OpeningPage() {
  const nav = useNavigate();
  const { form, set } = useForm({ as_of: new Date().toISOString().slice(0, 10), location_id: null, reason: null, file_id: null });
  const [items, setItems] = useState<Array<Record<string, unknown>>>([]);
  const act = useAct<Record<string, unknown>>('POST', '/stock/opening', { onSuccess: () => nav('/stock') });
  const existing = useOne<{ items: Array<Record<string, unknown>> }>('/stock/opening', { refetchInterval: false, refetchOnWindowFocus: false });
  const upd = (i: number, p: Record<string, unknown>) => setItems(items.map((x, j) => (j === i ? { ...x, ...p } : x)));
  return (
    <div className="stack">
      <Back to="/stock">انبار</Back><h1>موجودی اول دوره</h1>
      <ConflictBanner err={act.error} fields={L} />
      <div className="card"><div className="grid2"><FieldEditor spec={{ k: 'as_of', t: 'date', req: true, label: 'تاریخ مبنا' }} form={form} set={set} /><FieldEditor spec={{ k: 'location_id', t: 'pick', path: '/locations', show: showLocation, req: true }} form={form} set={set} /><FieldEditor spec={{ k: 'reason', t: 'text', label: 'توضیح' }} form={form} set={set} /></div><FileUpload kind="other" label="فایل شمارش" onDone={(f) => set('file_id', f.id)} /></div>
      {items.map((it, i) => (
        <div key={i} className="card compact"><div className="grid2">
          <label className="field"><span>نوع</span><Select value={String(it.item_type)} options={[['bundle', 'بندیل'], ['material_lot', 'مواد']]} onChange={(v) => upd(i, { item_type: v })} /></label>
          <label className="field"><span>کیلو<b className="req">*</b></span><NumInput value={it.kg as string | null} onChange={(v) => upd(i, { kg: v })} /></label>
          <label className="field"><span>بهای واحد (اختیاری)</span><NumInput value={it.unit_cost as string | null} onChange={(v) => upd(i, { unit_cost: v })} /></label>
          {it.item_type === 'bundle' ? <>
            <label className="field"><span>کد بندیل<b className="req">*</b></span><input dir="ltr" value={String((it.bundle as Record<string, unknown>)?.code ?? '')} onChange={(e) => upd(i, { bundle: { ...(it.bundle as Record<string, unknown>), code: e.target.value } })} /></label>
            <label className="field"><span>محصول<b className="req">*</b></span><Picker path="/products" value={((it.bundle as Record<string, unknown>)?.lines as Array<{ product_id: string }> | undefined)?.[0]?.product_id ?? null} label={showProduct as (r: { id: string }) => string} onChange={(pid) => upd(i, { bundle: { ...(it.bundle as Record<string, unknown>), lines: [{ product_id: pid }] } })} /></label>
            <label className="field"><span>شکل</span><Select value={String((it.bundle as Record<string, unknown>)?.form ?? 'raw')} options={[['raw', 'خام'], ['painted', 'رنگ‌شده'], ['anodized', 'آنادایز']]} onChange={(v) => upd(i, { bundle: { ...(it.bundle as Record<string, unknown>), form: v } })} /></label>
          </> : <>
            <label className="field"><span>نوع ماده</span><Select value={String((it.lot as Record<string, unknown>)?.kind ?? 'ingot')} options={[['ingot', 'شمش'], ['billet', 'بیلت'], ['scrap', 'ضایعات'], ['paint_powder', 'پودر رنگ'], ['tool', 'ابزار']]} onChange={(v) => upd(i, { lot: { ...(it.lot as Record<string, unknown>), kind: v } })} /></label>
            <label className="field"><span>شرح</span><input value={String((it.lot as Record<string, unknown>)?.description ?? '')} onChange={(e) => upd(i, { lot: { ...(it.lot as Record<string, unknown>), description: e.target.value } })} /></label>
            <label className="field"><span>مالک (خالی = ویترال)</span><Picker path="/parties" value={((it.lot as Record<string, unknown>)?.owner_party_id as string) ?? null} label={showParty as (r: { id: string }) => string} onChange={(pid) => upd(i, { lot: { ...(it.lot as Record<string, unknown>), owner_party_id: pid } })} /></label>
          </>}
        </div><button className="btn danger" onClick={() => setItems(items.filter((_, j) => j !== i))}>حذف</button></div>
      ))}
      <div className="row"><button className="btn" onClick={() => setItems([...items, { item_type: 'bundle', kg: null, currency: 'TOMAN', bundle: { form: 'raw', lines: [] } }])}>+ بندیل</button><button className="btn" onClick={() => setItems([...items, { item_type: 'material_lot', kg: null, currency: 'TOMAN', lot: { kind: 'ingot' } }])}>+ مواد</button><button className="btn primary" disabled={!items.length || act.isPending} onClick={() => act.mutate({ ...form, items })}>ثبت موجودی اول دوره</button></div>
      {existing.data && existing.data.items.length > 0 && <div className="card"><h2>ثبت‌های قبلی</h2><Table head={['تاریخ', 'مکان', 'اقلام', 'قفل']} rows={existing.data.items.map((o) => [jdt(String(o.as_of)), String(o.location_name ?? ''), fa(String(o.item_count ?? '')), o.locked ? 'بله' : 'خیر'])} /></div>}
    </div>
  );
}

export function AdjustPage() {
  const nav = useNavigate();
  const { form, set } = useForm({ item_type: 'bundle', item_id: null, location_id: null, counted_kg: null, reason: null, file_id: null });
  const act = useAct<Record<string, unknown>>('POST', '/stock/adjust', { onSuccess: () => nav('/stock') });
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); act.mutate(form); }}>
      <Back to="/stock">انبار</Back><h1>شمارش و اصلاح موجودی</h1>
      <ConflictBanner err={act.error} fields={L} />
      <div className="card"><div className="grid2">
        <FieldEditor spec={{ k: 'item_type', t: 'select', opts: ['bundle', 'material_lot'], req: true, label: 'نوع' }} form={form} set={set} />
        {form.item_type === 'bundle' ? <FieldEditor spec={{ k: 'item_id', t: 'pick', path: '/bundles', show: (b) => `${b.code} — ${b.weight_kg} کیلو — ${b.location_name ?? ''}`, req: true, label: 'بندیل', onPick: (r) => ({ location_id: r?.location_id ?? null }) }} form={form} set={set} /> : <FieldEditor spec={{ k: 'item_id', t: 'pick', path: '/material-lots', show: (l) => `${l.description ?? l.kind} ${l.batch_no ?? ''}`, req: true, label: 'پارت مواد' }} form={form} set={set} />}
        <FieldEditor spec={{ k: 'location_id', t: 'pick', path: '/locations', show: showLocation, req: true }} form={form} set={set} />
        <FieldEditor spec={{ k: 'counted_kg', t: 'num', unit: 'کیلو', req: true, label: 'وزن شمارش‌شده' }} form={form} set={set} />
        <FieldEditor spec={{ k: 'reason', t: 'textarea', req: true }} form={form} set={set} />
      </div><FileUpload kind="other" capture accept="image/*" label="📷 عکس شمارش" onDone={(f) => set('file_id', f.id)} /></div>
      <div className="row"><button className="btn primary" type="submit" disabled={act.isPending}>ثبت اصلاح</button></div>
    </form>
  );
}

// ───────── Materials: lots, purchases, scrap sale, smelting ─────────
const LOT_KINDS = ['ingot', 'billet', 'scrap', 'paint_powder', 'tool'];
const PURCHASE_KINDS = ['ingot', 'billet', 'scrap', 'paint_powder', 'tool', 'raw_profile', 'finished_profile', 'die', 'other'];
const lotSpecs: FieldSpec[] = [{ k: 'kind', t: 'select', opts: LOT_KINDS, req: true }, { k: 'alloy', t: 'ltr' }, { k: 'grade', t: 'text' }, { k: 'batch_no', t: 'ltr' }, { k: 'owner_party_id', t: 'pick', path: '/parties', show: showParty, label: 'مالک (خالی = ویترال)' }, { k: 'unit', t: 'select', opts: ['kg', 'carton', 'piece'], req: true }, { k: 'kg_per_unit', t: 'num' }, { k: 'description', t: 'text' }, { k: 'tool_class', t: 'select', opts: ['consumable', 'equipment'], hidden: (f) => f.kind !== 'tool' }, { k: 'responsible_user_id', t: 'pick', path: '/users/directory', show: (u) => String(u.name), label: 'مسئول (ابزار)', hidden: (f) => f.kind !== 'tool' }];
export function MaterialsPage() {
  const { can } = useAuth();
  const [tab, setTab] = useState<'lots' | 'purchases'>('lots');
  return (
    <div className="stack">
      <div className="row between"><h1>مواد و خرید</h1><div className="row"><Link className="btn" to="/materials/lots/new">پارت جدید</Link><Link className="btn primary" to="/materials/purchases/new">خرید جدید</Link>{can('technical.approve') && <Link className="btn" to="/materials/smelting">ذوب ضایعات</Link>}<Link className="btn" to="/materials/scrap-sale">فروش ضایعات</Link></div></div>
      <Tabs value={tab} onChange={setTab} tabs={[['lots', 'پارت‌های مواد'], ['purchases', 'خریدها']]} />
      {tab === 'lots' && <ListPage title="" path="/material-lots" rowTo={(r) => `/materials/lots/${r.id}`} cols={[{ k: 'description', f: (v, r) => String(v ?? r.alloy ?? ev(r.kind)) }, { k: 'kind' }, { k: 'alloy' }, { k: 'batch_no' }, { k: 'owner_name', l: 'مالک', f: (v) => String(v ?? 'ویترال') }, { k: 'kg', l: 'موجود (کیلو)' }, { k: 'avg_cost', l: 'میانگین بها', f: (v, r) => (v ? money(v, String(r.currency ?? 'TOMAN')) : '—') }]} filters={[{ k: 'kind', l: 'نوع', t: 'select', opts: LOT_KINDS }, { k: 'owner_party_id', l: 'مالک', t: 'pick', path: '/parties', show: showParty }]} />}
      {tab === 'purchases' && <ListPage title="" path="/purchases" rowTo={(r) => `/materials/purchases/${r.id}`} cols={[{ k: 'number' }, { k: 'party_name' }, { k: 'purchase_kind' }, { k: 'date' }, { k: 'agreed_kg' }, { k: 'received_kg' }, { k: 'amount' }, { k: 'status', f: (v) => <Status s={String(v)} map={{ draft: ['پیش‌نویس'], reported: ['گزارش‌شده', 'warn'], posted: ['قطعی', 'ok'], needs_completion: ['ناقص', 'danger'], void: ['باطل'] }} /> }]} filters={[{ k: 'status', l: 'وضعیت', t: 'select', opts: ['draft', 'reported', 'posted', 'needs_completion'] }, { k: 'party_id', l: 'تأمین‌کننده', t: 'pick', path: '/parties', show: showParty }]} />}
    </div>
  );
}
export function LotForm() { const { id } = useParams(); const nav = useNavigate(); const isNew = !id || id === 'new'; return <EntityForm title={isNew ? 'پارت مواد جدید' : 'ویرایش پارت'} path="/material-lots" id={isNew ? undefined : id} specs={lotSpecs} initial={{ kind: 'ingot', unit: 'kg' }} onSaved={() => nav('/materials')} />; }
export function LotDetail() {
  const { id = '' } = useParams();
  const l = useOne<Record<string, unknown>>(`/material-lots/${id}`);
  const moves = useList<Record<string, unknown>>('/stock/moves', { item_type: 'material_lot', item_id: id });
  if (!l.data) return <p className="muted">…</p>;
  const r = l.data;
  return <div className="stack"><Back to="/materials">مواد</Back><div className="row between"><h1>{String(r.description ?? ev(r.kind))}</h1><Link className="btn" to={`/materials/lots/${id}/edit`}>ویرایش</Link></div>
    <div className="card"><Details r={r} keys={['kind', 'alloy', 'grade', 'batch_no', 'owner_name', 'unit', 'kg_per_unit', 'kg', 'units', 'avg_cost', 'tool_class', 'responsible_name', 'created_at']} />{Array.isArray(r.positions) && <Table head={['مکان', 'حالت', 'کیلو']} rows={(r.positions as Array<Record<string, unknown>>).map((p) => [String(p.location_name), STATE_FA[String(p.state)] ?? String(p.state), num(p.kg, 'weight')])} />}</div>
    <div className="card"><h2>گردش</h2><Table head={['زمان', 'از', 'به', 'کیلو', 'مرجع', 'بهای واحد']} rows={moves.items.map((m) => [jdt(String(m.at)), String(m.from_name ?? '—'), String(m.to_name ?? '—'), num(m.kg, 'weight'), ev(m.ref_type), m.unit_cost ? money(m.unit_cost, String(m.currency ?? 'TOMAN')) : '—'])} /><MoreButton list={moves} /></div></div>;
}

/** Purchase: material (lot created or chosen) or profiles; receive moves weight in with unit cost (R13 average). */
export function PurchaseForm() {
  const nav = useNavigate();
  const { form, set } = useForm({ party_id: null, purchase_kind: 'ingot', material_lot_id: null, lot: { kind: 'ingot' }, agreed_kg: null, unit_price: null, amount: null, currency: 'TOMAN', date: new Date().toISOString(), due_date: null, description: null, note: null, order_id: null, file_ids: [] });
  const act = useAct<Record<string, unknown>, { id: string }>('POST', '/purchases', { onSuccess: (r) => nav(`/materials/purchases/${r.id}`) });
  const isMaterial = LOT_KINDS.includes(String(form.purchase_kind));
  const specs: FieldSpec[] = [{ k: 'party_id', t: 'pick', path: '/parties', show: showParty, req: true, label: 'تأمین‌کننده' }, { k: 'purchase_kind', t: 'select', opts: PURCHASE_KINDS, req: true }, { k: 'material_lot_id', t: 'pick', path: '/material-lots', show: (l) => `${l.description ?? l.kind} ${l.batch_no ?? ''}`, label: 'پارت موجود (خالی = پارت جدید)', hidden: () => !isMaterial }, { k: 'agreed_kg', t: 'num', unit: 'کیلو' }, { k: 'unit_price', t: 'num', label: 'قیمت هر کیلو' }, { k: 'amount', t: 'num', label: 'مبلغ کل (خالی = وزن × قیمت)' }, { k: 'currency', t: 'select', opts: ['TOMAN', 'USD', 'IQD'], req: true }, { k: 'date', t: 'datetime' }, { k: 'due_date', t: 'datetime' }, { k: 'order_id', t: 'pick', path: '/orders', show: (o) => String(o.number), label: 'برای سفارش' }, { k: 'description', t: 'text' }, { k: 'note', t: 'textarea' }];
  const lot = (form.lot as Record<string, unknown>) ?? {};
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); const b = { ...form }; if (!isMaterial || form.material_lot_id) delete b.lot; else b.lot = { ...lot, kind: form.purchase_kind }; act.mutate(b); }}>
      <Back to="/materials">مواد</Back><h1>خرید جدید</h1>
      <ConflictBanner err={act.error} fields={L} />
      <div className="card"><div className="grid2">{specs.map((s) => <FieldEditor key={s.k} spec={s} form={form} set={set} error={act.error?.fields?.[s.k]} />)}
        {isMaterial && !form.material_lot_id && <><label className="field"><span>آلیاژ پارت جدید</span><input dir="ltr" value={String(lot.alloy ?? '')} onChange={(e) => set('lot', { ...lot, alloy: e.target.value || null })} /></label><label className="field"><span>شرح پارت</span><input value={String(lot.description ?? '')} onChange={(e) => set('lot', { ...lot, description: e.target.value || null })} /></label><label className="field"><span>شماره بچ</span><input dir="ltr" value={String(lot.batch_no ?? '')} onChange={(e) => set('lot', { ...lot, batch_no: e.target.value || null })} /></label></>}
      </div><div className="row"><FileUpload kind="receipt" label="فاکتور فروشنده" onDone={(f) => set('file_ids', [...((form.file_ids as string[]) ?? []), f.id])} /><span className="muted">{((form.file_ids as string[]) ?? []).length} فایل</span></div></div>
      <div className="row"><button className="btn primary" type="submit" disabled={act.isPending}>ثبت خرید</button><button className="btn" type="button" onClick={() => nav(-1)}>انصراف</button></div>
    </form>
  );
}
export function PurchaseDetail() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const { can } = useAuth();
  const p = useOne<Record<string, unknown>>(`/purchases/${id}`);
  const [rec, setRec] = useState<{ kg: string | null; to_location_id: string | null; bundles: Array<Record<string, unknown>> }>({ kg: null, to_location_id: null, bundles: [] });
  const receive = useAct<Record<string, unknown>>('POST', `/purchases/${id}/receive`, { onSuccess: () => void qc.invalidateQueries() });
  if (!p.data) return <p className="muted">…</p>;
  const r = p.data;
  const isProfile = ['raw_profile', 'finished_profile'].includes(String(r.purchase_kind));
  const open = String(r.status) !== 'void';
  return (
    <div className="stack">
      <Back to="/materials">مواد</Back>
      <div className="row between"><h1>خرید {fa(String(r.number))} — {String(r.party_name ?? '')}</h1><span className="badge">{ev(r.status)}</span></div>
      <div className="card"><Details r={r} keys={['purchase_kind', 'date', 'due_date', 'agreed_kg', 'received_kg', 'unit_price', 'amount', 'currency', 'paid', 'remaining', 'description', 'note']} />{r.lot ? <div className="muted">پارت: {String((r.lot as Record<string, unknown>).description ?? (r.lot as Record<string, unknown>).kind)}</div> : null}{can('finance.view') && <Link className="muted" to={`/documents/${id}`}>سند مالی</Link>}</div>
      {open && <div className="card"><h2>ثبت دریافت کالا (T41)</h2><ConflictBanner err={receive.error} fields={L} />
        <div className="grid2"><label className="field"><span>مکان دریافت</span><Picker path="/locations" value={rec.to_location_id} label={showLocation as (x: { id: string }) => string} onChange={(lid) => setRec({ ...rec, to_location_id: lid })} /></label>
          {!isProfile && <label className="field"><span>وزن دریافتی (کیلو)</span><NumInput value={rec.kg} onChange={(v) => setRec({ ...rec, kg: v })} /></label>}</div>
        {isProfile && <>{rec.bundles.map((b, i) => <div key={i} className="grid2 card compact"><label className="field"><span>کد (خالی = موقت)</span><input dir="ltr" value={String(b.code ?? '')} onChange={(e) => setRec({ ...rec, bundles: rec.bundles.map((x, j) => (j === i ? { ...x, code: e.target.value || undefined } : x)) })} /></label><label className="field"><span>وزن</span><NumInput value={b.weight_kg as string | null} onChange={(v) => setRec({ ...rec, bundles: rec.bundles.map((x, j) => (j === i ? { ...x, weight_kg: v } : x)) })} /></label><label className="field"><span>محصول</span><Picker path="/products" value={(b.lines as Array<{ product_id: string }>)?.[0]?.product_id ?? null} label={showProduct as (x: { id: string }) => string} onChange={(pid) => setRec({ ...rec, bundles: rec.bundles.map((x, j) => (j === i ? { ...x, lines: [{ product_id: pid }] } : x)) })} /></label><label className="field"><span>شکل</span><Select value={String(b.form ?? 'raw')} options={[['raw', 'خام'], ['painted', 'رنگ‌شده'], ['anodized', 'آنادایز']]} onChange={(v) => setRec({ ...rec, bundles: rec.bundles.map((x, j) => (j === i ? { ...x, form: v } : x)) })} /></label></div>)}<button className="btn" onClick={() => setRec({ ...rec, bundles: [...rec.bundles, { form: 'raw', lines: [] }] })}>+ بندیل</button></>}
        <div className="row" style={{ marginTop: 8 }}><button className="btn primary" disabled={receive.isPending} onClick={() => receive.mutate({ version: r.version, kg: rec.kg ?? undefined, to_location_id: rec.to_location_id ?? undefined, bundles: isProfile ? rec.bundles : undefined })}>ثبت دریافت</button></div></div>}
    </div>
  );
}
export function ScrapSalePage() {
  const nav = useNavigate();
  const { form, set } = useForm({ lot_id: null, party_id: null, from_location_id: null, kg: null, unit_price: null, currency: 'TOMAN', note: null });
  const act = useAct<Record<string, unknown>, { document_id?: string; id?: string }>('POST', '/scrap/sale', { onSuccess: (r) => nav(r.document_id ? `/documents/${r.document_id}` : '/materials') });
  return <form className="stack" onSubmit={(e) => { e.preventDefault(); act.mutate(form); }}><Back to="/materials">مواد</Back><h1>فروش ضایعات</h1><ConflictBanner err={act.error} fields={L} /><div className="card"><div className="grid2">
    <FieldEditor spec={{ k: 'lot_id', t: 'pick', path: '/material-lots', params: { kind: 'scrap' }, show: (l) => `${l.description ?? 'ضایعات'} ${l.alloy ?? ''} — ${l.kg ?? ''} کیلو`, req: true, label: 'پارت ضایعات' }} form={form} set={set} />
    <FieldEditor spec={{ k: 'party_id', t: 'pick', path: '/parties', params: { role: 'scrap_trader' }, show: showParty, req: true, label: 'خریدار' }} form={form} set={set} />
    <FieldEditor spec={{ k: 'from_location_id', t: 'pick', path: '/locations', show: showLocation, req: true, label: 'از مکان' }} form={form} set={set} />
    <FieldEditor spec={{ k: 'kg', t: 'num', unit: 'کیلو', req: true }} form={form} set={set} /><FieldEditor spec={{ k: 'unit_price', t: 'num', label: 'قیمت هر کیلو' }} form={form} set={set} /><FieldEditor spec={{ k: 'currency', t: 'select', opts: ['TOMAN', 'USD', 'IQD'], req: true }} form={form} set={set} /><FieldEditor spec={{ k: 'note', t: 'text' }} form={form} set={set} />
  </div></div><button className="btn primary" type="submit" disabled={act.isPending}>ثبت فروش (فاکتور پیش‌نویس)</button></form>;
}
export function SmeltingPage() {
  const nav = useNavigate();
  const { form, set } = useForm({ smelter_party_id: null, output_kg: null, alloy: null, to_location_id: null, note: null });
  const [inputs, setInputs] = useState<Array<{ lot_id: string | null; from_location_id: string | null; kg: string | null }>>([{ lot_id: null, from_location_id: null, kg: null }]);
  const act = useAct<Record<string, unknown>>('POST', '/smelting', { onSuccess: () => nav('/materials') });
  return <form className="stack" onSubmit={(e) => { e.preventDefault(); act.mutate({ ...form, inputs }); }}><Back to="/materials">مواد</Back><h1>ذوب ضایعات → شمش</h1><ConflictBanner err={act.error} fields={L} />
    <div className="card"><div className="grid2"><FieldEditor spec={{ k: 'smelter_party_id', t: 'pick', path: '/parties', params: { role: 'smelter' }, show: showParty, req: true, label: 'ذوب‌کار' }} form={form} set={set} /><FieldEditor spec={{ k: 'output_kg', t: 'num', unit: 'کیلو', req: true, label: 'شمش خروجی' }} form={form} set={set} /><FieldEditor spec={{ k: 'alloy', t: 'ltr' }} form={form} set={set} /><FieldEditor spec={{ k: 'to_location_id', t: 'pick', path: '/locations', show: showLocation, label: 'مکان شمش' }} form={form} set={set} /><FieldEditor spec={{ k: 'note', t: 'text' }} form={form} set={set} /></div></div>
    <div className="card"><h2>ضایعات ورودی</h2>{inputs.map((it, i) => <div key={i} className="grid2"><label className="field"><span>پارت</span><Picker path="/material-lots" params={{ kind: 'scrap' }} value={it.lot_id} label={((l: Record<string, unknown>) => `${l.description ?? 'ضایعات'} — ${l.kg ?? ''} کیلو`) as (x: { id: string }) => string} onChange={(lid) => setInputs(inputs.map((x, j) => (j === i ? { ...x, lot_id: lid } : x)))} /></label><label className="field"><span>از مکان</span><Picker path="/locations" value={it.from_location_id} label={showLocation as (x: { id: string }) => string} onChange={(lid) => setInputs(inputs.map((x, j) => (j === i ? { ...x, from_location_id: lid } : x)))} /></label><label className="field"><span>کیلو</span><NumInput value={it.kg} onChange={(v) => setInputs(inputs.map((x, j) => (j === i ? { ...x, kg: v } : x)))} /></label></div>)}<button className="btn" type="button" onClick={() => setInputs([...inputs, { lot_id: null, from_location_id: null, kg: null }])}>+ ورودی</button></div>
    <button className="btn primary" type="submit" disabled={act.isPending}>ثبت ذوب</button></form>;
}
export { E, Action, JalaliInput };
