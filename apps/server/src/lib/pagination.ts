import { z } from 'zod';

/** Cursor pagination, at most 100 rows per page. */
export const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(200).optional(),
});

export function encodeCursor(at: Date, id: string): string {
  return Buffer.from(JSON.stringify({ at: new Date(at).toISOString(), id })).toString('base64url');
}

export function decodeCursor(cursor: string | undefined): { at: string; id: string } | null {
  if (!cursor) return null;
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    const parsed = z.object({ at: z.string().datetime(), id: z.string().uuid() }).safeParse(v);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
