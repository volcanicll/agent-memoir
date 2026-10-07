/**
 * pi adapter — reads every session JSONL under ~/.pi/agent/sessions.
 *
 * Layout (measured): one directory per project slug (URL-encoded cwd), one
 * JSONL per session named `<ISO timestamp>_<uuid>.jsonl`. The first row is
 * the `session` row carrying the session id and cwd; a file without one is
 * skipped whole, like the Codex adapter's sessionless rollouts.
 *
 * read() threads session state (cwd, current model) through each file the way
 * pi applies it in stream order, and readLines() whole-file reads each JSONL.
 * Read-only; nothing is ever written back.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Adapter } from '../../core/adapter.ts';
import type { Event, EventSource } from '../../core/event.ts';
import type { RawEvent } from '../../core/privacy.ts';
import { isPlainRecord, listFilesRecursive, parseJsonSafe } from '../shared.ts';
import { PI_SOURCE, normalizePi, piParts, type PiPayload } from './normalize.ts';

export class PiAdapter implements Adapter {
  readonly id: EventSource = PI_SOURCE;

  constructor(private readonly rootDir: string = join(homedir(), '.pi', 'agent', 'sessions')) {}

  async detect(): Promise<boolean> {
    return existsSync(this.rootDir) && this.jsonlFiles().length > 0;
  }

  sourcePaths(): string[] {
    return [this.rootDir];
  }

  async *read(): AsyncIterable<RawEvent> {
    const files = this.jsonlFiles();
    for (let fileRank = 0; fileRank < files.length; fileRank++) {
      const file = files[fileRank];
      if (file === undefined) continue;
      const lines = readLines(file);
      const sessionRow = findSessionRow(lines);
      if (sessionRow === undefined) continue; // not a session file we can place
      const sessionId = sessionIdOf(sessionRow, file);
      const context: { cwd?: string; model?: string } = {};
      if (typeof sessionRow.cwd === 'string' && sessionRow.cwd.length > 0) context.cwd = sessionRow.cwd;

      for (let offset = 0; offset < lines.length; offset++) {
        const text = (lines[offset] ?? '').trim();
        if (text.length === 0) continue;
        const row = parseJsonSafe(text);
        if (!isPlainRecord(row)) continue; // unparseable line — skip, never throw
        // model_change rows carry no conversation content; they update the
        // state later records inherit (refs.model).
        if (row.type === 'model_change' && typeof row.modelId === 'string' && row.modelId.length > 0) {
          context.model = row.modelId;
          continue;
        }
        const parts = piParts(row);
        for (let partOffset = 0; partOffset < parts.length; partOffset++) {
          const part = parts[partOffset]!;
          const payload: PiPayload = { sessionId, file, line: offset + 1, fileRank, row, context: { ...context }, part, offset: partOffset };
          yield { source: PI_SOURCE, payload, originPath: file };
        }
      }
    }
  }

  normalize(raw: RawEvent): Event | null {
    return normalizePi(raw);
  }

  private jsonlFiles(): string[] {
    return listFilesRecursive(this.rootDir, (name) => name.endsWith('.jsonl'));
  }
}

/** Whole-file read; sessions are append-only. */
function readLines(file: string): string[] {
  try {
    return readFileSync(file, 'utf8').split('\n');
  } catch {
    return []; // unreadable file — no data, not an error
  }
}

/** Top-down scan for the session row every yielded record needs. */
function findSessionRow(lines: readonly string[]): Record<string, unknown> | undefined {
  for (const line of lines) {
    const row = parseJsonSafe(line.trim());
    if (isPlainRecord(row) && row.type === 'session') return row;
  }
  return undefined;
}

/** The session row id; falls back to the filename uuid for id-less rows. */
function sessionIdOf(sessionRow: Record<string, unknown>, file: string): string {
  if (typeof sessionRow.id === 'string' && sessionRow.id.length > 0) return sessionRow.id;
  const base = file.split('/').at(-1) ?? file;
  const uuid = base.split('_').at(-1)?.replace(/\.jsonl$/, '') ?? '';
  return uuid;
}
