import { Link } from 'react-router-dom';
import { useOne } from '../lib/hooks.js';
import { useAuth } from '../lib/auth.js';
import { fa, money, num } from '../components/ui.js';

const I = ({ d }: { d: string }) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>;

/** Quick-add row (spec §13 home): the five most frequent entries, each one tap away. */
const QUICK = [
  { to: '/bundles/new', l: 'بندیل جدید', d: 'M3 7l9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4M12 11v10' },
  { to: '/transfers/new', l: 'بار / حمل', d: 'M1 3h15v13H1zM16 8h4l3 3v5h-7zM5.5 19a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM18.5 19a1.5 1.5 0 100-3 1.5 1.5 0 000 3z' },
  { to: '/scale/new', l: 'قبض باسکول', d: 'M12 3v4M5 7h14l-2 12H7zM9 12h6' },
  { to: '/documents/new?kind=receipt', l: 'دریافت وجه', d: 'M3 7h18v12H3zM3 11h18M7 15h3', perm: 'finance.view' },
  { to: '/notes/new', l: 'یادداشت / ویس', d: 'M12 3a3 3 0 013 3v6a3 3 0 11-6 0V6a3 3 0 013-3zM19 11a7 7 0 01-14 0M12 18v3' },
  { to: '/orders/new', l: 'سفارش جدید', d: 'M9 5h6l1 2h3v14H5V7h3l1-2zM9 12h6M9 16h6' },
];

interface Dashboard {
  decisions: { quarantine: unknown[]; incomplete_tickets: unknown[]; free_notes: unknown[]; reported_money: unknown[]; incomplete_costs: unknown[]; correction_requests: unknown[]; due_orders: unknown[]; overdue_tasks: unknown[]; missing_documents: unknown[]; weight_differences: unknown[] };
  weight: Array<{ location_id: string; name: string; kind: string; states: Record<string, string>; total_kg: string; value: string | null }>;
  money: { receivables: Array<{ currency: string; open: string; overdue: string }>; payables: Array<{ currency: string; kind: string; open: string }> } | null;
  profit: { per_currency?: Record<string, { estimated: string; realised: string; collected: string }> } | null;
  scorecards: { factories: Array<{ id: string; name: string; runs: number; yield_percent: string | null; reject_percent: string | null; late: number }>; painters: Array<{ id: string; name: string; color_code: string | null; gain_percent: string | null }> };
  disk_warning: boolean;
}

