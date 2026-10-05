import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { formatJalali, jalaliOf, toGregorian, toJalali } from '@vitral/shared';
import { Action, Details, E, EntityForm, ev, FieldEditor, L, ListPage, showOrder, showParty, showProduct, useForm, type FieldSpec } from '../components/entity.js';
import { Back, ConflictBanner, FileUpload, JalaliInput, PdfButtons, Status, Table, Tabs, Thumb, fa, jdt, money, num } from '../components/ui.js';
import { useAuth } from '../lib/auth.js';
import { downloadBlob, qs, useAct, useOne } from '../lib/hooks.js';
import { api } from '../api/client.js';

const TOPICS = ['paint_purchase', 'tool_purchase', 'bill_payment', 'freight_cost', 'misc_delivery', 'damage', 'other'];
const TOPIC_FA: Record<string, string> = { paint_purchase: 'خرید رنگ', tool_purchase: 'خرید ابزار', bill_payment: 'پرداخت قبض', freight_cost: 'کرایه', misc_delivery: 'تحویل متفرقه', damage: 'خرابی', other: 'دیگر' };
const NST: Record<string, [string, string?]> = { new: ['تازه', 'warn'], needs_info: ['نیاز به اطلاعات', 'warn'], reviewed: ['بررسی‌شده'], converted: ['تبدیل‌شده', 'ok'], rejected: ['ردشده', 'danger'] };
for (const [k, v] of Object.entries(TOPIC_FA)) E[k] = v;

export const NotesPage = () => <ListPage title="یادداشت‌های آزاد" path="/free-notes" newTo="/notes/new" rowTo={(r) => `/notes/${r.id}`} cols={[{ k: 'created_at' }, { k: 'text', f: (v, r) => (r.sensitive && !v ? <i className="muted">محرمانه</i> : String(v ?? '').slice(0, 90)) }, { k: 'topic' }, { k: 'amount', f: (v, r) => (v ? money(v, String(r.currency)) : '—') }, { k: 'user_name', l: 'ثبت‌کننده' }, { k: 'status', f: (v) => <Status s={String(v)} map={NST} /> }]} filters={[{ k: 'status', l: 'وضعیت', t: 'select', opts: Object.keys(NST) }, { k: 'topic', l: 'موضوع', t: 'select', opts: TOPICS }, { k: 'mine', l: 'فقط من', t: 'bool' }]} />;

/** Free note: text / voice / photo + optional amount, party, kg; a reviewer converts it later (T40). */
export function NoteForm() {
  const nav = useNavigate();
  const [files, setFiles] = useState<string[]>([]);
  const specs: FieldSpec[] = [{ k: 'text', t: 'textarea', req: true, label: 'متن (هر چیزی: «۲ کارتن رنگ سفید خریدم ۳ میلیون»)' }, { k: 'topic', t: 'select', opts: TOPICS }, { k: 'amount', t: 'num' }, { k: 'currency', t: 'select', opts: ['TOMAN', 'USD', 'IQD'] }, { k: 'party_id', t: 'pick', path: '/parties', show: showParty }, { k: 'order_id', t: 'pick', path: '/orders', show: showOrder }, { k: 'kg', t: 'num', unit: 'کیلو' }, { k: 'qty', t: 'num', label: 'تعداد' }, { k: 'occurred_at', t: 'datetime' }, { k: 'sensitive', t: 'bool', label: 'محرمانه (فقط مالی می‌بیند)' }];
  return <EntityForm title="یادداشت جدید" path="/free-notes" specs={specs} initial={{ currency: 'TOMAN', sensitive: false }} transform={(b) => ({ ...b, file_ids: files })} onSaved={() => nav('/notes')}>
    <div className="row"><FileUpload kind="voice" accept="audio/*" label="🎤 ویس" onDone={(f) => setFiles([...files, f.id])} /><FileUpload kind="receipt" capture accept="image/*" label="📷 عکس" onDone={(f) => setFiles([...files, f.id])} /><span className="muted">{fa(files.length)} پیوست</span></div>
  </EntityForm>;
}

