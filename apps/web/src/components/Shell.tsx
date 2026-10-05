import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAuth } from '../lib/auth.js';
import { fa } from './ui.js';

const Icon = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);

/** Bottom bar on phones, side bar on desktop (§13): eight destinations, each leading to its module's list. */
const NAV: Array<{ to: string; label: string; d: string; perm?: string }> = [
  { to: '/', label: 'خانه', d: 'M3 11l9-8 9 8v10H3z M9 21v-6h6v6' },
  { to: '/bundles', label: 'بندیل', d: 'M3 7l9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4M12 11v10' },
  { to: '/orders', label: 'سفارش', d: 'M9 5h6l1 2h3v14H5V7h3l1-2zM9 12h6M9 16h6' },
  { to: '/transfers', label: 'حواله', d: 'M3 7h11v10H3zM14 10h4l3 3v4h-7zM6 20a2 2 0 100-4 2 2 0 000 4zM17 20a2 2 0 100-4 2 2 0 000 4z' },
  { to: '/stock', label: 'انبار', d: 'M3 21V9l9-6 9 6v12H3zM9 21v-8h6v8' },
  { to: '/documents', label: 'مالی', d: 'M3 7h18v12H3zM3 11h18M7 15h3' },
  { to: '/notes', label: 'روزانه', d: 'M5 4h14v16H5zM9 2v4M15 2v4M8 10h8M8 14h5' },
  { to: '/reports', label: 'گزارش', d: 'M4 20h16M6 16v-5M10 16V8M14 16v-3M18 16V5' },
];

export function Shell() {
  const { me, logout } = useAuth();
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
          <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => (isActive ? 'active' : '')}>
            <Icon d={n.d} />
            <span>{n.label}</span>
          </NavLink>
        ))}
        <NavLink to="/settings" className={({ isActive }) => (isActive ? 'active' : '')}>
          <Icon d="M12 15a3 3 0 100-6 3 3 0 000 6zM19 12l2-1-1-3-2 .3a7 7 0 00-1.4-1.4L17 4l-3-1-1 2a7 7 0 00-2 0L10 3 7 4l.4 2.9A7 7 0 006 8.3L3.7 8l-1 3 2 1a7 7 0 000 2l-2 1 1 3 2.3-.3a7 7 0 001.4 1.4L7 20l3 1 1-2a7 7 0 002 0l1 2 3-1-.4-2.9a7 7 0 001.4-1.4l2.3.3 1-3-2-1a7 7 0 000-2z" />
          <span>بیشتر</span>
        </NavLink>
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
          <span className="muted" style={{ color: 'inherit', opacity: 0.85 }}>{me?.user.short_name || me?.user.name}</span>
          <button className="btn" style={{ minHeight: 36, padding: '0 0.75rem', background: 'transparent', color: 'inherit', borderColor: 'rgba(255,255,255,.4)' }} onClick={() => void logout()}>
            خروج
          </button>
        </header>
        {!online && <div className="offline">اینترنت قطع است؛ ثبت بندیل در صف ذخیره می‌شود و بعد از اتصال ارسال می‌شود</div>}
        <main className="main">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
