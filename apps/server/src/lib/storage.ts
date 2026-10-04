import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createReadStream, type ReadStream } from 'node:fs';
import path from 'node:path';

/** Private file storage outside the web root, random names. Swappable for S3-compatible storage later. */
export interface Storage {
  put(data: Buffer): Promise<string>;
  read(key: string): Promise<Buffer>;
  stream(key: string): ReadStream;
  remove(key: string): Promise<void>;
}

export class DiskStorage implements Storage {
  constructor(private readonly root: string) {}

  private pathFor(key: string): string {
    if (!/^[0-9a-f]{2}\/[0-9a-f-]{36}$/.test(key)) throw new Error('invalid storage key');
    return path.join(this.root, key);
  }

  async put(data: Buffer): Promise<string> {
    const id = randomUUID();
    const key = `${id.slice(0, 2)}/${id}`;
    const p = this.pathFor(key);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, data, { flag: 'wx', mode: 0o600 });
    return key;
  }

  read(key: string): Promise<Buffer> {
    return readFile(this.pathFor(key));
  }

  stream(key: string): ReadStream {
    return createReadStream(this.pathFor(key));
  }

  async remove(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }
}
