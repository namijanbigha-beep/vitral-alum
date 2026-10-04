import { useEffect, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../lib/auth.js';

const Icon = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);

const NAV = [
  { to: '/products', label: 'محصولات', d: 'M3 7h18M3 12h18M3 17h12' },
  { to: '/orders', label: 'سفارش‌ها', d: 'M9 5h6l1 2h3v14H5V7h3l1-2zM9 12h6M9 16h6' },
  { to: '/accounts', label: 'حساب‌ها', d: 'M3 7h18v12H3zM3 11h18M7 15h3' },
  { to: '/', label: 'خلاصه', d: 'M4 20h16M6 16v-5M10 16V8M14 16v-3M18 16V5' },
];

export function Shell() {
  const { me, can, logout } = useAuth();
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
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
        {can('settings.manage') && (
          <NavLink to="/settings" className={({ isActive }) => (isActive ? 'active' : '')}>
            <Icon d="M12 15a3 3 0 100-6 3 3 0 000 6zM19 12l2-1-1-3-2 .3a7 7 0 00-1.4-1.4L17 4l-3-1-1 2a7 7 0 00-2 0L10 3 7 4l.4 2.9A7 7 0 006 8.3L3.7 8l-1 3 2 1a7 7 0 000 2l-2 1 1 3 2.3-.3a7 7 0 001.4 1.4L7 20l3 1 1-2a7 7 0 002 0l1 2 3-1-.4-2.9a7 7 0 001.4-1.4l2.3.3 1-3-2-1a7 7 0 000-2z" />
            <span>تنظیمات</span>
          </NavLink>
        )}
      </nav>
      <div className="shell-body">
        <header className="topbar">
          <span className="brand">ویترال</span>
          {me?.app_env && me.app_env !== 'production' && <span className="env">محیط {me.app_env === 'staging' ? 'آزمایشی' : me.app_env}</span>}
          <span className="muted" style={{ color: 'inherit', opacity: 0.85 }}>{me?.user.short_name || me?.user.name}</span>
          <button className="btn" style={{ minHeight: 36, padding: '0 0.75rem', background: 'transparent', color: 'inherit', borderColor: 'rgba(255,255,255,.4)' }} onClick={() => void logout()}>
            خروج
          </button>
        </header>
        {!online && <div className="offline">اینترنت قطع است؛ فقط صفحه‌های بازشده در دسترس‌اند</div>}
        <main className="main">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
