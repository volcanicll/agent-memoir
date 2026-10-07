/**
 * Gemini CLI adapter — reads every session JSONL under ~/.gemini/tmp.
 *
 * Layout (gemini-cli chat recorder): ~/.gemini/tmp/<project-slug>/chats/
 * session-<timestamp>-<shortId>.jsonl for main sessions, plus
 * chats/<parentSessionId>/<sessionId>.jsonl for subagent transcripts. The
 * first line is the conversation metadata carrying sessionId + projectHash;
 * a file without one is skipped whole.
 *
 * Read-only; nothing is ever written back.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Adapter } from '../../core/adapter.ts';
import type { Event, EventSource } from '../../core/event.ts';
import type { RawEvent } from '../../core/privacy.ts';
import { isPlainRecord, listFilesRecursive, parseJsonSafe } from '../shared.ts';
import { GEMINI_SOURCE, geminiParts, normalizeGemini, type GeminiPayload } from './normalize.ts';

export class GeminiAdapter implements Adapter {
  readonly id: EventSource = GEMINI_SOURCE;

  constructor(private readonly rootDir: string = join(homedir(), '.gemini', 'tmp')) {}

  async detect(): Promise<boolean> {
    return existsSync(this.rootDir) && this.jsonlFiles().length > 0;
  }

  sourcePaths(): string[] {
    return [this.rootDir];
  }

  async *read(): AsyncIterable<RawEvent> {
    const files = this.jsonlFiles();
    for (const file of files) {
      const lines = readLines(file);
      const sessionId = findSessionId(lines);
      if (sessionId.length === 0) continue; // not a session file we can place
      for (let offset = 0; offset < lines.length; offset++) {
        const text = (lines[offset] ?? '').trim();
        if (text.length === 0) continue;
        const row = parseJsonSafe(text);
        if (!isPlainRecord(row)) continue; // unparseable line — skip, never throw
        for (const part of geminiParts(row)) {
          const payload: GeminiPayload = { sessionId, file, line: offset + 1, row, part };
          yield { source: GEMINI_SOURCE, payload, originPath: file };
        }
      }
    }
  }

  normalize(raw: RawEvent): Event | null {
    return normalizeGemini(raw);
  }

  private jsonlFiles(): string[] {
    return listFilesRecursive(this.rootDir, (name) => name.endsWith('.jsonl'));
  }
}

/** Whole-file read; sessions are append-only between rewrites. */
function readLines(file: string): string[] {
  try {
    return readFileSync(file, 'utf8').split('\n');
  } catch {
    return []; // unreadable file — no data, not an error
  }
}

/** Top-down scan for the metadata line every yielded record needs. */
function findSessionId(lines: readonly string[]): string {
  for (const line of lines) {
    const row = parseJsonSafe(line.trim());
    if (
      isPlainRecord(row) &&
      typeof row.sessionId === 'string' &&
      typeof row.projectHash === 'string' &&
      typeof row.startTime === 'string'
    ) {
      return row.sessionId;
    }
  }
  return '';
}
