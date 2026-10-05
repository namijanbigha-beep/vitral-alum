import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Action, Details, E, ev, FieldEditor, L, ListPage, showParty, showProduct, useForm, type FieldSpec } from '../components/entity.js';
import { Back, ConflictBanner, NumInput, PdfButtons, Picker, Select, Status, Table, Tabs, fa, jdate, jdt, money, num } from '../components/ui.js';
import { useAuth } from '../lib/auth.js';
import { useAct, useList, useOne } from '../lib/hooks.js';

const SALES: Record<string, [string, string?]> = { draft: ['پیش‌نویس'], proforma: ['پیش‌فاکتور', 'warn'], approved: ['تأییدشده', 'ok'], cancelled: ['لغو', 'danger'] };
export const OrdersPage = () => <ListPage title="سفارش‌ها" path="/orders" newTo="/orders/new" rowTo={(r) => `/orders/${r.id}`}
  cols={[{ k: 'number' }, { k: 'party', l: 'مشتری', f: (v) => String((v as { name?: string } | null)?.name ?? '') }, { k: 'order_date' }, { k: 'totals', l: 'وزن (کیلو)', f: (v) => num((v as { total_kg?: string })?.total_kg, 'weight') }, { k: 'status_sales', f: (v) => <Status s={String(v)} map={SALES} /> }, { k: 'statuses', l: 'اقدام بعدی', f: (v) => String((v as { next_action_label?: string } | null)?.next_action_label ?? '—') }]}
  filters={[{ k: 'q', l: 'جستجو', t: 'text' }, { k: 'status', l: 'وضعیت', t: 'select', opts: Object.keys(SALES) }, { k: 'party_id', l: 'مشتری', t: 'pick', path: '/parties', show: showParty }, { k: 'archived', l: 'بایگانی', t: 'bool' }]} />;

type OLine = Record<string, unknown>;
const newLine = (cur: string): OLine => ({ kind: 'profile', product_id: null, filler_mm: null, length_m: null, color: null, weight_g_per_m: null, calc_mode: 'from_bars', qty_bars: null, qty_kg: null, qty_pieces: null, price_basis: 'per_kg', unit_price: null, currency: cur, discount_amount: '0', discount_percent: '0', supply_method: null, die_id: null, description: null, name_ar: null, note: null });

