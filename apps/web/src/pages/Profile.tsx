import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Action, EntityForm, ev, ListPage, L } from '../components/entity.js';
import { Back, Table, fa, jdt } from '../components/ui.js';
import { useAuth } from '../lib/auth.js';
import { useAct, useOne } from '../lib/hooks.js';
import { api } from '../api/client.js';

/** Telegram linking (§16): a 10-minute code the user sends to the bot as /start <code>. */
export function TelegramPage() {
  const { me, refresh } = useAuth();
  const [code, setCode] = useState<{ code: string; expires_in_seconds: number } | null>(null);
  const gen = useAct<Record<string, unknown>, { code: string; expires_in_seconds: number }>('POST', '/telegram/link-code', { onSuccess: setCode });
  const unlink = useAct<Record<string, unknown>>('POST', '/telegram/unlink', { onSuccess: () => { setCode(null); void refresh(); } });
  return <div className="stack"><Back to="/settings">تنظیمات</Back><h1>اتصال تلگرام</h1>
    <div className="card"><p>کد را بگیرید و در تلگرام به بات بفرستید: <code dir="ltr">/start ۱۲۳۴۵۶</code>. کد ۱۰ دقیقه اعتبار دارد و یک‌بار مصرف است.</p>
      <div className="row"><button className="btn primary" disabled={gen.isPending} onClick={() => gen.mutate({})}>دریافت کد</button><button className="btn danger" disabled={unlink.isPending} onClick={() => unlink.mutate({})}>قطع اتصال</button></div>
      {code && <div className="alert ok" style={{ fontSize: '1.6rem', letterSpacing: 4, textAlign: 'center' }} dir="ltr">{fa(code.code)}</div>}
      <p className="muted">کاربر: {me?.user.name}</p></div>
    <BotAdmin /></div>;
}

type BotState = { configured: boolean; webhook_url: string | null; telegram: { url?: string; pending_update_count?: number; last_error_message?: string } | null; telegram_error: string | null };

/** Managers on the PHP (shared-hosting) edition: turn the Telegram webhook on/off. Hidden where the server has no such endpoint. */
function BotAdmin() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const st = useOne<BotState>(can('settings.manage') ? '/bot/telegram' : null, { retry: false, refetchInterval: false });
  const set = useAct<Record<string, unknown>>('POST', '/bot/telegram/webhook', { onSuccess: () => void qc.invalidateQueries() });
  const del = useAct<Record<string, unknown>>('DELETE', '/bot/telegram/webhook', { onSuccess: () => void qc.invalidateQueries() });
  if (!st.data) return null;
  const d = st.data;
  const active = !!d.telegram?.url;
  return <div className="card"><h2>بات تلگرام شرکت</h2>
    {!d.configured && <p>توکن بات تنظیم نشده است. توکن را از <code dir="ltr">@BotFather</code> بگیرید و در فایل <code dir="ltr">app/config.php</code> جلوی <code dir="ltr">TELEGRAM_BOT_TOKEN</code> بگذارید.</p>}
    {d.telegram_error && <div className="alert danger">{d.telegram_error}</div>}
    {d.configured && !d.telegram_error && <p>{active ? <span className="badge ok">فعال</span> : <span className="badge">غیرفعال</span>} {d.telegram?.last_error_message && <span className="error">آخرین خطا: {d.telegram.last_error_message}</span>}</p>}
    {d.configured && <div className="row"><button className="btn primary" disabled={set.isPending} onClick={() => set.mutate({})}>{active ? 'فعال‌سازی دوباره' : 'فعال‌سازی بات'}</button>{active && <button className="btn danger" disabled={del.isPending} onClick={() => del.mutate({})}>خاموش کردن</button>}</div>}
    {(set.error?.message || del.error?.message) && <div className="error">{set.error?.message ?? del.error?.message}</div>}
  </div>;
}

