import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAuth } from '../lib/auth.js';
import { fa } from './ui.js';

const Icon = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);

/**
 * Spec §13: exactly four main sections in the bottom bar (phone) / side bar (desktop): products, orders, accounts, summary.
 * Everything else lives in the «بیشتر» hub (/settings), reached from the top bar next to search, notifications and help.
 * `match` lists the sibling routes that keep a section highlighted.
 */
const NAV: Array<{ to: string; label: string; d: string; match: string[] }> = [
  { to: '/', label: 'خلاصه', d: 'M4 20h16M6 16v-5M10 16V8M14 16v-3M18 16V5', match: ['/reports'] },
  { to: '/products', label: 'محصولات', d: 'M3 7l9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4M12 11v10', match: ['/products', '/dies', '/die-orders'] },
  { to: '/orders', label: 'سفارش‌ها', d: 'M9 5h6l1 2h3v14H5V7h3l1-2zM9 12h6M9 16h6', match: ['/orders'] },
  { to: '/parties', label: 'حساب‌ها', d: 'M3 7h18v12H3zM3 11h18M7 15h3', match: ['/parties', '/documents', '/accounts', '/fx-rates', '/contracts'] },
];

/** «ثبت سریع» options (§13), in the spec's order. `ctx` turns the current order / production run into a preselection. */
type Ctx = { orderId?: string; runId?: string };
const QUICK: Array<{ label: string; to: (c: Ctx) => string; perm?: 'settings.manage' }> = [
  { label: 'بندیل', to: (c) => `/bundles/new${c.runId ? `?run=${c.runId}` : ''}` },
  { label: 'ورود یا خروج بار', to: (c) => `/transfers/new${c.orderId ? `?order_id=${c.orderId}` : ''}` },
  { label: 'قبض باسکول', to: () => '/scale/new' },
  { label: 'سفارش جدید', to: () => '/orders/new' },
  { label: 'دریافت یا پرداخت', to: (c) => `/documents/new?kind=receipt${c.orderId ? `&order_id=${c.orderId}` : ''}` },
  { label: 'افزودن محصول', to: () => '/products/new' },
  { label: 'کار جدید', to: () => '/tasks/new', perm: 'settings.manage' },
  { label: 'ثبت مورد دیگر', to: () => '/notes/new' },
];
const UUID = '[0-9a-f-]{36}';

function QuickAdd() {
  const { can } = useAuth();
  const loc = useLocation();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [loc.pathname]);
  const ctx: Ctx = { orderId: loc.pathname.match(new RegExp(`^/orders/(${UUID})`))?.[1], runId: loc.pathname.match(new RegExp(`^/production/(${UUID})`))?.[1] };
  return (
    <>
      <button type="button" className="fab" aria-label="ثبت سریع" aria-expanded={open} onClick={() => setOpen(!open)}><span aria-hidden="true">+</span> ثبت سریع</button>
      {open && (
        <div className="modal-bg" onClick={() => setOpen(false)}>
          <div className="modal card" role="dialog" aria-label="ثبت سریع" onClick={(e) => e.stopPropagation()}>
            <h2>ثبت سریع{ctx.orderId ? ' (برای همین سفارش)' : ctx.runId ? ' (برای همین نوبت)' : ''}</h2>
            <div className="list">{QUICK.filter((q) => !q.perm || can(q.perm)).map((q) => <Link key={q.label} className="item" to={q.to(ctx)}><div className="grow title">{q.label}</div><span>‹</span></Link>)}</div>
          </div>
        </div>
      )}
    </>
  );
}

export function Shell() {
  const { me, logout } = useAuth();
  const loc = useLocation();
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  const unread = useQuery({ queryKey: ['notifications-unread'], queryFn: () => api<{ unread: number }>('GET', '/notifications?unread=1&limit=1'), refetchInterval: 60_000 });
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  return (
    <div className="app">
      <nav className="nav" aria-label="ناوبری اصلی">
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => (isActive || n.match.some((m) => loc.pathname.startsWith(m)) ? 'active' : '')}>
            <Icon d={n.d} />
            <span>{n.label}</span>
          </NavLink>
        ))}
      </nav>
      <div className="shell-body">
        <header className="topbar">
          <Link to="/" className="brand" style={{ color: 'inherit', textDecoration: 'none' }}>ویترال</Link>
          {me?.app_env && me.app_env !== 'production' && <span className="env">محیط {me.app_env === 'staging' ? 'آزمایشی' : me.app_env}</span>}
          <Link to="/search" aria-label="جستجو" style={{ color: 'inherit', display: 'flex' }}><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg></Link>
          <Link to="/notifications" aria-label="اعلان‌ها" style={{ color: 'inherit', display: 'flex', position: 'relative' }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 16V11a6 6 0 0112 0v5l2 2H4zM10 21h4" /></svg>
            {!!unread.data?.unread && <span className="badge danger" style={{ position: 'absolute', top: -8, right: -10, fontSize: '0.7rem', padding: '0 5px' }}>{fa(unread.data.unread)}</span>}
          </Link>
          <Link to="/help" aria-label="راهنمای کار" title="راهنمای کار" style={{ color: 'inherit', display: 'flex' }}><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /><path d="M9.5 9a2.5 2.5 0 015 0c0 2-2.5 2-2.5 4M12 17h.01" /></svg></Link>
          <NavLink to="/settings" className="more-link" aria-label="بیشتر" title="بیشتر"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 6h16M4 12h16M4 18h16" /></svg><span>بیشتر</span></NavLink>
          <span className="muted user-name" style={{ color: 'inherit', opacity: 0.85 }}>{me?.user.short_name || me?.user.name}</span>
          <button className="btn" style={{ minHeight: 36, padding: '0 0.75rem', background: 'transparent', color: 'inherit', borderColor: 'rgba(255,255,255,.4)' }} onClick={() => void logout()}>
            خروج
          </button>
        </header>
        {!online && <div className="offline">اینترنت قطع است؛ ثبت بندیل در صف ذخیره می‌شود و بعد از اتصال ارسال می‌شود</div>}
        <main className="main">
          <Outlet />
        </main>
        <QuickAdd />
      </div>
    </div>
  );
}