export function NoteDetail() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const n = useOne<Record<string, unknown>>(`/free-notes/${id}`);
  const { form, set } = useForm({ effect: 'expense', party_id: null, amount: null, currency: 'TOMAN', order_id: null, expense_type: 'general', expense_category: null, purchase_kind: 'paint_powder', transfer_id: null });
  const convert = useAct<Record<string, unknown>>('POST', `/free-notes/${id}/convert`, { onSuccess: () => void qc.invalidateQueries() });
  if (!n.data) return <p className="muted">…</p>;
  const x = n.data;
  const version = Number(x.version);
  const refresh = () => void qc.invalidateQueries();
  const files = (x.file_ids as string[]) ?? [];
  const E_EFFECT: Array<[string, string]> = [['expense', 'هزینه'], ['purchase', 'خرید (پارت مواد)'], ['payment_for_purchase', 'پرداخت بابت خرید'], ['purchase_and_payment', 'خرید + پرداخت'], ['link_transfer', 'پیوند به حواله']];
  return (
    <div className="stack">
      <Back to="/notes">یادداشت‌ها</Back>
      <div className="row between"><h1>یادداشت</h1><Status s={String(x.status)} map={NST} /></div>
      <div className="card"><p style={{ whiteSpace: 'pre-wrap' }}>{String(x.text ?? '')}</p><Details r={x} keys={['topic', 'amount', 'currency', 'party_name', 'order_number', 'kg', 'qty', 'occurred_at', 'user_name', 'created_at', 'review_note']} />
        <div className="row">{files.map((f) => <FileLink key={f} id={f} />)}</div>
        {Array.isArray(x.converted_document_ids) && (x.converted_document_ids as string[]).length > 0 && <div className="row">{(x.converted_document_ids as string[]).map((d) => <Link key={d} className="badge ok" to={`/documents/${d}`}>سند ساخته‌شده</Link>)}</div>}
      </div>
      {can('finance.post') && x.status !== 'converted' && <div className="card"><h2>بررسی</h2><div className="row">
        <Action label="نیاز به اطلاعات" path={`/free-notes/${id}/review`} version={version} body={{ status: 'needs_info' }} fields={[{ k: 'review_note', t: 'text', label: 'چه چیزی لازم است؟' }]} onDone={refresh} />
        <Action label="بررسی شد (بدون سند)" path={`/free-notes/${id}/review`} version={version} body={{ status: 'reviewed' }} onDone={refresh} />
        <Action label="رد" danger path={`/free-notes/${id}/review`} version={version} body={{ status: 'rejected' }} fields={[{ k: 'review_note', t: 'text' }]} onDone={refresh} />
      </div>
        <h2 style={{ marginTop: 12 }}>تبدیل به سند (T40)</h2><ConflictBanner err={convert.error} fields={L} />
        <div className="grid2">
          <label className="field"><span>اثر</span><select value={String(form.effect)} onChange={(e) => set('effect', e.target.value)}>{E_EFFECT.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
          {form.effect !== 'link_transfer' && <><FieldEditor spec={{ k: 'party_id', t: 'pick', path: '/parties', show: showParty, label: 'طرف (خالی = از یادداشت)' }} form={form} set={set} /><FieldEditor spec={{ k: 'amount', t: 'num', label: 'مبلغ (خالی = از یادداشت)' }} form={form} set={set} /><FieldEditor spec={{ k: 'currency', t: 'select', opts: ['TOMAN', 'USD', 'IQD'] }} form={form} set={set} /><FieldEditor spec={{ k: 'order_id', t: 'pick', path: '/orders', show: showOrder }} form={form} set={set} /></>}
          {form.effect === 'expense' && <><FieldEditor spec={{ k: 'expense_type', t: 'select', opts: ['order', 'shared', 'general'] }} form={form} set={set} /><FieldEditor spec={{ k: 'expense_category', t: 'text' }} form={form} set={set} /></>}
          {form.effect !== 'expense' && form.effect !== 'link_transfer' && <FieldEditor spec={{ k: 'purchase_kind', t: 'select', opts: ['ingot', 'billet', 'scrap', 'paint_powder', 'tool', 'other'] }} form={form} set={set} />}
          {form.effect === 'link_transfer' && <FieldEditor spec={{ k: 'transfer_id', t: 'pick', path: '/transfers', show: (t) => `${t.number} ${E[String(t.kind)] ?? ''}`, req: true, label: 'حواله' }} form={form} set={set} />}
        </div>
        <button className="btn primary" disabled={convert.isPending} onClick={() => convert.mutate({ version, ...form })}>تبدیل</button>
      </div>}
    </div>
  );
}
function FileLink({ id }: { id: string }) {
  const f = useOne<{ mime: string; original_name: string }>(`/files/${id}`);
  if (!f.data) return null;
  if (f.data.mime.startsWith('image/')) return <Thumb id={id} />;
  if (f.data.mime.startsWith('audio/')) return <audio controls src={`/api/v1/files/${id}/download`} />;
  return <a className="btn" href={`/api/v1/files/${id}/download`} target="_blank" rel="noreferrer">{f.data.original_name}</a>;
}

