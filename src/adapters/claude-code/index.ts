/**
 * Claude Code adapter — reads every JSONL file under ~/.claude/projects.
 *
 * Layout (measured): one directory per project slug, one JSONL per session
 * (<uuid>.jsonl), plus <uuid>/subagents/agent-*.jsonl transcripts. Subagent
 * files reuse the parent session id, so a session spans several files; the
 * ordinal folds in a per-file rank and a per-line index — see ./normalize.ts
 * for the scheme and its caveats.
 *
 * read() is a streaming line reader: one RawEvent per mappable part of a row
 * (see claudeParts), tagged with the file it came from. Unparseable lines are
 * skipped, never fatal, and nothing is ever written back.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Adapter } from '../../core/adapter.ts';
import type { Event, EventSource } from '../../core/event.ts';
import type { RawEvent } from '../../core/privacy.ts';
import { isPlainRecord, listFilesRecursive, parseJsonSafe } from '../shared.ts';
import { CLAUDE_SOURCE, claudeParts, normalizeClaudeCode, type ClaudeCodePayload } from './normalize.ts';

export class ClaudeCodeAdapter implements Adapter {
  readonly id: EventSource = CLAUDE_SOURCE;

  constructor(private readonly rootDir: string = join(homedir(), '.claude', 'projects')) {}

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
      for (let offset = 0; offset < lines.length; offset++) {
        const text = (lines[offset] ?? '').trim();
        if (text.length === 0) continue;
        const row = parseJsonSafe(text);
        if (!isPlainRecord(row)) continue; // unparseable line — skip, never throw
        const sessionId = typeof row.sessionId === 'string' ? row.sessionId : '';
        const parts = claudeParts(row);
        for (const part of parts) {
          const payload: ClaudeCodePayload = { sessionId, file, line: offset + 1, fileRank, row, part };
          yield { source: CLAUDE_SOURCE, payload, originPath: file };
        }
      }
    }
  }

  normalize(raw: RawEvent): Event | null {
    return normalizeClaudeCode(raw);
  }

  private jsonlFiles(): string[] {
    return listFilesRecursive(this.rootDir, (name) => name.endsWith('.jsonl'));
  }
}

/** Whole-file read; sessions are append-only and small (measured max 1537 lines). */
function readLines(file: string): string[] {
  try {
    return readFileSync(file, 'utf8').split('\n');
  } catch {
    return []; // unreadable file — no data, not an error
  }
}
