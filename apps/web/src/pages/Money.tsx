import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Action, Details, E, EntityForm, ev, FieldEditor, L, ListPage, showOrder, showParty, useForm, type FieldSpec } from '../components/entity.js';
import { Back, ConflictBanner, FileUpload, NumInput, PdfButtons, Picker, Select, Status, Table, Thumb, fa, jdate, money, num } from '../components/ui.js';
import { useAuth } from '../lib/auth.js';
import { useAct, useOne } from '../lib/hooks.js';

const KINDS = ['invoice', 'sales_return', 'purchase', 'toll_fee', 'expense', 'receipt', 'payment', 'barter', 'opening_balance', 'fx_difference'];
const METHODS = ['cash', 'bank', 'card', 'cheque', 'hawala', 'barter'];
const DST: Record<string, [string, string?]> = { draft: ['پیش‌نویس'], reported: ['گزارش‌شده', 'warn'], posted: ['قطعی', 'ok'], void: ['باطل', 'danger'], needs_completion: ['ناقص', 'danger'] };
const CUR = ['TOMAN', 'USD', 'IQD'];

export function DocumentsPage() {
  const { can } = useAuth();
  const kinds = can('finance.view') ? KINDS : ['invoice', 'sales_return', 'receipt', 'payment'];
  return <ListPage title="اسناد مالی" path="/documents" newTo="/documents/new" rowTo={(r) => `/documents/${r.id}`} cols={[{ k: 'number' }, { k: 'kind' }, { k: 'date' }, { k: 'party_name' }, { k: 'order_number' }, { k: 'amount' }, { k: 'status', f: (v) => <Status s={String(v)} map={DST} /> }]} filters={[{ k: 'q', l: 'جستجو', t: 'text' }, { k: 'kind', l: 'نوع', t: 'select', opts: kinds }, { k: 'status', l: 'وضعیت', t: 'select', opts: Object.keys(DST) }, { k: 'party_id', l: 'طرف', t: 'pick', path: '/parties', show: showParty }, { k: 'pending', l: 'در انتظار تأیید', t: 'bool' }]} extra={can('finance.view') ? <span className="row"><Link className="btn" to="/accounts">حساب‌ها</Link><Link className="btn" to="/fx-rates">نرخ ارز</Link></span> : undefined} />;
}

