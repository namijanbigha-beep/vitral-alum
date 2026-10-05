import { inflateRawSync } from 'node:zlib';

/** Minimal ZIP reader (stored or deflated entries) for .xlsx import — no external dependency. */
export function readZip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const data = buf.subarray(dataStart, dataStart + csize);
    out.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const unesc = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const colIndex = (ref: string): number => { let n = 0; for (const ch of ref.replace(/\d+/g, '')) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };

/** First worksheet of an .xlsx as rows of strings (shared strings, inline strings and numbers resolved). */
export function readXlsxRows(buf: Buffer): string[][] {
  const files = readZip(buf);
  const shared: string[] = [];
  const ss = files.get('xl/sharedStrings.xml')?.toString('utf8');
  if (ss) for (const m of ss.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(unesc([...m[1]!.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')));
  const sheetName = [...files.keys()].filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort()[0];
  if (!sheetName) throw new Error('no worksheet');
  const xml = files.get(sheetName)!.toString('utf8');
  const rows: string[][] = [];
  for (const r of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    for (const c of r[1]!.matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const idx = colIndex(c[1]!);
      const attrs = c[2] ?? '';
      const inner = c[3] ?? '';
      let v = '';
      const t = /t="(\w+)"/.exec(attrs)?.[1];
      if (t === 's') v = shared[Number(/<v>([^<]*)<\/v>/.exec(inner)?.[1] ?? -1)] ?? '';
      else if (t === 'inlineStr') v = unesc([...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join(''));
      else v = unesc(/<v>([^<]*)<\/v>/.exec(inner)?.[1] ?? '');
      cells[idx] = v.trim();
    }
    rows.push(Array.from(cells, (x) => x ?? ''));
  }
  return rows;
}

/** CSV (comma or semicolon, quoted fields) as rows of strings. */
export function readCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = []; let cell = ''; let q = false;
  const src = text.replace(/^﻿/, '');
  const sep = (src.split('\n')[0] ?? '').includes(';') && !(src.split('\n')[0] ?? '').includes(',') ? ';' : ',';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (q) { if (ch === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; continue; }
    if (ch === '"') q = true;
    else if (ch === sep) { row.push(cell.trim()); cell = ''; }
    else if (ch === '\n') { row.push(cell.trim()); rows.push(row); row = []; cell = ''; }
    else if (ch !== '\r') cell += ch;
  }
  if (cell.length || row.length) { row.push(cell.trim()); rows.push(row); }
  return rows.filter((r) => r.some((c) => c !== ''));
}
