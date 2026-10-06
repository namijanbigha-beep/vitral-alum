/**
 * Records every API read the web app makes while a browser walks all screens of a running server with sample data.
 * Output: JSON {key: {s,t,b}} for the single-file demo (key = path after /api/v1 + sorted query, see src/demo.ts).
 * Usage: DEMO_URL=http://localhost:3100 DEMO_MOBILE=… DEMO_PASSWORD=… node apps/web/demo/record.mjs out.json
 */
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const { chromium } = createRequire(new URL('../e2e/x.js', import.meta.url).pathname)('playwright');

const URL0 = process.env.DEMO_URL ?? 'http://localhost:3100';
const OUT = process.argv[2] ?? 'demo-data.json';
const START = ['/', '/products', '/dies', '/die-orders', '/parties', '/contracts', '/locations', '/bundles', '/production', '/coating', '/orders', '/transfers', '/scale',
  '/stock', '/stock/opening', '/stock/adjust', '/materials', '/materials/scrap-sale', '/materials/smelting', '/documents', '/accounts', '/fx-rates', '/notes', '/tasks', '/notifications',
  '/gallery', '/search', '/reports', '/reports/daily', '/import', '/settings', '/help', '/settings/users', '/settings/backup', '/settings/password', '/settings/telegram',
  '/settings/share-links', '/settings/corrections', '/bundles/new', '/orders/new', '/transfers/new', '/documents/new', '/notes/new', '/tasks/new', '/production/new', '/coating/new',
  '/scale/new', '/products/new', '/parties/new', '/materials/lots/new', '/materials/purchases/new'];

function key(rel) {
  const [path = '', query = ''] = rel.split('?');
  const pairs = [...new URLSearchParams(query).entries()].filter(([, v]) => v !== '').sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return pairs.length ? `${path}?${new URLSearchParams(pairs).toString()}` : path;
}

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await b.newContext({ viewport: { width: 420, height: 900 } });
const rec = {};
ctx.on('response', async (r) => {
  const u = r.url(); const i = u.indexOf('/api/v1');
  if (i < 0 || r.request().method() !== 'GET') return;
  const t = r.headers()['content-type'] ?? '';
  if (!t.startsWith('application/json') && !t.startsWith('text/html')) return;
  try { const k = key(u.slice(i + 7)); if (!rec[k] || r.status() === 200) rec[k] = { s: r.status(), t, b: await r.text() }; } catch { /* body gone */ }
});
const page = await ctx.newPage();
await page.goto(URL0 + '/');
await page.fill('input[inputmode="tel"]', process.env.DEMO_MOBILE); await page.fill('input[type="password"]', process.env.DEMO_PASSWORD);
await page.click('form button.btn'); await page.waitForSelector('nav');

const seen = new Set(); const queue = [...START];
const skip = (h) => !h.startsWith('/') || h.startsWith('/api/') || h.startsWith('/s/') || /\/edit$/.test(h) && seen.size > 300;
while (queue.length && seen.size < 450) {
  const h = queue.shift(); if (seen.has(h)) continue; seen.add(h);
  try {
    await page.goto(URL0 + h, { waitUntil: 'networkidle', timeout: 20000 });
    await page.waitForTimeout(250);
    // open every tab so its data is recorded
    const tabs = await page.locator('.tabs button').all();
    for (const tb of tabs) { await tb.click().catch(() => {}); await page.waitForLoadState('networkidle').catch(() => {}); }
    // document previews (each «پیش‌نمایش» opens the printable HTML in a popup)
    const prev = await page.getByRole('button', { name: 'پیش‌نمایش' }).all();
    for (const p of prev) {
      const pop = ctx.waitForEvent('page', { timeout: 8000 }).catch(() => null);
      await p.click().catch(() => {});
      const pg = await pop; if (pg) { await pg.waitForLoadState('load').catch(() => {}); await pg.close(); }
    }
    const hrefs = await page.$$eval('a[href]', (as) => as.map((a) => a.getAttribute('href')));
    for (const x of hrefs) if (x && !skip(x) && !seen.has(x)) queue.push(x.split('#')[0]);
  } catch (e) { console.error('skip', h, String(e).slice(0, 120)); }
}
await b.close();
writeFileSync(OUT, JSON.stringify(rec));
console.log(`pages ${seen.size}, responses ${Object.keys(rec).length}, ${(JSON.stringify(rec).length / 1e6).toFixed(2)} MB`);