// ───────── Tasks ─────────
const TST: Record<string, [string, string?]> = { open: ['باز', 'warn'], done: ['انجام شد', 'ok'], cancelled: ['لغو'] };
export const TasksPage = () => <ListPage title="کارها" path="/tasks" newTo="/tasks/new" rowTo={(r) => `/tasks/${r.id}`} cols={[{ k: 'title' }, { k: 'assignee_name', l: 'مسئول' }, { k: 'due_at' }, { k: 'order_number' }, { k: 'status', f: (v) => <Status s={String(v)} map={TST} /> }]} filters={[{ k: 'status', l: 'وضعیت', t: 'select', opts: Object.keys(TST) }, { k: 'assignee_user_id', l: 'مسئول', t: 'pick', path: '/users/directory', show: (u) => String(u.name) }, { k: 'overdue', l: 'عقب‌افتاده', t: 'bool' }]} />;
export function TaskForm() {
  const { id } = useParams(); const nav = useNavigate(); const isNew = !id || id === 'new'; const { me } = useAuth();
  const [voice, setVoice] = useState<string | null>(null);
  return <EntityForm title={isNew ? 'کار جدید' : 'ویرایش کار'} path="/tasks" id={isNew ? undefined : id} specs={[{ k: 'title', t: 'text', req: true }, { k: 'description', t: 'textarea' }, { k: 'assignee_user_id', t: 'pick', path: '/users/directory', show: (u) => String(u.name), req: true }, { k: 'due_at', t: 'datetime' }, { k: 'order_id', t: 'pick', path: '/orders', show: showOrder }, { k: 'party_id', t: 'pick', path: '/parties', show: showParty }, { k: 'transfer_id', t: 'pick', path: '/transfers', show: (t) => String(t.number) }]} initial={{ assignee_user_id: me?.user.id ?? null }} transform={(b) => ({ ...b, voice_file_id: voice ?? b.voice_file_id })} onSaved={(r) => nav(`/tasks/${r.id}`)}><FileUpload kind="voice" accept="audio/*" label="🎤 ویس" onDone={(f) => setVoice(f.id)} /></EntityForm>;
}
export function TaskDetail() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const t = useOne<Record<string, unknown>>(`/tasks/${id}`);
  const [text, setText] = useState('');
  const comment = useAct<Record<string, unknown>>('POST', `/tasks/${id}/comments`, { onSuccess: () => { setText(''); void qc.invalidateQueries(); } });
  if (!t.data) return <p className="muted">…</p>;
  const x = t.data;
  const comments = (x.comments as Array<Record<string, unknown>>) ?? [];
  return (
    <div className="stack">
      <Back to="/tasks">کارها</Back>
      <div className="row between"><h1>{String(x.title)}</h1><div className="row"><Status s={String(x.status)} map={TST} /><Link className="btn" to={`/tasks/${id}/edit`}>ویرایش</Link></div></div>
      <div className="card"><Details r={x} keys={['description', 'assignee_name', 'due_at', 'order_number', 'party_name', 'done_at', 'done_note', 'created_at']} />{x.voice_file_id ? <audio controls src={`/api/v1/files/${x.voice_file_id}/download`} /> : null}
        {x.status === 'open' && <div className="row" style={{ marginTop: 8 }}><Action label="انجام شد ✓" path={`/tasks/${id}/done`} version={Number(x.version)} fields={[{ k: 'done_note', t: 'text', label: 'یادداشت انجام' }]} onDone={() => void qc.invalidateQueries()} /></div>}
      </div>
      <div className="card"><h2>گفتگو</h2>{comments.map((c) => <div key={String(c.id)} className="lines"><div className="line"><span>{String(c.text ?? '')}{c.file_id ? <> <FileLink id={String(c.file_id)} /></> : null}</span><span className="muted">{String(c.user_name ?? '')} · {jdt(String(c.created_at))}</span></div></div>)}
        <div className="row"><input value={text} placeholder="پیام…" onChange={(e) => setText(e.target.value)} /><button className="btn" disabled={!text.trim() || comment.isPending} onClick={() => comment.mutate({ text })}>ارسال</button><FileUpload kind="other" label="پیوست" onDone={(f) => comment.mutate({ file_id: f.id })} /></div></div>
    </div>
  );
}

