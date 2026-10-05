import { z } from 'zod';

/** Cursor pagination, at most 100 rows per page. */
export const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(200).optional(),
});

/** `at` is the ordering value of the last row: a timestamp, or a text key such as a name or code. */
export function encodeCursor(at: Date | string, id: string): string {
  const d = at instanceof Date ? at : /^\d{4}-\d{2}-\d{2}T/.test(String(at)) ? new Date(at) : null;
  const payload = d && !Number.isNaN(d.getTime()) ? { at: d.toISOString(), id } : { at: String(at), id, str: true };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

export function decodeCursor(cursor: string | undefined): { at: string; id: string; str?: boolean } | null {
  if (!cursor) return null;
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    const parsed = z.object({ at: z.string().max(300), id: z.string().uuid(), str: z.boolean().optional() }).refine((c) => c.str || !Number.isNaN(Date.parse(c.at))).safeParse(v);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
