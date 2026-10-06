/**
 * Builds the single-file demo: the web app (VITE_DEMO=1) with its JS, CSS, font, icon and the recorded API responses
 * all inlined into one HTML file that opens from disk with a double-click.
 * Usage: node apps/web/demo/build.mjs <recorded.json> <out.html>
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const [recPath, outPath] = process.argv.slice(2);
const web = path.resolve(new URL('..', import.meta.url).pathname);
const dist = mkdtempSync(path.join(tmpdir(), 'vitral-demo-'));
execFileSync('npx', ['vite', 'build', '--outDir', dist, '--emptyOutDir'], { cwd: web, stdio: 'inherit', env: { ...process.env, VITE_DEMO: '1', VITE_BASE: './' } });

let html = readFileSync(path.join(dist, 'index.html'), 'utf8');
const asset = (rel) => readFileSync(path.join(dist, rel.replace(/^\.\//, '')));
const fontUri = `data:font/woff2;base64,${asset('fonts/Vazirmatn-Variable.woff2').toString('base64')}`;
const safe = (s) => s.replace(/<\/(script)/gi, '<\\/$1');

html = html.replace(/\s*<link rel="manifest"[^>]*>/, '').replace(/\s*<link rel="apple-touch-icon"[^>]*>/, '');
html = html.replace(/<link rel="icon" href="([^"]+)"[^>]*>/, (_, h) => `<link rel="icon" href="data:image/svg+xml;base64,${asset(h).toString('base64')}" type="image/svg+xml" />`);
html = html.replace(/<link rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/, (_, h) => `<style>${asset(h).toString('utf8').replace(/url\(\.\.\/fonts\/Vazirmatn-Variable\.woff2\)/g, `url(${fontUri})`)}</style>`);
html = html.replace(/<script type="module"[^>]*src="([^"]+)"><\/script>/, (_, h) => `<script type="module">${safe(asset(h).toString('utf8'))}</script>`);

// Recorded responses; the printable documents all embed the same font, so it is stored once and put back at runtime.
const rec = JSON.parse(readFileSync(recPath, 'utf8'));
let docFont = null;
for (const r of Object.values(rec)) {
  if (!r.t.startsWith('text/html')) continue;
  r.b = r.b.replace(/data:font\/[a-z0-9+.-]+;base64,[A-Za-z0-9+/=]+/g, (m) => { docFont ??= m; return m === docFont ? '__VITRAL_FONT__' : m; });
}
const data = `<script id="vitral-demo-data" type="application/json">${safe(JSON.stringify(rec))}</script>\n<script id="vitral-demo-font" type="text/plain">${docFont ?? ''}</script>`;
html = html.replace('</body>', `${data}\n</body>`);
writeFileSync(outPath, html);
console.log(`wrote ${outPath} (${(html.length / 1e6).toFixed(2)} MB)`);