// ───────── Notifications ─────────
export function NotificationsPage() {
  const qc = useQueryClient();
  const n = useOne<{ items: Array<Record<string, unknown>> }>('/notifications?limit=100');
  const read = useAct<Record<string, unknown>>('POST', '/notifications/read', { onSuccess: () => void qc.invalidateQueries() });
  const target = (x: Record<string, unknown>) => ({ bundles: '/bundles/', orders: '/orders/', documents: '/documents/', transfers: '/transfers/', free_notes: '/notes/', tasks: '/tasks/', production_runs: '/production/', coating_runs: '/coating/' } as Record<string, string>)[String(x.entity)];
  return <div className="stack"><div className="row between"><h1>اعلان‌ها</h1><button className="btn" onClick={() => read.mutate({ all: true })}>همه خوانده شد</button></div>
    <div className="list">{(n.data?.items ?? []).map((x) => { const to = target(x); const inner = <><div className="grow"><div className={x.read_at ? 'muted' : 'title'}>{String(x.title)}</div><div className="muted">{jdt(String(x.created_at))}</div></div>{!x.read_at && <button className="btn" onClick={(e) => { e.preventDefault(); read.mutate({ ids: [x.id] }); }}>خوانده شد</button>}</>; return to && x.entity_id ? <Link key={String(x.id)} className="item" to={`${to}${x.entity_id}`}>{inner}</Link> : <div key={String(x.id)} className="item">{inner}</div>; })}</div></div>;
}

