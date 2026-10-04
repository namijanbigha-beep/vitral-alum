import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestApp, type TestApp, uuid } from './helpers.js';

let t: TestApp;
let manager: string;
let staff: string;
let staffId: string;

beforeAll(async () => {
  t = await setupTestApp();
  await t.createUser({ mobile: '09120000001', password: 'manager-pass-1', role: 'manager' });
  staffId = await t.createUser({ mobile: '09120000002', password: 'staff-pass-22', role: 'staff' });
  manager = await t.login('09120000001', 'manager-pass-1');
  staff = await t.login('09120000002', 'staff-pass-22');
});
afterAll(() => t.close());

async function jpegWithGps(): Promise<Buffer> {
  return sharp({ create: { width: 600, height: 400, channels: 3, background: '#4080c0' } })
    .jpeg()
    .withExif({ IFD0: { Copyright: 'x', ImageDescription: 'gps-test' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '34/1 5/1 0/1' } })
    .toBuffer();
}

function multipart(fields: Record<string, string>, file: { name: string; data: Buffer; type: string } | null) {
  const boundary = `----vt${uuid().replace(/-/g, '')}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  if (file) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`));
    parts.push(file.data, Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

async function upload(cookie: string, fields: Record<string, string>, file: { name: string; data: Buffer; type: string } | null, key = uuid()) {
  const m = multipart(fields, file);
  return t.call(cookie, { method: 'POST', url: '/api/v1/files', payload: m.payload, headers: m.headers, idempotency: key });
}

describe('private upload and download', () => {
  it('stores an image, strips EXIF/GPS, makes a thumbnail, and serves only to signed-in users', async () => {
    const res = await upload(staff, { kind: 'bundle', caption: 'برچسب' }, { name: 'IMG_0001.jpg', data: await jpegWithGps(), type: 'image/jpeg' });
    expect(res.statusCode).toBe(201);
    const f = res.json();
    expect(f.mime).toBe('image/jpeg');
    expect(f.has_thumb).toBe(true);
    expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
    const dl = await t.call(staff, { method: 'GET', url: `/api/v1/files/${f.id}/download` });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['content-type']).toBe('image/jpeg');
    const meta = await sharp(dl.rawPayload).metadata();
    expect(meta.exif).toBeUndefined();
    const th = await t.call(staff, { method: 'GET', url: `/api/v1/files/${f.id}/thumb` });
    expect(th.statusCode).toBe(200);
    expect(th.headers['content-type']).toBe('image/webp');
    const thMeta = await sharp(th.rawPayload).metadata();
    expect(thMeta.width).toBeLessThanOrEqual(320);
    expect((await t.app.inject({ method: 'GET', url: `/api/v1/files/${f.id}/download` })).statusCode).toBe(401);
  });

  it('checks the type from the content, not the extension', async () => {
    const fake = Buffer.from('#!/bin/sh\necho hi\n');
    const res = await upload(staff, { kind: 'other' }, { name: 'photo.jpg', data: fake, type: 'image/jpeg' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.fields.file).toBe('نوع فایل مجاز نیست');
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
    const ok = await upload(staff, { kind: 'drawing' }, { name: 'x.bin', data: pdf, type: 'application/octet-stream' });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().mime).toBe('application/pdf');
  });

  it('T36 (files): sensitive file → 403 for staff without finance.view, 200 for manager and the uploader', async () => {
    const res = await upload(manager, { kind: 'receipt', sensitive: 'true' }, { name: 'r.jpg', data: await jpegWithGps(), type: 'image/jpeg' });
    const id = res.json().id;
    expect((await t.call(staff, { method: 'GET', url: `/api/v1/files/${id}/download` })).statusCode).toBe(403);
    expect((await t.call(staff, { method: 'GET', url: `/api/v1/files/${id}` })).statusCode).toBe(403);
    expect((await t.call(staff, { method: 'GET', url: `/api/v1/files/${id}/thumb` })).statusCode).toBe(403);
    expect((await t.call(manager, { method: 'GET', url: `/api/v1/files/${id}/download` })).statusCode).toBe(200);
    const opened = await t.db.selectFrom('audit_log').selectAll().where('entity_id', '=', id).where('action', '=', 'open_sensitive').execute();
    expect(opened.length).toBe(1);
    const own = await upload(staff, { kind: 'receipt', sensitive: 'true' }, { name: 'mine.jpg', data: await jpegWithGps(), type: 'image/jpeg' });
    expect((await t.call(staff, { method: 'GET', url: `/api/v1/files/${own.json().id}/download` })).statusCode).toBe(200);
    expect(own.json().created_by).toBe(staffId);
  });

  it('T47: four uploads, one fails — three remain and only that one is retried', async () => {
    const good = await jpegWithGps();
    const bad = Buffer.from('not an image at all');
    const keys = [uuid(), uuid(), uuid(), uuid()];
    const results = await Promise.all([
      upload(staff, { kind: 'bundle', sort_order: '0' }, { name: '1.jpg', data: good, type: 'image/jpeg' }, keys[0]),
      upload(staff, { kind: 'bundle', sort_order: '1' }, { name: '2.jpg', data: bad, type: 'image/jpeg' }, keys[1]),
      upload(staff, { kind: 'bundle', sort_order: '2' }, { name: '3.jpg', data: good, type: 'image/jpeg' }, keys[2]),
      upload(staff, { kind: 'bundle', sort_order: '3' }, { name: '4.jpg', data: good, type: 'image/jpeg' }, keys[3]),
    ]);
    expect(results.map((r) => r.statusCode)).toEqual([201, 400, 201, 201]);
    const before = await t.db.selectFrom('files').select(t.db.fn.countAll<string>().as('n')).executeTakeFirstOrThrow();
    // Retry only the failed one with the same key and a fixed file: it is accepted; retrying a success replays.
    const retry = await upload(staff, { kind: 'bundle', sort_order: '1' }, { name: '2.jpg', data: good, type: 'image/jpeg' }, keys[1]);
    expect(retry.statusCode).toBe(201);
    const replay = await upload(staff, { kind: 'bundle', sort_order: '0' }, { name: '1.jpg', data: good, type: 'image/jpeg' }, keys[0]);
    expect(replay.json()).toEqual(results[0]?.json());
    const after = await t.db.selectFrom('files').select(t.db.fn.countAll<string>().as('n')).executeTakeFirstOrThrow();
    expect(Number(after.n) - Number(before.n)).toBe(1);
  });

  it('rejects a file over 20 MB before storing it', async () => {
    const big = Buffer.alloc(21 * 1024 * 1024, 1);
    const res = await upload(staff, { kind: 'other' }, { name: 'big.bin', data: big, type: 'application/octet-stream' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation');
  });
});
