/**
 * Offline queue for the bundle form (spec §13: bundle entries are queued in IndexedDB when offline and replayed with the
 * same Idempotency-Key, so a replay never duplicates). Each entry keeps its key, body, and photos as Blobs.
 */
import { api, newRequestId } from '../api/client.js';

export interface QueuedBundle { id: string; created_at: string; body: Record<string, unknown>; photos: Array<{ name: string; blob: Blob }>; error?: string }
const DB = 'vitral-offline';
const STORE = 'bundles';

function open(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => { r.result.createObjectStore(STORE, { keyPath: 'id' }); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((res, rej) => { const r = fn(db.transaction(STORE, mode).objectStore(STORE)); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}
export const queue = {
  async add(body: Record<string, unknown>, photos: Array<{ name: string; blob: Blob }>): Promise<QueuedBundle> {
    const e: QueuedBundle = { id: newRequestId(), created_at: new Date().toISOString(), body, photos };
    await tx('readwrite', (s) => s.put(e)); return e;
  },
  list: () => tx<QueuedBundle[]>('readonly', (s) => s.getAll()),
  remove: (id: string) => tx('readwrite', (s) => s.delete(id)),
  async update(e: QueuedBundle) { await tx('readwrite', (s) => s.put(e)); },
};

/** Replay queued bundles: POST /bundles with the queued id as Idempotency-Key, then upload photos. Stops on the first network failure. */
export async function flushQueue(onProgress?: (left: number) => void): Promise<{ sent: number; failed: number }> {
  const items = (await queue.list()).sort((a, b) => a.created_at.localeCompare(b.created_at));
  let sent = 0, failed = 0;
  for (const e of items) {
    try {
      const b = await api<{ id: string }>('POST', '/bundles', { body: e.body, idempotencyKey: e.id });
      for (const p of e.photos) {
        const fd = new FormData(); fd.set('kind', 'bundle'); fd.set('owner_entity', 'bundles'); fd.set('owner_id', b.id); fd.set('file', p.blob, p.name);
        await api('POST', '/files', { form: fd, idempotencyKey: newRequestId() });
      }
      await queue.remove(e.id); sent++;
    } catch (err) {
      const status = (err as { status?: number }).status ?? 0;
      if (status === 0) break; // still offline
      e.error = (err as Error).message; await queue.update(e); failed++; // validation error: keep for the user to fix
    }
    onProgress?.(items.length - sent - failed);
  }
  return { sent, failed };
}