// ───────── Daily report ─────────
export function DailyReportPage() {
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const qc = useQueryClient();
  const date = sp.get('date') ?? '';
  const [tab, setTab] = useState<'text' | 'full'>('text');
  const r = useOne<Record<string, unknown>>(`/reports/daily${qs({ date: date || undefined, snapshot: sp.get('snapshot') ?? undefined })}`);
  const snap = useAct<Record<string, unknown>>('POST', '/reports/daily/snapshot', { onSuccess: () => void qc.invalidateQueries() });
  const [share, setShare] = useState<string | null>(null);
  const x = r.data;
  const prod = x?.production as { text: string; text_full: string; total_kg: string; bundle_count: number; groups: Array<Record<string, unknown>> } | undefined;
  const dec = x?.decisions as { quarantine: Array<Record<string, unknown>>; weight_warnings: Array<Record<string, unknown>>; incomplete_documents: Array<Record<string, unknown>>; pending_money: number } | undefined;
  const transfers = (x?.transfers as Array<Record<string, unknown>>) ?? [];
  const moneyRows = x?.money as Array<Record<string, unknown>> | null | undefined;
  const notes = (x?.free_notes as Array<Record<string, unknown>>) ?? [];
  const tasks = x?.tasks as { closed: Array<Record<string, unknown>>; open: Array<Record<string, unknown>> } | undefined;
  const today = formatJalali(jalaliOf(new Date()));
  const dateArg = date || today;
  const makeShare = async () => { const s = await api<{ url: string }>('POST', '/share-links', { body: { scope_type: 'daily_report', scope_date: dateArg, expires_in_days: 7 }, idempotencyKey: crypto.randomUUID() }); setShare(`${location.origin}${s.url}`); };
  return (
    <div className="stack">
      <div className="row between"><h1>گزارش روزانه</h1><div className="row"><label className="row"><span className="muted">تاریخ</span><JalaliInput value={date ? isoOfJalali(date) : null} onChange={(iso) => { const n = new URLSearchParams(sp); if (iso) n.set('date', jalaliOfIso(iso)); else n.delete('date'); setSp(n); }} /></label>{can('settings.manage') && <button className="btn" disabled={snap.isPending} onClick={() => snap.mutate({ date: dateArg })}>ثبت نسخه قطعی</button>}<button className="btn" onClick={() => void makeShare()}>لینک مهمان</button><button className="btn" onClick={() => void downloadBlob(`/reports/daily/photos.zip${qs({ date: dateArg })}`, `photos-${dateArg.replace(/\//g, '-')}.zip`)}>عکس‌های روز (zip)</button></div></div>
      <div className="row"><span className="muted">PDF گزارش:</span><PdfButtons path="/reports/daily.pdf" name={`daily-${dateArg.replace(/\//g, '-')}`} langs={['fa']} png={false} params={{ date: dateArg, full: tab === 'full' ? 1 : 0 }} label={tab === 'full' ? 'PDF کامل' : 'PDF خلاصه'} /></div>
      {snap.error && <div className="alert danger">{snap.error.message}</div>}
      {snap.isSuccess && <div className="alert ok">نسخه قطعی این روز ثبت شد.</div>}
      {share && <div className="alert ok">لینک ۷ روزه: <input dir="ltr" readOnly value={share} onFocus={(e) => e.target.select()} /> <button className="btn" onClick={() => void navigator.clipboard.writeText(share)}>کپی</button></div>}
      {!x && <p className="muted">…</p>}
      {x && prod && <>
        <div className="card"><div className="row between"><h2>تولید {fa(String(x.date))}</h2><Tabs value={tab} onChange={setTab} tabs={[['text', 'متن تلگرام'], ['full', 'کامل']]} /></div>
          <pre className="report">{tab === 'text' ? prod.text : prod.text_full}</pre>
          <button className="btn" onClick={() => void navigator.clipboard.writeText(tab === 'text' ? prod.text : prod.text_full)}>کپی متن</button></div>
        {dec && <div className="card"><h2>نیازمند تصمیم</h2>
          {dec.quarantine.length > 0 && <Table head={['بندیل', 'وزن', 'وضعیت', 'کارخانه']} rows={dec.quarantine.map((q) => [<Link to={`/bundles/${q.id}`}>{fa(String(q.code))}</Link>, num(q.weight_kg, 'weight'), ev(q.status), String(q.factory_name ?? '')])} />}
          {dec.weight_warnings.length > 0 && <Table head={['بندیل', 'وزن', 'هشدار']} rows={dec.weight_warnings.map((q) => [<Link to={`/bundles/${q.id}`}>{fa(String(q.code))}</Link>, num(q.weight_kg, 'weight'), ((q.warnings as Array<{ message?: string }>) ?? []).map((w) => w.message).join('؛ ')])} />}
          {dec.incomplete_documents.length > 0 && <Table head={['نوع', 'شماره/حواله', 'شرح']} rows={dec.incomplete_documents.map((q) => [q.type === 'scale_ticket' ? 'قبض باسکول' : ev(q.kind), String(q.number ?? q.transfer_number ?? ''), String(q.description ?? q.stage ?? '')])} />}
          {dec.pending_money ? <div className="badge warn">{fa(dec.pending_money)} دریافت/پرداخت در انتظار تأیید</div> : null}
          {!dec.quarantine.length && !dec.weight_warnings.length && !dec.incomplete_documents.length && !dec.pending_money && <p className="muted">چیزی نیست ✅</p>}</div>}
        <div className="card"><h2>بارها</h2><Table head={['شماره', 'نوع', 'از', 'به', 'کیلو', 'دریافتی', 'وضعیت', 'قبض']} rows={transfers.map((t) => [<Link to={`/transfers/${t.id}`}>{fa(String(t.number))}</Link>, ev(t.kind), String(t.from_name ?? ''), String(t.to_name ?? ''), num(t.kg, 'weight'), num(t.received_kg, 'weight'), ev(t.status), fa(String(t.tickets ?? 0))])} /></div>
        {moneyRows && <div className="card"><h2>دریافت و پرداخت</h2><Table head={['نوع', 'شماره', 'طرف', 'مبلغ', 'روش', 'وضعیت', 'ثبت‌کننده']} rows={moneyRows.map((m) => [ev(m.kind), <Link to={`/documents/${m.id}`}>{fa(String(m.number))}</Link>, String(m.party_name ?? ''), money(m.amount, String(m.currency)), ev(m.method), ev(m.status), String(m.reported_by_name ?? '')])} /></div>}
        <div className="card"><h2>یادداشت‌های آزاد</h2><Table head={['متن', 'موضوع', 'مبلغ', 'وضعیت', 'ثبت‌کننده']} rows={notes.map((nn) => [<Link to={`/notes/${nn.id}`}>{String(nn.text ?? 'محرمانه').slice(0, 80)}</Link>, ev(nn.topic), nn.amount ? money(nn.amount, String(nn.currency)) : '—', ev(nn.status), String(nn.user_name ?? '')])} /></div>
        {tasks && <div className="card"><h2>کارها</h2><div className="row"><span className="badge ok">انجام‌شده امروز: {fa(tasks.closed.length)}</span><span className="badge warn">باز: {fa(tasks.open.length)}</span></div><Table head={['کار', 'مسئول', 'سررسید']} rows={tasks.open.slice(0, 20).map((t) => [<Link to={`/tasks/${t.id}`}>{String(t.title)}</Link>, String(t.assignee ?? ''), t.due_at ? jdt(String(t.due_at)) : '—'])} /></div>}
      </>}
    </div>
  );
}
export function isoOfJalali(j: string): string | null { const p = j.split('/').map(Number); if (p.length !== 3) return null; const g = toGregorian(p[0]!, p[1]!, p[2]!); return `${g.gy}-${String(g.gm).padStart(2, '0')}-${String(g.gd).padStart(2, '0')}`; }
export function jalaliOfIso(iso: string): string { const [y, m, d] = iso.split('-').map(Number); return formatJalali(toJalali(y!, m!, d!)); }

