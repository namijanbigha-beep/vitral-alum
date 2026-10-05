import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Action, Details, EntityForm, ListPage, showLocation, showParty, type FieldSpec } from '../components/entity.js';
import { Back, FileUpload, Table, fa, jdate, jdt, money } from '../components/ui.js';
import { useAuth } from '../lib/auth.js';
import { useOne } from '../lib/hooks.js';

/** Die-making order, six steps (spec §8 module 1, `die_orders` §7.3). Server: /die-orders CRUD + /die-orders/:id/advance. */
export const DIE_STEPS = ['drawing_received', 'quoted', 'ordered', 'delivered', 'trial_run', 'registered'] as const;
export const STEP_FA: Record<string, string> = {
  drawing_received: '۱ دریافت نقشه مشتری',
  quoted: '۲ برآورد و پیش‌فاکتور',
  ordered: '۳ سفارش به قالب‌ساز',
  delivered: '۴ تحویل قالب',
  trial_run: '۵ تولید آزمایشی و چک فیلر',
  registered: '۶ ثبت رسمی',
};
/** What each step records and causes (the spec's table), shown above the «next step» button. */
const STEP_HINT: Record<string, string> = {
  quoted: 'ردیف سفارش «ساخت قالب» با قیمت هر قالب در سفارش فروش مشتری ثبت شود.',
  ordered: 'قالب‌ساز و هزینه توافقی لازم است؛ سند خرید پیش‌نویس ساخته می‌شود.',
  delivered: 'عکس قالب و محل استقرار؛ سند خرید قطعی و بدهی به قالب‌ساز ثبت می‌شود.',
  trial_run: 'نوبت تولید آزمایشی؛ فیلر و وزن نمونه را در صفحه محصول «پیشنهادی» ثبت کنید.',
  registered: 'فقط مدیر؛ مالک قالب مشخص می‌شود، قالب «آماده» و محصول فعال می‌شود.',
};
const CUR = ['TOMAN', 'USD', 'IQD'];
const showDie = (r: Record<string, unknown>) => `${r.code}${r.name ? ` — ${r.name}` : ''}`;

/** Party / die names: the die-order row carries only ids; react-query caches each lookup. */
function Ref({ path, id, show, to }: { path: string; id: unknown; show: (r: Record<string, unknown>) => string; to?: string }) {
  const r = useOne<Record<string, unknown>>(id ? `${path}/${String(id)}` : null);
  if (!id) return <>—</>;
  const text = r.data ? show(r.data) : '…';
  return to ? <Link to={to}>{text}</Link> : <>{text}</>;
}

export function DieOrdersPage() {
  const { can } = useAuth();
  return <ListPage title="سفارش ساخت قالب" path="/die-orders" newTo="/die-orders/new" fixed={{ order: 'desc' }} rowTo={(r) => `/die-orders/${r.id}`} extra={<Link className="btn" to="/dies">قالب‌ها</Link>}
    cols={[
      { k: 'number', f: (v) => fa(String(v)) },
      { k: 'step', f: (v) => STEP_FA[String(v)] ?? String(v) },
      { k: 'customer_party_id', f: (v) => <Ref path="/parties" id={v} show={showParty} /> },
      { k: 'maker_party_id', l: 'قالب‌ساز', f: (v) => <Ref path="/parties" id={v} show={showParty} /> },
      { k: 'die_id', f: (v) => <Ref path="/dies" id={v} show={showDie} /> },
      { k: 'due_date' },
      ...(can('finance.view') ? [{ k: 'maker_cost', f: (v: unknown, r: Record<string, unknown>) => (v == null ? 'نامشخص' : money(v, String(r.currency))) }] : []),
    ]} />;
}

export function DieOrderForm() {
  const { id } = useParams();
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const { can } = useAuth();
  const isNew = !id || id === 'new';
  const specs: FieldSpec[] = [
    { k: 'customer_party_id', t: 'pick', path: '/parties', params: { role: 'customer' }, show: showParty, label: 'مشتری (خالی = قالب خود ویترال)' },
    { k: 'maker_party_id', t: 'pick', path: '/parties', params: { role: 'die_maker' }, show: showParty, label: 'قالب‌ساز' },
    { k: 'die_id', t: 'pick', path: '/dies', show: showDie, label: 'پرونده قالب' },
    { k: 'due_date', t: 'date', label: 'موعد تحویل' },
    // Server refuses maker_cost edits without finance.post; hide rather than fail.
    { k: 'maker_cost', t: 'num', label: 'هزینه توافقی قالب‌ساز', hidden: () => !can('finance.post') },
    { k: 'currency', t: 'select', opts: CUR, req: true, hidden: () => !can('finance.post') },
    { k: 'note', t: 'textarea' },
  ];
  return <EntityForm title={isNew ? 'سفارش ساخت قالب جدید' : 'ویرایش سفارش ساخت قالب'} path="/die-orders" id={isNew ? undefined : id} specs={specs} initial={{ currency: 'TOMAN', die_id: sp.get('die_id') }} onSaved={(r) => nav(`/die-orders/${r.id}`)} />;
}