/** Share links the user created (or all, for managers), with revoke. */
export function ShareLinksPage() {
  const qc = useQueryClient();
  const links = useOne<{ items: Array<Record<string, unknown>> }>('/share-links');
  return <div className="stack"><Back to="/settings">تنظیمات</Back><h1>لینک‌های مهمان</h1>
    <div className="card"><Table head={['نوع', 'مورد', 'اعتبار', 'بازدید', 'آخرین بازدید', 'وضعیت', '']} rows={(links.data?.items ?? []).map((l) => [({ daily_report: 'گزارش روزانه', document: 'سند', bundle_gallery: 'گالری بندیل' } as Record<string, string>)[String(l.scope_type)] ?? String(l.scope_type), l.scope_date ? String(l.scope_date).slice(0, 10) : String(l.scope_id ?? '').slice(0, 8), jdt(String(l.expires_at)), fa(String(l.open_count)), l.last_opened_at ? jdt(String(l.last_opened_at)) : '—', l.revoked ? <span className="badge danger">باطل</span> : new Date(String(l.expires_at)) < new Date() ? <span className="badge">منقضی</span> : <span className="badge ok">فعال</span>, !l.revoked ? <button className="btn danger" onClick={() => void api('POST', `/share-links/${l.id}/revoke`, { idempotencyKey: crypto.randomUUID() }).then(() => qc.invalidateQueries())}>ابطال</button> : ''])} /></div></div>;
}

/** Correction requests on posted documents: anyone asks, finance resolves (never a silent edit). */
export function CorrectionsPage() {
  const { can } = useAuth();
  const [sp] = useSearchParams();
  const qc = useQueryClient();
  const entity = sp.get('entity'); const eid = sp.get('id');
  const [done, setDone] = useState(false);
  return <div className="stack">
    {entity && eid && !done && <EntityForm title="درخواست اصلاح سند قطعی" path="/correction-requests" specs={[{ k: 'reason', t: 'textarea', req: true, label: 'چه چیزی باید اصلاح شود و چرا' }]} initial={{ entity, entity_id: eid }} transform={(b) => ({ ...b, entity, entity_id: eid })} onSaved={() => { setDone(true); void qc.invalidateQueries(); }} />}
    {done && <div className="alert ok">درخواست ثبت شد و به مدیران مالی اطلاع داده شد.</div>}
    <ListPage title="درخواست‌های اصلاح" path="/correction-requests" rowTo={(r) => (r.entity === 'documents' ? `/documents/${r.entity_id}` : r.entity === 'transfers' ? `/transfers/${r.entity_id}` : r.entity === 'bundles' ? `/bundles/${r.entity_id}` : `/production/${r.entity_id}`)} cols={[{ k: 'reason' }, { k: 'entity', f: (v) => ({ documents: 'سند', transfers: 'حواله', production_runs: 'نوبت تولید', bundles: 'بندیل' } as Record<string, string>)[String(v)] ?? String(v) }, { k: 'status', f: (v) => ev(v === 'open' ? 'open' : v === 'done' ? 'done' : 'rejected') }, { k: 'resolution', l: 'نتیجه' }, { k: 'created_at' }, ...(can('finance.post') ? [{ k: 'id', l: '', f: (v: unknown, r: Record<string, unknown>) => (r.status === 'open' ? <span className="row"><Action label="انجام شد" path={`/correction-requests/${v}`} version={Number(r.version)} body={{ status: 'done' }} fields={[{ k: 'resolution', t: 'text' }]} onDone={() => void qc.invalidateQueries()} /><Action label="رد" danger path={`/correction-requests/${v}`} version={Number(r.version)} body={{ status: 'rejected' }} fields={[{ k: 'resolution', t: 'text' }]} onDone={() => void qc.invalidateQueries()} /></span> : null) }] : [])]} filters={[{ k: 'status', l: 'وضعیت', t: 'select', opts: ['open', 'done', 'rejected'] }]} />
    <Link className="muted" to="/settings">بازگشت</Link>
  </div>;
}
export { L };