/** Order / proforma form (spec module 3): header + lines with R02 weight estimate, prices per basis. */
export function OrderForm() {
  const { id } = useParams();
  const isNew = !id || id === 'new';
  const nav = useNavigate();
  const existing = useOne<Record<string, unknown>>(isNew ? null : `/orders/${id}`, { refetchInterval: false, refetchOnWindowFocus: false });
  const { form, set, setForm } = useForm({ party_id: null, title: null, currency: 'TOMAN', settlement_basis: 'final_net_scale', prepay_percent: null, payment_terms: 'cash', valid_until: null, delivery_days: null, due_date: null, order_date: new Date().toISOString().slice(0, 10), destination_country: null, destination_city: null, destination_address: null, invoice_notes: null, internal_note: null, numbering_kind: 'order' });
  const [lines, setLines] = useState<OLine[]>([newLine('TOMAN')]);
  useEffect(() => { if (existing.data) { setForm({ ...existing.data }); setLines(((existing.data.lines as OLine[]) ?? []).map((l) => ({ ...l }))); } }, [existing.data]);
  const act = useAct<Record<string, unknown>, { id: string }>(isNew ? 'POST' : 'PATCH', isNew ? '/orders' : `/orders/${id}`, { onSuccess: (r) => nav(`/orders/${r.id}`) });
  const specs: FieldSpec[] = [{ k: 'party_id', t: 'pick', path: '/parties', params: { role: 'customer' }, show: showParty, req: true, label: 'مشتری', onPick: (r) => (r?.default_currency ? { currency: r.default_currency } : {}) }, { k: 'title', t: 'text' }, { k: 'currency', t: 'select', opts: ['TOMAN', 'USD', 'IQD'], req: true }, { k: 'numbering_kind', t: 'select', opts: ['order', 'wholesale_proforma'], req: true, label: 'نوع شماره‌گذاری' }, { k: 'order_date', t: 'date', req: true }, { k: 'settlement_basis', t: 'select', opts: ['final_net_scale', 'agreed_weight'], req: true }, { k: 'payment_terms', t: 'select', opts: ['cash', 'credit'], req: true }, { k: 'prepay_percent', t: 'num', unit: '٪' }, { k: 'valid_until', t: 'date' }, { k: 'delivery_days', t: 'int' }, { k: 'due_date', t: 'date' }, { k: 'destination_country', t: 'text' }, { k: 'destination_city', t: 'text' }, { k: 'destination_address', t: 'textarea' }, { k: 'invoice_notes', t: 'textarea' }, { k: 'internal_note', t: 'textarea' }];
  const upd = (i: number, patch: OLine) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const submit = () => {
    const body: Record<string, unknown> = {};
    for (const s of specs) if (form[s.k] !== undefined) body[s.k] = form[s.k];
    if (!isNew) body.version = form.version;
    body.lines = lines.map((l) => { const o: OLine = {}; for (const k of ['id', 'sort', 'kind', 'product_id', 'filler_mm', 'length_m', 'min_length_m', 'color', 'load_type_label', 'weight_g_per_m', 'calc_mode', 'qty_bars', 'qty_kg', 'qty_pieces', 'price_basis', 'unit_price', 'currency', 'discount_amount', 'discount_percent', 'supply_method', 'die_id', 'material_kind', 'coating_gain_estimate_percent', 'name_ar', 'name_en', 'description', 'note']) if (l[k] !== undefined && l[k] !== '') o[k] = l[k]; if (o.qty_pieces != null) o.qty_pieces = Number(o.qty_pieces); return o; });
    act.mutate(body);
  };
  const E_KIND: Array<[string, string]> = [['profile', 'پروفیل'], ['material', 'مواد'], ['die_making', 'ساخت قالب'], ['service', 'خدمت']];
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <Back to="/orders">سفارش‌ها</Back><h1>{isNew ? 'سفارش / پیش‌فاکتور جدید' : `ویرایش سفارش ${fa(String(form.number ?? ''))}`}</h1>
      <ConflictBanner err={act.error} fields={L} onReload={() => void existing.refetch()} />
      <div className="card"><div className="grid2">{specs.map((s) => <FieldEditor key={s.k} spec={s} form={form} set={set} error={act.error?.fields?.[s.k]} />)}</div></div>
      <div className="card"><h2>ردیف‌ها</h2>
        {lines.map((l, i) => (
          <div key={i} className="card compact" style={{ background: 'var(--surface-2)' }}>
            <div className="grid2">
              <label className="field"><span>نوع ردیف</span><Select value={String(l.kind)} options={E_KIND} onChange={(v) => upd(i, { kind: v })} /></label>
              {l.kind === 'profile' && <label className="field"><span>محصول<b className="req">*</b></span><Picker path="/products" value={l.product_id as string | null} label={showProduct as (r: { id: string }) => string} onChange={(pid, row) => { const r = row as Record<string, unknown> | null; const fl = (r?.fillers as Array<{ filler_mm: string; weight_g_per_m: string | null }> | undefined) ?? []; upd(i, { product_id: pid, filler_mm: fl[0]?.filler_mm ?? l.filler_mm, weight_g_per_m: fl[0]?.weight_g_per_m ?? null, description: r?.name_fa ?? null, name_ar: r?.name_ar ?? null }); }} /></label>}
              {l.kind !== 'profile' && <label className="field"><span>شرح<b className="req">*</b></span><input value={String(l.description ?? '')} onChange={(e) => upd(i, { description: e.target.value })} /></label>}
              {l.kind === 'die_making' && <label className="field"><span>قالب</span><Picker path="/dies" value={l.die_id as string | null} label={((d: Record<string, unknown>) => `${d.code}`) as (r: { id: string }) => string} onChange={(did) => upd(i, { die_id: did })} /></label>}
              {l.kind === 'material' && <label className="field"><span>نوع ماده</span><Select value={(l.material_kind as string) ?? ''} allowEmpty="—" options={[['ingot', 'شمش'], ['billet', 'بیلت'], ['scrap', 'ضایعات'], ['paint_powder', 'پودر رنگ'], ['tool', 'ابزار']]} onChange={(v) => upd(i, { material_kind: v })} /></label>}
              {l.kind === 'profile' && <>
                <label className="field"><span>فیلر (mm)</span><NumInput value={l.filler_mm as string | null} onChange={(v) => upd(i, { filler_mm: v })} /></label>
                <label className="field"><span>طول (متر)</span><NumInput value={l.length_m as string | null} onChange={(v) => upd(i, { length_m: v })} /></label>
                <label className="field"><span>رنگ</span><input value={String(l.color ?? '')} onChange={(e) => upd(i, { color: e.target.value || null })} /></label>
                <label className="field"><span>وزن هر متر (گرم) {l.weight_unapproved ? <span className="badge warn">تأییدنشده</span> : null}</span><NumInput value={l.weight_g_per_m as string | null} onChange={(v) => upd(i, { weight_g_per_m: v })} /></label>
                <label className="field"><span>روش محاسبه</span><Select value={String(l.calc_mode)} options={[['from_bars', 'از تعداد شاخه (R02)'], ['from_weight', 'از وزن'], ['manual', 'دستی']]} onChange={(v) => upd(i, { calc_mode: v })} /></label>
                <label className="field"><span>تعداد شاخه</span><NumInput value={l.qty_bars as string | null} onChange={(v) => upd(i, { qty_bars: v })} /></label>
                <label className="field"><span>وزن (کیلو){l.qty_is_estimate ? <span className="badge" style={{ marginInlineStart: 4 }}>برآوردی</span> : null}</span><NumInput value={l.qty_kg as string | null} onChange={(v) => upd(i, { qty_kg: v })} /></label>
                <label className="field"><span>روش تأمین</span><Select value={(l.supply_method as string) ?? ''} allowEmpty="—" options={[['toll_production', 'تولید کارمزدی'], ['stock', 'از موجودی'], ['buy_raw_then_paint', 'خرید خام و رنگ'], ['buy_finished', 'خرید آماده']]} onChange={(v) => upd(i, { supply_method: v })} /></label>
                <label className="field"><span>برآورد اضافه‌وزن رنگ ٪</span><NumInput value={l.coating_gain_estimate_percent as string | null} onChange={(v) => upd(i, { coating_gain_estimate_percent: v })} /></label>
              </>}
              {l.kind !== 'profile' && <label className="field"><span>تعداد</span><NumInput value={l.qty_pieces == null ? null : String(l.qty_pieces)} onChange={(v) => upd(i, { qty_pieces: v == null ? null : Number(v) })} /></label>}
              {l.kind === 'material' && <label className="field"><span>وزن (کیلو)</span><NumInput value={l.qty_kg as string | null} onChange={(v) => upd(i, { qty_kg: v })} /></label>}
              <label className="field"><span>مبنای قیمت</span><Select value={String(l.price_basis)} options={[['per_kg', 'هر کیلو'], ['per_bar', 'هر شاخه'], ['per_meter', 'هر متر'], ['per_piece', 'هر عدد']]} onChange={(v) => upd(i, { price_basis: v })} /></label>
              <label className="field"><span>قیمت واحد ({E[String(l.currency ?? form.currency)]})</span><NumInput value={l.unit_price as string | null} onChange={(v) => upd(i, { unit_price: v })} /></label>
              <label className="field"><span>تخفیف ٪</span><NumInput value={l.discount_percent as string | null} onChange={(v) => upd(i, { discount_percent: v ?? '0' })} /></label>
              <label className="field"><span>نام عربی (برای پیش‌فاکتور عربی)</span><input value={String(l.name_ar ?? '')} onChange={(e) => upd(i, { name_ar: e.target.value || null })} /></label>
              <label className="field"><span>یادداشت</span><input value={String(l.note ?? '')} onChange={(e) => upd(i, { note: e.target.value || null })} /></label>
            </div>
            <div className="row between"><span className="muted">{l.amount ? `مبلغ ردیف: ${money(l.amount, String(l.currency ?? form.currency))}` : 'بدون قیمت'}</span>{lines.length > 1 && <button type="button" className="btn danger" onClick={() => setLines(lines.filter((_, j) => j !== i))}>حذف ردیف</button>}</div>
          </div>
        ))}
        <button type="button" className="btn" onClick={() => setLines([...lines, newLine(String(form.currency))])}>+ ردیف</button>
      </div>
      <div className="row"><button className="btn primary" type="submit" disabled={act.isPending}>ذخیره</button><button className="btn" type="button" onClick={() => nav(-1)}>انصراف</button></div>
    </form>
  );
}