export function HomePage() {
  const { me, can } = useAuth();
  const d = useOne<Dashboard>('/reports/dashboard', { refetchInterval: 120_000 });
  const x = d.data;
  const dec = x?.decisions;
  const n = (a: unknown[] | undefined) => (a ? a.length : undefined);
  const tiles: Array<[string, number | undefined, string, string]> = [
    ['بندیل در قرنطینه', n(dec?.quarantine), '/bundles?quarantine=true', 'warn'], ['قبض باسکول ناقص', n(dec?.incomplete_tickets), '/scale?status=needs_completion', 'warn'], ['یادداشت تازه', n(dec?.free_notes), '/notes?status=new', ''],
    ['سفارش سررسید‌شده', n(dec?.due_orders), '/orders?status=approved', ''], ['کار عقب‌افتاده', n(dec?.overdue_tasks), '/tasks?overdue=true', 'danger'], ['مدرک بار ناقص', n(dec?.missing_documents), '/transfers', 'warn'], ['اختلاف وزن تحویل', n(dec?.weight_differences), '/transfers?status=received', 'warn'],
  ];
  if (can('finance.view')) tiles.splice(3, 0, ['دریافت/پرداخت در انتظار', n(dec?.reported_money), '/documents?pending=true', 'warn'], ['سند هزینه ناقص', n(dec?.incomplete_costs), '/documents?status=needs_completion', 'danger'], ['درخواست اصلاح', n(dec?.correction_requests), '/settings/corrections', '']);
  const totalKg = x ? x.weight.reduce((a, w) => a + Number(w.total_kg), 0) : 0;
  const byState: Record<string, number> = {};
  for (const w of x?.weight ?? []) for (const [s, kg] of Object.entries(w.states)) byState[s] = (byState[s] ?? 0) + Number(kg);
  return (
    <div className="stack">
      <div className="row between"><h1>سلام {me?.user.short_name || me?.user.name}</h1><div className="row"><Link className="btn" to="/reports/daily">گزارش روزانه</Link><Link className="btn" to="/reports/inventory">گزارش‌ها</Link></div></div>
      <div className="quick">{QUICK.filter((q) => !q.perm || can(q.perm as 'finance.view')).map((q) => <Link key={q.to} to={q.to}><I d={q.d} /><span>{q.l}</span></Link>)}</div>
      <h2>نیازمند تصمیم</h2>
      <div className="tiles">{tiles.map(([l, v, to, cls]) => <Link key={l} to={to} className={`tile ${v ? cls : ''}`}><div className="v">{v === undefined ? '…' : fa(v)}</div><div className="l">{l}</div></Link>)}</div>
      {x && (
        <>
          <h2>وزن کجاست</h2>
          <div className="tiles">
            <Link to="/stock" className="tile"><div className="v">{num(totalKg.toFixed(3), 'weight')}</div><div className="l">کل موجودی (کیلو)</div></Link>
            {Object.entries(byState).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([s, kg]) => <Link key={s} to={`/stock?state=${s}`} className="tile"><div className="v">{num(kg.toFixed(3), 'weight')}</div><div className="l">{STATE_FA[s] ?? s}</div></Link>)}
          </div>
          <div className="card compact"><b>به تفکیک مکان:</b> {x.weight.sort((a, b) => Number(b.total_kg) - Number(a.total_kg)).map((w) => <Link key={w.location_id} to={`/stock?location_id=${w.location_id}`} className="badge" style={{ margin: 2 }}>{w.name}: {num(w.total_kg, 'weight')}{w.value && Number(w.value) ? ` (≈${money(w.value, 'TOMAN')})` : ''}</Link>)}</div>
          {x.money && (
            <>
              <h2>مالی</h2>
              <div className="tiles">
                {x.money.receivables.map((r) => <Link key={r.currency} to="/reports/receivables" className="tile"><div className="v">{money(r.open, r.currency)}</div><div className="l">طلب از مشتریان{Number(r.overdue) ? ` · سررسیدگذشته ${money(r.overdue, r.currency)}` : ''}</div></Link>)}
                {x.money.payables.map((p) => <Link key={p.currency + p.kind} to="/reports/payables" className="tile"><div className="v">{money(p.open, p.currency)}</div><div className="l">بدهی {({ purchase: 'خرید', toll_fee: 'اجرت', expense: 'هزینه' } as Record<string, string>)[p.kind] ?? p.kind}</div></Link>)}
                {x.profit?.per_currency && Object.entries(x.profit.per_currency).map(([c, v]) => <Link key={c} to="/reports/order-profit" className="tile"><div className="v">{money(v.realised, c)}</div><div className="l">سود محقق دوره · برآورد {money(v.estimated, c)}</div></Link>)}
              </div>
            </>
          )}
          {(x.scorecards.factories.length > 0 || x.scorecards.painters.length > 0) && <div className="card compact"><b>کارنامه کارگاه‌ها:</b> {x.scorecards.factories.map((s) => <span key={s.id} className="badge" style={{ margin: 2 }}>{s.name}: بازده {s.yield_percent ? `${num(s.yield_percent, 'percent')}٪` : '—'} · ضایعات {s.reject_percent ? `${num(s.reject_percent, 'percent')}٪` : '—'}{s.late ? ` · ${fa(s.late)} تأخیر` : ''}</span>)}{x.scorecards.painters.map((s) => <span key={s.id + (s.color_code ?? '')} className="badge" style={{ margin: 2 }}>{s.name}{s.color_code ? ` (${s.color_code})` : ''}: اضافه‌وزن {s.gain_percent ? `${num(s.gain_percent, 'percent')}٪` : '—'}</span>)}</div>}
          {x.disk_warning && <div className="alert warn">فضای دیسک بالای ۸۰٪ پر است؛ به مدیر سیستم خبر دهید.</div>}
        </>
      )}
      {d.error && <div className="alert danger">داشبورد بارگذاری نشد.</div>}
    </div>
  );
}

export const STATE_FA: Record<string, string> = { ingot: 'شمش', scrap: 'ضایعات', raw: 'خام', coated: 'رنگ‌شده', quarantine: 'قرنطینه', in_transit: 'در راه', consumed: 'مصرف‌شده', sold: 'فروخته', paint: 'پودر رنگ', tool: 'ابزار' };