/** Create a document: receipt/payment (staff report, finance posts), invoice from order, expense with shares, purchase/toll/barter/opening. */
export function DocumentForm() {
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const { can } = useAuth();
  const kind0 = sp.get('kind') ?? 'receipt';
  const { form, set } = useForm({ kind: kind0, party_id: null, order_id: sp.get('order_id'), amount: null, currency: 'TOMAN', date: new Date().toISOString(), due_date: null, method: kind0 === 'receipt' || kind0 === 'payment' ? 'cash' : null, account_id: null, tracking_no: null, description: null, note: null, file_ids: [], expense_type: 'general', expense_category: null, barter_sign: 1, barter_kg: null, settlement_kg: null, post: false });
  const [shares, setShares] = useState<Array<{ order_id: string | null; amount: string | null }>>([]);
  const [allocs, setAllocs] = useState<Array<{ to_document_id?: string | null; order_id?: string | null; amount: string | null }>>([]);
  const order = useOne<Record<string, unknown>>(form.order_id ? `/orders/${form.order_id}` : null);
  const act = useAct<Record<string, unknown>, { id: string }>('POST', '/documents', { onSuccess: (r) => nav(`/documents/${r.id}`) });
  const k = String(form.kind);
  const isMoney = k === 'receipt' || k === 'payment';
  const specs: FieldSpec[] = [
    { k: 'kind', t: 'select', opts: can('finance.view') ? KINDS : ['receipt', 'payment', 'invoice'], req: true },
    { k: 'party_id', t: 'pick', path: '/parties', show: showParty, req: k !== 'expense', label: 'طرف حساب', onPick: (r) => (r?.default_currency && !form.order_id ? { currency: r.default_currency } : {}) },
    { k: 'order_id', t: 'pick', path: '/orders', show: showOrder, label: k === 'invoice' ? 'سفارش (فاکتور از ردیف‌های آن ساخته می‌شود)' : 'سفارش', onPick: (r) => (r ? { party_id: r.party_id, currency: r.currency } : {}) },
    { k: 'amount', t: 'num', req: !['invoice'].includes(k), label: k === 'invoice' ? 'مبلغ (خالی = از ردیف‌های سفارش)' : 'مبلغ' }, { k: 'currency', t: 'select', opts: CUR, req: true }, { k: 'date', t: 'datetime' }, { k: 'due_date', t: 'datetime', hidden: () => !['invoice', 'purchase', 'toll_fee', 'expense'].includes(k) },
    { k: 'method', t: 'select', opts: METHODS, req: isMoney, hidden: () => !isMoney }, { k: 'account_id', t: 'pick', path: '/accounts', show: (a) => `${a.name} (${E[String(a.currency)]})`, hidden: () => !isMoney || !can('finance.view') }, { k: 'tracking_no', t: 'ltr', hidden: () => !isMoney },
    { k: 'expense_type', t: 'select', opts: ['order', 'shared', 'general'], hidden: () => k !== 'expense' }, { k: 'expense_category', t: 'text', hidden: () => k !== 'expense' },
    { k: 'barter_sign', t: 'select', opts: ['1', '-1'], label: 'جهت تهاتر (۱ = طلب ویترال، -۱ = بدهی)', hidden: () => k !== 'barter' && k !== 'opening_balance' }, { k: 'barter_kg', t: 'num', unit: 'کیلو', hidden: () => k !== 'barter' },
    { k: 'settlement_kg', t: 'num', unit: 'کیلو', label: 'وزن مبنای تسویه (خالی = قبض فروش تأییدشده)', hidden: () => k !== 'invoice' },
    { k: 'description', t: 'text' }, { k: 'note', t: 'textarea' }, { k: 'post', t: 'bool', label: 'قطعی کن (نیازمند مجوز مالی)', hidden: () => !can('finance.post') },
  ];
  const openItems = useOne<{ items: Array<Record<string, unknown>> }>(isMoney && form.party_id ? `/parties/${form.party_id}/open-items` : null);
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); const b: Record<string, unknown> = {}; for (const s of specs) if (!s.hidden?.(form) && form[s.k] !== undefined) b[s.k] = form[s.k]; if (b.barter_sign !== undefined) b.barter_sign = Number(b.barter_sign); b.file_ids = form.file_ids; if (k === 'expense' && form.expense_type === 'shared') b.shares = shares.filter((s) => s.order_id && s.amount); if (isMoney && allocs.length) b.allocations = allocs.filter((a) => a.amount && (a.to_document_id || a.order_id)); act.mutate(b); }}>
      <Back to="/documents">اسناد</Back><h1>سند جدید — {E[k]}</h1>
      {isMoney && !can('finance.post') && <div className="alert warn">دریافت/پرداختی که ثبت می‌کنید «گزارش‌شده» است و تا تأیید مالی در مانده حساب اثر ندارد.</div>}
      <ConflictBanner err={act.error} fields={L} />
      <div className="card"><div className="grid2">{specs.map((s) => <FieldEditor key={s.k} spec={s} form={form} set={set} error={act.error?.fields?.[s.k]} />)}</div>
        {k === 'invoice' && order.data && <div className="muted">سفارش {fa(String(order.data.number))}: وزن {num((order.data.totals as { total_kg: string }).total_kg, 'weight')} کیلو · مبنای تسویه {ev(order.data.settlement_basis)}</div>}
        <div className="row"><FileUpload kind="receipt" capture accept="image/*,application/pdf" label="📷 رسید / فیش" onDone={(f) => set('file_ids', [...((form.file_ids as string[]) ?? []), f.id])} />{((form.file_ids as string[]) ?? []).map((id) => <Thumb key={id} id={id} size={48} />)}</div>
      </div>
      {k === 'expense' && form.expense_type === 'shared' && <div className="card"><h2>سهم سفارش‌ها (R16)</h2>{shares.map((s, i) => <div key={i} className="row"><Picker path="/orders" value={s.order_id} label={showOrder as (r: { id: string }) => string} onChange={(oid) => setShares(shares.map((x, j) => (j === i ? { ...x, order_id: oid } : x)))} /><NumInput value={s.amount} onChange={(v) => setShares(shares.map((x, j) => (j === i ? { ...x, amount: v } : x)))} /></div>)}<button type="button" className="btn" onClick={() => setShares([...shares, { order_id: null, amount: null }])}>+ سهم</button><p className="muted">اگر سهمی ندهید، سرور بر اساس وزن سفارش‌های مرتبط تقسیم می‌کند.</p></div>}
      {isMoney && (openItems.data?.items.length ?? 0) > 0 && <div className="card"><h2>تخصیص به اقلام باز (R24)</h2><Table head={['سند', 'نوع', 'باقیمانده', 'تخصیص']} rows={openItems.data!.items.map((it) => { const a = allocs.find((x) => x.to_document_id === it.id); return [fa(String(it.number)), ev(it.kind), money(it.remaining, String(it.currency)), <NumInput value={a?.amount ?? null} onChange={(v) => setAllocs(v ? [...allocs.filter((x) => x.to_document_id !== it.id), { to_document_id: String(it.id), amount: v }] : allocs.filter((x) => x.to_document_id !== it.id))} />]; })} /></div>}
      <div className="row"><button className="btn primary" type="submit" disabled={act.isPending}>ثبت</button><button className="btn" type="button" onClick={() => nav(-1)}>انصراف</button></div>
    </form>
  );
}