const STAT_FA: Record<string, string> = { supply: 'تأمین', operations: 'عملیات', shipping: 'ارسال', finance: 'مالی' };
export function OrderDetail() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const [tab, setTab] = useState<'lines' | 'related' | 'reserve' | 'revisions'>('lines');
  const o = useOne<Record<string, unknown>>(`/orders/${id}`);
  const relatedQ = useOne<Record<string, Array<Record<string, unknown>>>>(tab === 'related' ? `/orders/${id}/related` : null);
  const rel = (k: string) => relatedQ.data?.[k] ?? [];
  const reservations = useOne<{ items: Array<Record<string, unknown>> }>(tab === 'reserve' ? `/orders/${id}/reservations` : null);
  const revisions = useOne<{ items: Array<Record<string, unknown>> }>(tab === 'revisions' ? `/orders/${id}/revisions` : null);
  const refresh = () => void qc.invalidateQueries();
  if (!o.data) return <p className="muted">…</p>;
  const x = o.data;
  const version = Number(x.version);
  const lines = (x.lines as Array<Record<string, unknown>>) ?? [];
  const totals = x.totals as { totals: Record<string, string>; incomplete: boolean; total_kg: string; paid: Record<string, string>; remaining: Record<string, string>; prepay: Record<string, string> };
  const st = x.statuses as Record<string, string | null>;
  const party = x.party as { name?: string } | null;
  const canEdit = x.status_sales !== 'cancelled';
  return (
    <div className="stack">
      <Back to="/orders">سفارش‌ها</Back>
      <div className="row between"><h1>سفارش {fa(String(x.number))} — {party?.name}</h1><div className="row"><Status s={String(x.status_sales)} map={SALES} />{canEdit && <Link className="btn" to={`/orders/${id}/edit`}>ویرایش</Link>}</div></div>
      {st.next_action_label && <div className="alert ok">اقدام بعدی: {st.next_action_label}</div>}
      <div className="row">{Object.entries(STAT_FA).map(([k, l]) => <span key={k} className="badge">{l}: {ev(st[k])}</span>)}</div>
      <div className="card"><Details r={x} keys={['title', 'order_date', 'currency', 'settlement_basis', 'payment_terms', 'prepay_percent', 'valid_until', 'delivery_days', 'due_date', 'destination_country', 'destination_city', 'destination_address', 'revision', 'print_count', 'approved_at', 'invoice_notes', 'internal_note', 'cancel_reason']} />
        <div className="row" style={{ marginTop: 6 }}><span className="badge">وزن کل {num(totals.total_kg, 'weight')} کیلو</span>{can('finance.view') && Object.entries(totals.totals).map(([c, v]) => <span key={c} className="badge ok">جمع {money(v, c)}{totals.incomplete ? ' (ناقص)' : ''} · دریافتی {money(totals.paid[c] ?? '0', c)} · مانده {money(totals.remaining[c] ?? v, c)}</span>)}</div>
      </div>
      <div className="card"><h2>اقدام‌ها</h2><div className="row">
        <PdfButtons path={`/orders/${id}/proforma`} name={`proforma-${x.number}`} />
        {x.status_sales !== 'approved' && canEdit && <Action label="درخواست تأیید" path={`/orders/${id}/request-approval`} version={version} onDone={refresh} />}
        {x.status_sales !== 'approved' && canEdit && <Action label="تأیید سفارش (قفل قیمت)" perm="sales.approve" path={`/orders/${id}/approve`} version={version} onDone={refresh} />}
        {canEdit && <Action label="لغو سفارش" perm="sales.approve" danger path={`/orders/${id}/cancel`} version={version} onDone={refresh} fields={[{ k: 'reason', t: 'textarea', req: true }]} />}
        <Action label={x.archived ? 'خروج از بایگانی' : 'بایگانی'} path={`/orders/${id}/archive`} version={version} onDone={refresh} />
        {can('finance.view') && <Link className="btn" to={`/orders/${id}/costing`}>بهای تمام‌شده و سود</Link>}
        {can('finance.view') && x.status_sales === 'approved' && <Link className="btn" to={`/documents/new?kind=invoice&order_id=${id}`}>صدور فاکتور</Link>}
        <Link className="btn" to={`/transfers/new?order_id=${id}`}>ارسال بار</Link>
      </div></div>
      <Tabs value={tab} onChange={setTab} tabs={[['lines', 'ردیف‌ها'], ['reserve', 'موجودی رزرو'], ['related', 'مرتبط'], ['revisions', 'ویرایش‌ها']]} />
      {tab === 'lines' && <div className="card"><Table head={['#', 'نوع', 'شرح', 'فیلر/طول/رنگ', 'گرم/متر', 'تعداد', 'وزن (کیلو)', ...(can('finance.view') ? ['قیمت', 'مبلغ'] : []), 'تأمین']} rows={lines.map((l, i) => [fa(i + 1), ev(l.kind), `${String(l.product_code ?? '')} ${String(l.product_name ?? l.description ?? '')}`, [l.filler_mm ? `فیلر ${num(l.filler_mm, 'filler')}` : null, l.length_m ? `${num(l.length_m, 'length')} م` : null, l.color].filter(Boolean).join(' · ') || '—', l.weight_g_per_m ? <>{num(l.weight_g_per_m, 'g_per_m')}{l.weight_unapproved ? ' ⚠' : ''}</> : '—', l.qty_bars ? `${num(l.qty_bars)} شاخه` : l.qty_pieces != null ? `${fa(String(l.qty_pieces))} عدد` : '—', <>{num(l.qty_kg, 'weight')}{l.qty_is_estimate ? <span className="muted"> (برآورد)</span> : null}</>, ...(can('finance.view') ? [l.unit_price ? `${money(l.unit_price, String(l.currency))} ${ev(l.price_basis)}` : '—', money(l.amount, String(l.currency))] : []), ev(l.supply_method)])} /></div>}
      {tab === 'reserve' && <ReserveTab id={id} lines={lines} items={reservations.data?.items ?? []} onDone={refresh} />}
      {tab === 'related' && relatedQ.data && <div className="stack">
        <div className="card"><h2>نوبت‌های تولید</h2><Table head={['شماره', 'وضعیت', 'شروع']} rows={rel('runs').map((r) => [<Link to={`/production/${r.id}`}>{fa(String(r.number))}</Link>, ev(r.status), jdt(r.started_at as string)])} /></div>
        <div className="card"><h2>بندیل‌ها</h2><Table head={['کد', 'وزن', 'شکل', 'وضعیت']} rows={rel('bundles').map((b) => [<Link to={`/bundles/${b.id}`}>{fa(String(b.code))}</Link>, num(b.weight_kg, 'weight'), ev(b.form), ev(b.status)])} /></div>
        <div className="card"><h2>نوبت‌های رنگ</h2><Table head={['شماره', 'وضعیت', 'خدمت']} rows={rel('coating_runs').map((c) => [<Link to={`/coating/${c.id}`}>{fa(String(c.number))}</Link>, ev(c.status), ev(c.service)])} /></div>
        <div className="card"><h2>بارها</h2><Table head={['شماره', 'نوع', 'وضعیت', 'حرکت']} rows={rel('transfers').map((t) => [<Link to={`/transfers/${t.id}`}>{fa(String(t.number))}</Link>, ev(t.kind), ev(t.status), jdt(t.departed_at as string)])} /></div>
        <div className="card"><h2>اسناد</h2><Table head={['شماره', 'نوع', 'تاریخ', 'مبلغ', 'وضعیت']} rows={rel('documents').map((d) => [<Link to={`/documents/${d.id}`}>{fa(String(d.number))}</Link>, ev(d.kind), jdate(String(d.date)), money(d.amount, String(d.currency)), ev(d.status)])} /></div>
        <div className="card"><h2>کارها و یادداشت‌ها</h2>{rel('tasks').map((t) => <div key={String(t.id)}><Link to={`/tasks/${t.id}`}>{String(t.title)}</Link> <span className="badge">{ev(t.status)}</span></div>)}{rel('notes').map((n) => <div key={String(n.id)} className="muted"><Link to={`/notes/${n.id}`}>{String(n.text).slice(0, 80)}</Link></div>)}</div>
      </div>}
      {tab === 'revisions' && <div className="card"><Table head={['ویرایش', 'زمان', 'توسط']} rows={(revisions.data?.items ?? []).map((r) => [fa(String(r.revision)), jdt(String(r.created_at)), String(r.created_by_name ?? r.created_by ?? '')])} /></div>}
    </div>
  );
}

