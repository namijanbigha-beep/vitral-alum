import { createHash } from 'node:crypto';
import { fileTypeFromBuffer } from 'file-type';
import sharp from 'sharp';
import { ALLOWED_MIME, IMPORT_MIME } from '@vitral/shared';
import { readZip } from '../../lib/xlsx-read.js';
import type { FileRow } from '../../db/schema.js';
import type { AuthUser } from '../../lib/auth.js';
import { can } from '../../lib/auth.js';

type AllowedMime = (typeof ALLOWED_MIME)[number];
export type ImportMime = (typeof IMPORT_MIME)[number];

const ALIASES: Record<string, AllowedMime> = {
  'audio/x-m4a': 'audio/mp4',
  'audio/m4a': 'audio/mp4',
  'audio/opus': 'audio/ogg',
};

/** Detect the type from the bytes, never from the name or the client's header. */
export async function detectMime(data: Buffer): Promise<AllowedMime | null> {
  const t = await fileTypeFromBuffer(data);
  if (!t) return null;
  // file-type reports Telegram voice notes as «audio/ogg; codecs=opus»: compare the bare type.
  const bare = t.mime.split(';')[0]!.trim();
  const mime = ALIASES[bare] ?? bare;
  return (ALLOWED_MIME as readonly string[]).includes(mime) ? (mime as AllowedMime) : null;
}

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * Import files (spec §18), from the bytes as well: xlsx = a ZIP whose entries form a workbook; JSON = valid UTF-8 that parses;
 * CSV = any other valid UTF-8 text without control bytes. Everything else (including other ZIPs) is refused.
 */
export async function detectImportMime(data: Buffer): Promise<ImportMime | null> {
  if (data.length >= 4 && data.readUInt32LE(0) === 0x04034b50) {
    try {
      const entries = readZip(data);
      return entries.has('[Content_Types].xml') && entries.has('xl/workbook.xml') ? XLSX : null;
    } catch {
      return null;
    }
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    return null;
  }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) return null;
  const trimmed = text.replace(/^\uFEFF/, '').trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      JSON.parse(trimmed);
      return 'application/json';
    } catch {
      /* a CSV may start with a bracket only in theory; treat as text below */
    }
  }
  return 'text/csv';
}

export const isImage = (mime: string): boolean => mime === 'image/jpeg' || mime === 'image/png' || mime === 'image/webp';

/**
 * Images are normalised on upload: orientation applied and all metadata (EXIF, including GPS) dropped,
 * so neither the stored copy nor the thumbnail carries a location.
 */
export async function normaliseImage(data: Buffer, mime: string): Promise<Buffer> {
  const img = sharp(data, { failOn: 'error' }).rotate();
  if (mime === 'image/png') return img.png().toBuffer();
  if (mime === 'image/webp') return img.webp({ quality: 90 }).toBuffer();
  return img.jpeg({ quality: 90, mozjpeg: true }).toBuffer();
}

export async function makeThumb(data: Buffer): Promise<Buffer> {
  return sharp(data).resize({ width: 320, height: 320, fit: 'inside', withoutEnlargement: true }).webp({ quality: 70 }).toBuffer();
}

export const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

/** Principle 6 and section 6: sensitive files open only with finance.view, or for the person who uploaded them. */
export function canOpen(user: AuthUser, file: FileRow): boolean {
  if (!file.sensitive) return true;
  return can(user, 'finance.view') || file.created_by === user.id;
}

export function presentFile(f: FileRow): Record<string, unknown> {
  return {
    id: f.id,
    original_name: f.original_name,
    mime: f.mime,
    size: String(f.size),
    sha256: f.sha256,
    kind: f.kind,
    caption: f.caption,
    sensitive: f.sensitive,
    owner_entity: f.owner_entity,
    owner_id: f.owner_id,
    sort_order: f.sort_order,
    has_thumb: f.thumb_key !== null,
    created_at: f.created_at,
    created_by: f.created_by,
    version: f.version,
  };
}