export function DocumentDetail() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const d = useOne<Record<string, unknown>>(`/documents/${id}`);
  const [alloc, setAlloc] = useState<{ to_document_id: string | null; order_id: string | null; amount: string | null; rate: string | null }>({ to_document_id: null, order_id: null, amount: null, rate: null });
  const doAlloc = useAct<Record<string, unknown>>('POST', `/documents/${id}/allocate`, { onSuccess: () => { setAlloc({ to_document_id: null, order_id: null, amount: null, rate: null }); void qc.invalidateQueries(); } });
  const unalloc = useAct<Record<string, unknown>>('POST', `/documents/${id}/unallocate`, { onSuccess: () => void qc.invalidateQueries() });
  const patch = useAct<Record<string, unknown>>('PATCH', `/documents/${id}`, { onSuccess: () => void qc.invalidateQueries() });
  const refresh = () => void qc.invalidateQueries();
  if (!d.data) return <p className="muted">…</p>;
  const x = d.data;
  const version = Number(x.version);
  const st = String(x.status);
  const cur = String(x.currency);
  const lines = (x.lines as Array<Record<string, unknown>>) ?? [];
  const out = (x.allocations_out as Array<Record<string, unknown>>) ?? [];
  const inn = (x.allocations_in as Array<Record<string, unknown>>) ?? [];
  const shares = (x.shares as Array<Record<string, unknown>>) ?? [];
  const isMoney = x.kind === 'receipt' || x.kind === 'payment';
  const printable = x.kind === 'invoice' || x.kind === 'sales_return';
  const openItems = useOne<{ items: Array<Record<string, unknown>> }>(isMoney && x.party_id && st === 'posted' ? `/parties/${x.party_id}/open-items` : null);
  return (
    <div className="stack">
      <Back to="/documents">اسناد</Back>
      <div className="row between"><h1>{E[String(x.kind)]} {fa(String(x.number))}</h1><div className="row"><Status s={st} map={DST} />{x.locked ? <span className="badge">قفل</span> : null}</div></div>
      {st === 'void' && <div className="alert danger">این سند باطل شده است. {x.reversed_by_document_id ? <Link to={`/documents/${x.reversed_by_document_id}`}>سند معکوس</Link> : null}</div>}
      {x.reverses_document_id ? <div className="alert warn">سند معکوس برای <Link to={`/documents/${x.reverses_document_id}`}>سند اصلی</Link></div> : null}
      <div className="card"><Details r={x} keys={['party_name', 'order_number', 'date', 'due_date', 'amount', 'currency', 'method', 'account_name', 'tracking_no', 'expense_type', 'expense_category', 'purchase_kind', 'agreed_kg', 'received_kg', 'unit_price', 'settlement_basis_kg', 'barter_kg', 'description', 'note', 'posted_at', 'print_count']} />
        {can('finance.view') && x.remaining !== undefined && <div className="row" style={{ marginTop: 6 }}><span className="badge">تخصیص‌یافته {money(x.allocated ?? '0', cur)}</span><span className={`badge ${Number(x.remaining) ? 'warn' : 'ok'}`}>باقیمانده {money(x.remaining, cur)}</span></div>}
        {Array.isArray(x.file_ids) && (x.file_ids as string[]).length > 0 && <div className="row" style={{ marginTop: 6 }}>{(x.file_ids as string[]).map((f) => <Thumb key={f} id={f} />)}</div>}
        {x.transfer_id ? <Link className="muted" to={`/transfers/${x.transfer_id}`}>حواله مرتبط</Link> : null}
      </div>
      {lines.length > 0 && <div className="card"><h2>ردیف‌ها</h2><Table head={['شرح', 'تعداد', 'واحد', 'قیمت واحد', 'مبلغ']} rows={lines.map((l) => [String(l.description), l.qty ? num(l.qty, l.unit === 'kg' ? 'weight' : undefined) : '—', ev(l.unit), l.unit_price ? money(l.unit_price, cur) : '—', money(l.amount, cur)])} /></div>}
      <div className="card"><h2>اقدام‌ها</h2><ConflictBanner err={patch.error ?? doAlloc.error ?? unalloc.error} fields={L} /><div className="row">
        {(st === 'draft' || st === 'reported' || st === 'needs_completion') && <Action label="قطعی کردن" perm="finance.post" path={`/documents/${id}/post`} version={version} onDone={refresh} confirm="سند بعد از قطعی شدن تغییر نمی‌کند؛ فقط با سند معکوس باطل می‌شود." />}
        {st !== 'void' && <Action label="ابطال با سند معکوس" perm="finance.post" danger path={`/documents/${id}/void`} version={version} onDone={refresh} fields={[{ k: 'reason', t: 'textarea', req: true }]} />}
        {st === 'posted' && <Link className="btn" to={`/settings/corrections?entity=documents&id=${id}`}>درخواست اصلاح</Link>}
        {printable && <PdfButtons path={`/documents/${id}/pdf`} name={`${x.kind}-${x.number}`} />}
        {(st === 'draft' || st === 'reported' || st === 'needs_completion') && <Action label="ویرایش مبلغ/شرح" path={`/documents/${id}`} version={version} onDone={refresh} fields={[{ k: 'amount', t: 'num' }, { k: 'description', t: 'text' }, { k: 'method', t: 'select', opts: METHODS }, { k: 'note', t: 'textarea' }]} body={{}} />}
      </div></div>
      {can('finance.view') && (out.length > 0 || inn.length > 0 || isMoney) && <div className="card"><h2>تخصیص‌ها (R24)</h2>
        {out.length > 0 && <Table head={['به', 'مبلغ', 'در ارز هدف', '']} rows={out.map((a) => [a.to_document_id ? <Link to={`/documents/${a.to_document_id}`}>{fa(String(a.to_number ?? ''))}</Link> : `سفارش ${fa(String(a.order_number ?? ''))}`, money(a.amount, String(a.currency)), a.amount_in_target_currency ? money(a.amount_in_target_currency, String(a.target_currency)) : '—', st === 'posted' ? <button className="btn" onClick={() => unalloc.mutate({ version, allocation_id: a.id })}>حذف</button> : ''])} />}
        {inn.length > 0 && <Table head={['از', 'نوع', 'مبلغ']} rows={inn.map((a) => [<Link to={`/documents/${a.from_document_id}`}>{fa(String(a.from_number ?? ''))}</Link>, ev(a.from_kind), money(a.amount_in_target_currency ?? a.amount, cur)])} />}
        {isMoney && st === 'posted' && Number(x.remaining) > 0 && <div className="toolbar" style={{ marginTop: 8 }}>
          <label className="field"><span>به سند باز</span><select value={alloc.to_document_id ?? ''} onChange={(e) => setAlloc({ ...alloc, to_document_id: e.target.value || null, order_id: null })}><option value="">—</option>{(openItems.data?.items ?? []).map((it) => <option key={String(it.id)} value={String(it.id)}>{String(it.number)} {E[String(it.kind)]} — {money(it.remaining, String(it.currency))}</option>)}</select></label>
          <label className="field"><span>یا به سفارش (پیش‌پرداخت)</span><Picker path="/orders" value={alloc.order_id} label={showOrder as (r: { id: string }) => string} onChange={(oid) => setAlloc({ ...alloc, order_id: oid, to_document_id: null })} /></label>
          <label className="field"><span>مبلغ</span><NumInput value={alloc.amount} onChange={(v) => setAlloc({ ...alloc, amount: v })} /></label>
          <label className="field"><span>نرخ توافقی (اگر ارز متفاوت)</span><NumInput value={alloc.rate} onChange={(v) => setAlloc({ ...alloc, rate: v })} /></label>
          <button className="btn primary" disabled={!alloc.amount || (!alloc.to_document_id && !alloc.order_id) || doAlloc.isPending} onClick={() => doAlloc.mutate({ version, items: [{ to_document_id: alloc.to_document_id ?? undefined, order_id: alloc.order_id ?? undefined, amount: alloc.amount, rate: alloc.rate ?? undefined }] })}>تخصیص</button>
        </div>}
      </div>}
      {can('finance.view') && x.kind === 'expense' && <div className="card"><h2>سهم سفارش‌ها</h2><Table head={['سفارش', 'مبلغ']} rows={shares.map((s) => [<Link to={`/orders/${s.order_id}`}>{fa(String(s.order_number ?? ''))}</Link>, money(s.amount, cur)])} /></div>}
    </div>
  );
}

