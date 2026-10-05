/**
 * Playwright end-to-end checks for the three main UI paths (spec §17/§20 phase 5):
 *   1. registering a bundle, 2. an order up to its proforma, 3. a shipment with a scale ticket.
 * Runs against a live server (E2E_URL, default http://localhost:3000) with a manager account
 * (E2E_MOBILE / E2E_PASSWORD). Seeds its own party, product and locations through the API.
 *   node apps/web/e2e/flows.mjs
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');

const URL = process.env.E2E_URL ?? 'http://localhost:3000';
const MOBILE = process.env.E2E_MOBILE ?? '09120000000';
const PASSWORD = process.env.E2E_PASSWORD ?? 'Vitral@2026';
const EXE = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const fa = (s) => String(s).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]);
const tag = Date.now().toString(36).slice(-4).toUpperCase();

process.on('uncaughtException', async (e) => { console.error(String(e).slice(0, 400)); try { console.error('PAGE:', (await page.locator('main').innerText()).slice(0, 3000)); await page.screenshot({ path: process.env.E2E_SHOT ?? '/tmp/e2e-fail.png', fullPage: true }); } catch {} process.exit(1); });
const browser = await chromium.launch({ executablePath: EXE });
const ctx = await browser.newContext({ viewport: { width: 420, height: 900 }, locale: 'fa-IR' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

// API helper on the browser's session (cookie jar shared with the page).
const api = async (method, path, body) => {
  const r = await ctx.request.fetch(`${URL}/api/v1${path}`, { method, data: body, headers: { 'x-requested-with': 'vitral', 'idempotency-key': randomUUID() } });
  const text = await r.text();
  assert.ok(r.ok(), `${method} ${path} → ${r.status()} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
};
const pick = async (labelText, query, optionText) => {
  const field = page.locator('label.field', { has: page.locator('span', { hasText: labelText }) }).first();
  const input = field.locator('input').first();
  await input.click();
  await input.fill(query);
  await field.locator('.dropdown button', { hasText: optionText }).first().click();
};
const fillNum = async (labelText, value) => {
  const field = page.locator('label.field', { has: page.locator('span', { hasText: labelText }) }).first();
  await field.locator('input').first().fill(String(value));
};
const step = (name) => console.log('•', name);

// ── login ─────────────────────────────────────────────────────────────────────
step('login');
await page.goto(`${URL}/`);
await page.fill('input[inputmode="tel"]', MOBILE);
await page.fill('input[type="password"]', PASSWORD);
await page.click('form button.btn');
await page.waitForSelector('nav');

// ── seed ──────────────────────────────────────────────────────────────────────
step('seed party, product, locations');
const party = await api('POST', '/parties', { name: `مشتری آزمون ${tag}`, city: 'تهران', roles: ['customer'], default_currency: 'TOMAN' });
const product = await api('POST', '/products', { code: `E2E${tag}`, name_fa: `مولیون آزمون ${tag}`, category: 'door_window', section_area_mm2: '293' });
const locA = await api('POST', '/locations', { name: `انبار آ ${tag}`, kind: 'own_warehouse' });
const locB = await api('POST', '/locations', { name: `انبار ب ${tag}`, kind: 'own_warehouse' });

// ── flow 1: bundle ────────────────────────────────────────────────────────────
step('flow 1: register a bundle');
await page.goto(`${URL}/bundles/new`);
await pick('مکان', tag, `انبار آ ${tag}`);
await fillNum('کد (خالی', `B${tag}`);
await fillNum('وزن (کیلو)', '394');
await fillNum('وزن بسته‌بندی', '0');
await pick('محصول', `E2E${tag}`, `E2E${tag}`);
await fillNum('طول (متر)', '6');
await fillNum('تعداد شاخه', '70');
await page.click('button[type="submit"]');
await page.waitForURL(/\/bundles\/[0-9a-f-]{36}$/);
const bundleId = page.url().split('/').pop();
const bundle = await api('GET', `/bundles/${bundleId}`);
assert.equal(bundle.code, `B${tag}`);
assert.equal(Number(bundle.weight_kg), 394);
const latin = (t) => t.replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)));
assert.ok(latin(await page.locator('h1').first().innerText()).includes(`B${tag}`), 'bundle page shows the code');
console.log('  bundle', bundle.code, bundle.weight_kg, 'kg; g/m', bundle.lines?.[0]?.actual_g_per_m ?? '(n/a)');

// ── flow 2: order → proforma ──────────────────────────────────────────────────
step('flow 2: order to proforma');
await page.goto(`${URL}/orders/new`);
await pick('مشتری', tag, `مشتری آزمون ${tag}`);
await pick('محصول', `E2E${tag}`, `E2E${tag}`);
const calc = page.locator('label.field', { has: page.locator('span', { hasText: 'روش محاسبه' }) }).locator('select');
await calc.selectOption('manual');
await fillNum('وزن هر متر', '791');
await fillNum('وزن (کیلو)', '977.795');
await fillNum('قیمت واحد', '850000');
await page.click('form button.btn.primary');
await page.waitForURL(/\/orders\/[0-9a-f-]{36}$/);
const orderId = page.url().split('/').pop();
const order = await api('GET', `/orders/${orderId}`);
assert.equal(order.lines.length, 1);
assert.equal(Number(order.lines[0].amount), 831125750, 'R10: 977.795 × 850,000');
const html = await ctx.request.get(`${URL}/api/v1/orders/${orderId}/proforma?format=html`);
assert.ok(html.ok(), 'proforma html');
const body = await html.text();
assert.ok(body.includes(`مشتری آزمون ${tag}`), 'proforma names the buyer');
assert.ok(body.includes('۸۳۱٬۱۲۵٬۷۵۰') || body.includes('831,125,750') || body.includes('۸۳۱,۱۲۵,۷۵۰'), 'proforma shows the line amount');
const pdf = await ctx.request.get(`${URL}/api/v1/orders/${orderId}/proforma?format=pdf`);
assert.ok(pdf.ok(), 'proforma pdf');
assert.equal((await pdf.body()).subarray(0, 4).toString(), '%PDF');
const after = await api('GET', `/orders/${orderId}`);
assert.equal(after.print_count, (order.print_count ?? 0) + 1, 'T48: print_count +1 per PDF print');
console.log('  order', order.number, 'amount', order.lines[0].amount);

// ── flow 3: shipment with scale ticket ───────────────────────────────────────
step('flow 3: transfer between locations with a scale ticket');
await page.goto(`${URL}/transfers/new`);
await pick('از', tag, `انبار آ ${tag}`);
await pick('به (', tag, `انبار ب ${tag}`);
await page.fill('input[placeholder="جستجوی کد بندیل"]', `B${tag}`);
await page.locator('table input[type="checkbox"]').first().click();
await page.waitForSelector('text=۱ ردیف');
await page.click('form button.btn.primary');
await page.waitForURL(/\/transfers\/[0-9a-f-]{36}$/);
const transferId = page.url().split('/').pop();
let transfer = await api('GET', `/transfers/${transferId}`);
assert.equal(transfer.lines.length, 1);
assert.equal(transfer.lines[0].bundle_id, bundleId);

await page.goto(`${URL}/scale/new?transfer_id=${transferId}`);
await fillNum('ناخالص', '15000');
await fillNum('وزن خالی', '14000');
await fillNum('وزن بسته‌بندی', '20');
await page.waitForSelector('text=خالص: ۹۸۰');
await page.click('form button.btn.primary');
await page.waitForURL(/\/scale\/[0-9a-f-]{36}$/);
const ticketId = page.url().split('/').pop();
const ticket = await api('GET', `/scale-tickets/${ticketId}`);
assert.equal(Number(ticket.net?.kg ?? ticket.net_kg), 980, 'R09: 15,000 − 14,000 − 20');
await page.click('text=تأیید قبض (R09)');
await page.locator('.modal button.badge', { hasText: 'دریافت' }).first().click();
await page.locator('.modal button.btn.primary').click();
await page.waitForSelector('text=تأیید برای');

// dispatch then receive through the UI buttons
await page.goto(`${URL}/transfers/${transferId}`);
await page.click('text=ارسال (حرکت بار)');
const modal = page.locator('.modal');
if (await modal.count()) await modal.locator('button.btn.primary').click();
await page.waitForSelector('text=در راه');
transfer = await api('GET', `/transfers/${transferId}`);
assert.equal(transfer.status, 'in_transit');
const moves = await api('GET', `/stock/moves?item_type=bundle&item_id=${bundleId}&limit=20`);
const out = moves.items.filter((m) => m.ref_type === 'transfer_dispatch');
assert.equal(out.length, 1, 'origin leaves once');
assert.equal(out[0].from_location_id, locA.id);
assert.equal(Number(out[0].kg), 394);
console.log('  transfer', transfer.number, transfer.status, 'ticket net', ticket.net_kg);

assert.deepEqual(errors, [], 'no page errors');
await browser.close();
console.log('E2E OK');