export function DieOrderDetail() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const { me, can } = useAuth();
  const o = useOne<Record<string, unknown>>(`/die-orders/${id}`);
  const users = useOne<{ items: Array<{ id: string; name: string }> }>('/users/directory');
  const [files, setFiles] = useState<string[]>([]);
  if (!o.data) return <p className="muted">{o.error ? 'بارگذاری نشد.' : '…'}</p>;
  const r = o.data;
  const step = String(r.step);
  const idx = DIE_STEPS.indexOf(step as (typeof DIE_STEPS)[number]);
  const next = DIE_STEPS[idx + 1];
  const steps = (r.steps as Array<{ step: string; at: string; by?: string; note?: string | null; file_ids?: string[]; production_run_id?: string | null }>) ?? [];
  const userName = (uid?: string) => users.data?.items.find((u) => u.id === uid)?.name ?? '—';
  const done = () => { setFiles([]); void qc.invalidateQueries(); };
  const nextFields: FieldSpec[] = [
    ...(next === 'delivered' ? [{ k: 'location_id', t: 'pick', path: '/locations', show: showLocation, label: 'محل استقرار قالب' } as FieldSpec] : []),
    ...(next === 'trial_run' ? [{ k: 'production_run_id', t: 'pick', path: '/production-runs', show: (x: Record<string, unknown>) => fa(String(x.number)), label: 'نوبت تولید آزمایشی' } as FieldSpec] : []),
    ...(next === 'registered' ? [{ k: 'owner_party_id', t: 'pick', path: '/parties', show: showParty, label: 'مالک قالب (خالی = ویترال)' } as FieldSpec] : []),
    { k: 'note', t: 'textarea' },
  ];
  const canAdvance = next && (next !== 'registered' || me?.user.role === 'manager');
  return (
    <div className="stack">
      <Back to="/die-orders">سفارش ساخت قالب</Back>
      <div className="row between"><h1>سفارش قالب {fa(String(r.number))}</h1><Link className="btn" to={`/die-orders/${id}/edit`}>ویرایش</Link></div>
      <div className="card">
        <Details r={r} keys={['due_date', 'note', 'created_at']} />
        <dl className="kv">
          <div><dt>گام فعلی</dt><dd><span className={`badge ${step === 'registered' ? 'ok' : ''}`}>{STEP_FA[step] ?? step}</span></dd></div>
          <div><dt>مشتری</dt><dd><Ref path="/parties" id={r.customer_party_id} show={showParty} to={`/parties/${String(r.customer_party_id)}`} /></dd></div>
          <div><dt>قالب‌ساز</dt><dd><Ref path="/parties" id={r.maker_party_id} show={showParty} to={`/parties/${String(r.maker_party_id)}`} /></dd></div>
          <div><dt>قالب</dt><dd><Ref path="/dies" id={r.die_id} show={showDie} to={`/dies/${String(r.die_id)}`} /></dd></div>
          {can('finance.view') && <div><dt>هزینه قالب‌ساز</dt><dd>{r.maker_cost == null ? 'نامشخص' : money(r.maker_cost, String(r.currency))}</dd></div>}
          {can('finance.view') && r.purchase_document_id ? <div><dt>سند خرید قالب</dt><dd><Link to={`/documents/${String(r.purchase_document_id)}`}>باز کردن</Link></dd></div> : null}
        </dl>
      </div>
      <div className="card"><h2>گام‌ها</h2>
        <Table head={['گام', 'تاریخ', 'کاربر', 'یادداشت', 'فایل']} rows={DIE_STEPS.map((s) => {
          const h = steps.find((x) => x.step === s);
          return [h ? <b>{STEP_FA[s]}</b> : <span className="muted">{STEP_FA[s]}</span>, h ? jdt(h.at) : '—', h ? userName(h.by) : '—', h?.note ?? '—',
            h?.file_ids?.length ? <span className="row" style={{ gap: 4 }}>{h.file_ids.map((f, i) => <a key={f} href={`/api/v1/files/${f}/download`} target="_blank" rel="noreferrer">فایل {fa(i + 1)}</a>)}</span> : h?.production_run_id ? <Link to={`/production/${h.production_run_id}`}>نوبت تولید</Link> : '—'];
        })} />
      </div>
      {next ? (
        <div className="card"><h2>گام بعد: {STEP_FA[next]}</h2>
          <p className="muted">{STEP_HINT[next]}</p>
          <div className="row">
            {next === 'quoted' && <FileUpload kind="drawing" sensitive owner={{ entity: 'die_orders', id }} label="نقشه مشتری (محرمانه)" onDone={(f) => setFiles([...files, f.id])} />}
            <FileUpload kind="die" owner={{ entity: 'die_orders', id }} capture accept="image/*,application/pdf" label="📷 عکس / فایل" onDone={(f) => setFiles([...files, f.id])} />
            {files.length > 0 && <span className="badge ok">{fa(files.length)} فایل آماده ثبت</span>}
            {next === 'quoted' && <Link className="btn" to="/orders/new">سفارش فروش (ردیف ساخت قالب)</Link>}
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            {canAdvance ? <Action label={`ثبت گام «${STEP_FA[next]}»`} path={`/die-orders/${id}/advance`} version={Number(r.version)} body={{ file_ids: files }} fields={nextFields} onDone={done} /> : <span className="muted">ثبت رسمی فقط با مدیر است.</span>}
          </div>
        </div>
      ) : <div className="alert ok">هر شش گام ثبت شده است.</div>}
      {r.due_date && idx < DIE_STEPS.indexOf('delivered') && String(r.due_date).slice(0, 10) < new Date().toISOString().slice(0, 10) ? <div className="alert warn">موعد تحویل ({jdate(String(r.due_date))}) گذشته است.</div> : null}
    </div>
  );
}