export const AccountsPage = () => <ListPage title="حساب‌های بانکی و صندوق" path="/accounts" newTo="/accounts/new" perm="finance.post" rowTo={(r) => `/accounts/${r.id}/edit`} cols={[{ k: 'name' }, { k: 'kind' }, { k: 'currency' }, { k: 'active' }]} />;
export function AccountForm() { const { id } = useParams(); const nav = useNavigate(); const isNew = !id || id === 'new'; return <EntityForm title={isNew ? 'حساب جدید' : 'ویرایش حساب'} path="/accounts" id={isNew ? undefined : id} specs={isNew ? [{ k: 'name', t: 'text', req: true }, { k: 'kind', t: 'select', opts: ['bank', 'cash'], req: true }, { k: 'currency', t: 'select', opts: CUR, req: true }] : [{ k: 'name', t: 'text', req: true }, { k: 'active', t: 'bool' }]} initial={{ kind: 'bank', currency: 'TOMAN' }} onSaved={() => nav('/accounts')} />; }
export const FxPage = () => <ListPage title="نرخ‌های ارز" path="/fx-rates" newTo="/fx-rates/new" perm="finance.post" rowTo={() => '/fx-rates'} cols={[{ k: 'at' }, { k: 'from_currency', l: 'از' }, { k: 'to_currency', l: 'به' }, { k: 'rate', l: 'نرخ', f: (v) => num(v) }, { k: 'kind', f: (v) => (v === 'agreed_settlement' ? 'توافقی تسویه' : 'روزانه (گزارش)') }, { k: 'source_text', l: 'منبع' }]} />;
export function FxForm() { const nav = useNavigate(); return <EntityForm title="نرخ ارز جدید" path="/fx-rates" specs={[{ k: 'from_currency', t: 'select', opts: CUR, req: true, label: 'از ارز' }, { k: 'to_currency', t: 'select', opts: CUR, req: true, label: 'به ارز' }, { k: 'rate', t: 'num', req: true, label: 'نرخ' }, { k: 'kind', t: 'select', opts: ['report_daily', 'agreed_settlement'], req: true, label: 'نوع' }, { k: 'at', t: 'datetime' }, { k: 'source_text', t: 'text', label: 'منبع' }]} initial={{ from_currency: 'USD', to_currency: 'TOMAN', kind: 'report_daily' }} onSaved={() => nav('/fx-rates')} />; }
export { jdate, Select };