/** R17/R18 reservation: pick free bundles for a line; whole-order kg is split by the server's suggestion. */
function ReserveTab({ id, lines, items, onDone }: { id: string; lines: Array<Record<string, unknown>>; items: Array<Record<string, unknown>>; onDone: () => void }) {
  const [lineId, setLineId] = useState<string>(String(lines.find((l) => l.kind === 'profile')?.id ?? ''));
  const line = lines.find((l) => l.id === lineId);
  const avail = useList<Record<string, unknown>>('/bundles', { available: 'true', product_id: line?.product_id ? String(line.product_id) : undefined }, { enabled: !!line });
  const reserve = useAct<Record<string, unknown>>('POST', `/orders/${id}/reserve`, { onSuccess: onDone });
  const release = useAct<Record<string, unknown>>('POST', `/orders/${id}/release`, { onSuccess: onDone });
  return (
    <div className="card">
      <h2>رزروهای فعلی</h2>
      <Table head={['بندیل', 'کیلو', 'وضعیت', '']} rows={items.map((r) => [<Link to={`/bundles/${r.bundle_id}`}>{fa(String(r.bundle_code))}</Link>, num(r.kg, 'weight'), ev(r.status), r.status === 'active' ? <button className="btn" onClick={() => release.mutate({ reservation_id: r.id })}>آزاد کردن</button> : ''])} />
      <h2 style={{ marginTop: 12 }}>رزرو از موجودی</h2>
      <label className="field"><span>ردیف سفارش</span><select value={lineId} onChange={(e) => setLineId(e.target.value)}>{lines.filter((l) => l.kind === 'profile').map((l) => <option key={String(l.id)} value={String(l.id)}>{String(l.product_code ?? '')} {String(l.product_name ?? '')} — {num(l.qty_kg, 'weight')} کیلو</option>)}</select></label>
      <ConflictBanner err={reserve.error ?? release.error} fields={L} />
      <Table head={['کد', 'وزن', 'آزاد', 'شکل/رنگ', 'مکان', '']} rows={avail.items.map((b) => [fa(String(b.code)), num(b.weight_kg, 'weight'), num(b.free_kg ?? b.weight_kg, 'weight'), `${ev(b.form)} ${String(b.color ?? '')}`, String(b.location_name ?? ''), <button className="btn" disabled={!lineId || reserve.isPending} onClick={() => reserve.mutate({ items: [{ order_line_id: lineId, bundle_id: b.id }] })}>رزرو</button>])} />
    </div>
  );
}
