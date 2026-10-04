import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client.js';
import type { Health } from '../api/types.js';
import { useAuth } from '../lib/auth.js';
import { fa } from '../lib/format.js';

export function HomePage() {
  const { me, can } = useAuth();
  const health = useQuery({ queryKey: ['health'], queryFn: () => api<Health>('GET', '/health'), enabled: can('settings.manage'), refetchInterval: 60_000 });
  return (
    <div className="stack">
      <h1>سلام {me?.user.short_name || me?.user.name}</h1>
      <div className="card">
        <h2>خلاصه</h2>
        <p className="muted">در فاز ۰ فقط زیرساخت ساخته شده است: ورود، کاربران، تنظیمات، فایل خصوصی، شماره‌گذاری سند و پشتیبان. گزارش‌ها و داشبورد در فازهای بعدی می‌آیند.</p>
      </div>
      {can('settings.manage') && health.data && (
        <div className="card">
          <h2>وضعیت سرور</h2>
          <div className="row">
            <span className={`badge ${health.data.db === 'ok' ? 'ok' : 'danger'}`}>دیتابیس: {health.data.db === 'ok' ? 'متصل' : 'قطع'}</span>
            <span className={`badge ${health.data.disk_warning ? 'warn' : 'ok'}`}>
              دیسک: {health.data.disk_used_percent === null ? 'نامشخص' : `${fa(health.data.disk_used_percent)}٪ پر`}
            </span>
          </div>
          {health.data.disk_warning && <div className="alert warn" style={{ marginTop: '0.75rem' }}>فضای دیسک بالای ۸۰٪ پر شده است؛ پشتیبان بگیرید و فضا آزاد کنید.</div>}
        </div>
      )}
    </div>
  );
}