// ───────── Gallery ─────────
export function GalleryPage() {
  const [sp, setSp] = useSearchParams();
  const params = { date: sp.get('date') ?? undefined, party_id: sp.get('party_id') ?? undefined, product_id: sp.get('product_id') ?? undefined, stage: sp.get('stage') ?? undefined };
  const g = useOne<{ items: Array<Record<string, unknown>> }>(`/gallery${qs(params)}`);
  const setF = (k: string, v: string | null) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); setSp(n, { replace: true }); };
  return <div className="stack"><h1>گالری عکس</h1>
    <div className="toolbar card compact"><label className="field" style={{ margin: 0 }}><span>تاریخ</span><JalaliInput value={params.date ? isoOfJalali(params.date) : null} onChange={(iso) => setF('date', iso ? jalaliOfIso(iso) : null)} /></label><label className="field" style={{ margin: 0 }}><span>مرحله</span><select value={params.stage ?? ''} onChange={(e) => setF('stage', e.target.value || null)}><option value="">همه</option><option value="production">تولید</option><option value="coating">رنگ</option><option value="transfer">بار</option><option value="scale">باسکول</option></select></label><FieldEditor spec={{ k: 'party_id', t: 'pick', path: '/parties', show: showParty, label: 'کارگاه' }} form={{ party_id: params.party_id }} set={(_, v) => setF('party_id', v as string | null)} /><FieldEditor spec={{ k: 'product_id', t: 'pick', path: '/products', show: showProduct, label: 'محصول' }} form={{ product_id: params.product_id }} set={(_, v) => setF('product_id', v as string | null)} /></div>
    <div className="gallery">{(g.data?.items ?? []).map((f) => <figure key={String(f.id)}><a href={`/api/v1/files/${f.id}/download`} target="_blank" rel="noreferrer"><img src={`/api/v1/files/${f.id}/thumb`} alt="" loading="lazy" /></a><figcaption>{String(f.caption ?? f.auto_caption ?? '')}<br />{jdt(String(f.created_at))}</figcaption></figure>)}</div>
    {g.data && g.data.items.length === 0 && <p className="muted">عکسی نیست.</p>}</div>;
}

