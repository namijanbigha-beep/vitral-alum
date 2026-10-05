import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Config } from '../../config.js';

const run = promisify(execFile);

let fontCss: string | null = null;
/** Vazirmatn embedded as a data URI so the PDF carries the font (spec §14). */
export async function loadFontCss(config: Config): Promise<string> {
  if (fontCss) return fontCss;
  const candidates = [config.VAZIRMATN_PATH, path.resolve(process.cwd(), '../web/public/fonts/Vazirmatn-Variable.woff2'), path.resolve(process.cwd(), 'apps/web/public/fonts/Vazirmatn-Variable.woff2'), new URL('../../../../web/public/fonts/Vazirmatn-Variable.woff2', import.meta.url).pathname].filter((x): x is string => !!x);
  for (const c of candidates) {
    try {
      const buf = await readFile(c);
      fontCss = `@font-face{font-family:'Vazirmatn';src:url(data:font/woff2;base64,${buf.toString('base64')}) format('woff2');font-weight:100 900;font-display:block;}`;
      return fontCss;
    } catch { /* next */ }
  }
  fontCss = '';
  return fontCss;
}

export const esc = (s: unknown): string => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function baseCss(dir: 'rtl' | 'ltr', fontCss: string, opts: { watermark?: string | null; footer?: string; pageSize?: string } = {}): string {
  return `${fontCss}
  @page { size: ${opts.pageSize ?? 'A4'}; margin: 14mm 12mm 18mm 12mm; @bottom-center { content: "${esc(opts.footer ?? '')} — ${dir === 'rtl' ? 'صفحه' : 'Page'} " counter(page) " / " counter(pages); font-family: 'Vazirmatn', sans-serif; font-size: 9px; color: #555; } }
  * { box-sizing: border-box; }
  html { direction: ${dir}; }
  body { font-family: 'Vazirmatn', 'Noto Sans Arabic', sans-serif; font-size: 11px; color: #111; margin: 0; line-height: 1.6; }
  h1 { font-size: 18px; margin: 0; } h2 { font-size: 13px; margin: 12px 0 4px; }
  table { width: 100%; border-collapse: collapse; } thead { display: table-header-group; } tfoot { display: table-footer-group; } tr { page-break-inside: avoid; }
  th, td { border: 1px solid #999; padding: 4px 6px; vertical-align: top; } th { background: #eee; font-weight: 600; }
  .num { font-variant-numeric: tabular-nums; white-space: nowrap; text-align: ${dir === 'rtl' ? 'left' : 'right'}; }
  .head { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #333; padding-bottom: 6px; margin-bottom: 8px; }
  .box { border: 1px solid #999; padding: 6px 8px; margin: 4px 0; } .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .muted { color: #666; font-size: 10px; } .img { width: 42px; height: 42px; object-fit: contain; }
  .sig { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-top: 28px; } .sig div { border-top: 1px dashed #999; padding-top: 4px; text-align: center; height: 50px; }
  .cont { display: none; } .words { word-break: break-word; white-space: normal; }
  .wm { position: fixed; top: 40%; left: 10%; right: 10%; text-align: center; font-size: 48px; color: rgba(200,0,0,0.12); transform: rotate(-20deg); pointer-events: none; z-index: 0; }
  ${opts.watermark ? '' : '.wm{display:none}'}`;
}

export interface Rendered { pdf: Buffer; png?: Buffer }

/** Chromium headless → vector PDF (selectable text, embedded font). PNG at print quality from the same HTML when asked. */
export async function renderPdf(config: Config, html: string, png = false): Promise<Rendered> {
  const dir = await mkdtemp(path.join(tmpdir(), 'vitral-pdf-'));
  try {
    const htmlPath = path.join(dir, `${randomUUID()}.html`);
    const pdfPath = path.join(dir, 'out.pdf');
    await writeFile(htmlPath, html, 'utf8');
    const common = ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--hide-scrollbars', '--run-all-compositor-stages-before-draw', '--virtual-time-budget=3000', '--no-pdf-header-footer'];
    await run(config.CHROMIUM_PATH, [...common, `--print-to-pdf=${pdfPath}`, `file://${htmlPath}`], { timeout: 60_000 });
    const pdf = await readFile(pdfPath);
    let pngBuf: Buffer | undefined;
    if (png) {
      const pngPath = path.join(dir, 'out.png');
      await run(config.CHROMIUM_PATH, [...common, '--window-size=1240,1754', '--force-device-scale-factor=2', `--screenshot=${pngPath}`, `file://${htmlPath}`], { timeout: 60_000 });
      pngBuf = await readFile(pngPath);
    }
    return { pdf, png: pngBuf };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
