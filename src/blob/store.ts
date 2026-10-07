/**
 * Local blob store: full original records, addressable by sha256.
 *
 * Every Event carries rawRef = sha256(full original record JSON). The blob
 * store is where those originals live, so truncating Event.text never loses
 * data. Content-addressed → identical records dedupe to one file.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Deterministic content address for an original record. */
export function computeRawRef(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload) ?? 'null').digest('hex');
}

export class BlobStore {
  readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
    mkdirSync(rootDir, { recursive: true });
  }

  /** Store content; returns false if it was already present. */
  put(ref: string, content: string): boolean {
    const path = this.pathFor(ref);
    if (existsSync(path)) return false;
    mkdirSync(join(this.rootDir, ref.slice(0, 2)), { recursive: true });
    writeFileSync(path, content, 'utf8');
    return true;
  }

  has(ref: string): boolean {
    return existsSync(this.pathFor(ref));
  }

  pathFor(ref: string): string {
    if (!/^[0-9a-f]{64}$/.test(ref)) throw new Error(`invalid blob ref: ${ref}`);
    return join(this.rootDir, ref.slice(0, 2), ref);
  }
}