// ───────── Search ─────────
export function SearchPage() {
  const [q, setQ] = useState('');
  const [sub, setSub] = useState('');
  const r = useOne<Record<string, Array<Record<string, unknown>>>>(sub ? `/search${qs({ q: sub })}` : null);
  return <div className="stack"><h1>جستجو</h1><form className="row" onSubmit={(e) => { e.preventDefault(); setSub(q.trim()); }}><input autoFocus value={q} placeholder="کد بندیل، شماره سفارش، پلاک، نام…" onChange={(e) => setQ(e.target.value)} /><button className="btn primary">بگرد</button></form>
    {r.data && <>
      <div className="card"><h2>طرف‌ها</h2>{(r.data.parties ?? []).map((p) => <div key={String(p.id)}><Link to={`/parties/${p.id}`}>{String(p.name)}</Link> <span className="muted">{((p.roles as string[]) ?? []).map(ev).join('، ')}</span></div>)}</div>
      <div className="card"><h2>محصولات</h2>{(r.data.products ?? []).map((p) => <div key={String(p.id)}><Link to={`/products/${p.id}`}>{String(p.code ?? '')} {String(p.name_fa)}</Link></div>)}</div>
      <div className="card"><h2>سفارش‌ها</h2>{(r.data.orders ?? []).map((p) => <div key={String(p.id)}><Link to={`/orders/${p.id}`}>{fa(String(p.number))}</Link> {String(p.party_name)} <span className="badge">{ev(p.status_sales)}</span></div>)}</div>
      <div className="card"><h2>بارها</h2>{(r.data.transfers ?? []).map((p) => <div key={String(p.id)}><Link to={`/transfers/${p.id}`}>{fa(String(p.number))}</Link> {ev(p.kind)} <span className="badge">{ev(p.status)}</span> {String(p.plate ?? '')}</div>)}</div>
      <div className="card"><h2>بندیل‌ها</h2>{(r.data.bundles ?? []).map((p) => <div key={String(p.id)}><Link to={`/bundles/${p.id}`}>{fa(String(p.code))}</Link> {num(p.weight_kg, 'weight')} کیلو <span className="badge">{ev(p.status)}</span></div>)}</div>
    </>}</div>;
}
