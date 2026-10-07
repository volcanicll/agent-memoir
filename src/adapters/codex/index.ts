/**
 * Codex adapter — reads every rollout JSONL file under ~/.codex/sessions.
 *
 * Layout (measured): ~/.codex/sessions/YYYY/MM/DD/rollout-<ISO>-<uuid>.jsonl,
 * 312 files on this machine. Each line is a self-describing envelope
 * {timestamp, ordinal, type, payload}; one line yields at most one RawEvent
 * (the line already carries a monotonic ordinal — no fan-out, see
 * ./normalize.ts).
 *
 * read() pre-scans each file for its session_meta line (always the first line
 * in practice, but the scan is top-down so nothing depends on that) because
 * every record must carry the session id; a file without session_meta is
 * skipped whole. turn_context lines update a per-file context (cwd, model,
 * approval/sandbox policy) that later records inherit for refs/meta the same
 * way Codex applies them in stream order, and a compacted line marks the
 * remainder of the file.
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
import { CODEX_SOURCE, codexPartKind, normalizeCodex, type CodexContext, type CodexPayload } from './normalize.ts';

export class CodexAdapter implements Adapter {
  readonly id: EventSource = CODEX_SOURCE;

  constructor(private readonly rootDir: string = join(homedir(), '.codex', 'sessions')) {}

  async detect(): Promise<boolean> {
    return existsSync(this.rootDir) && this.rolloutFiles().length > 0;
  }

  sourcePaths(): string[] {
    return [this.rootDir];
  }

  async *read(): AsyncIterable<RawEvent> {
    const files = this.rolloutFiles();
    for (let fileRank = 0; fileRank < files.length; fileRank++) {
      const file = files[fileRank];
      if (file === undefined) continue;
      const lines = readLines(file);
      const sessionMeta = findSessionMeta(lines);
      if (sessionMeta === undefined) continue; // not a rollout we can place
      const sessionId =
        typeof sessionMeta.session_id === 'string'
          ? sessionMeta.session_id
          : typeof sessionMeta.id === 'string'
            ? sessionMeta.id
            : '';
      if (sessionId.length === 0) continue;

      const context: CodexContext = { compacted: false };
      if (typeof sessionMeta.cwd === 'string') context.cwd = sessionMeta.cwd;

      for (const line of lines) {
        const text = line.trim();
        if (text.length === 0) continue;
        const row = parseJsonSafe(text);
        if (!isPlainRecord(row)) continue; // unparseable line — skip, never throw
        const payload = isPlainRecord(row.payload) ? row.payload : undefined;

        // turn_context carries no conversation content; it updates the state
        // later records inherit (refs.cwd/model, meta policies).
        if (row.type === 'turn_context' && payload !== undefined) {
          if (typeof payload.cwd === 'string') context.cwd = payload.cwd;
          if (typeof payload.model === 'string') context.model = payload.model;
          if (payload.approval_policy !== undefined) context.approvalPolicy = payload.approval_policy;
          if (payload.sandbox_policy !== undefined) context.sandboxPolicy = payload.sandbox_policy;
        } else if (row.type === 'compacted') {
          context.compacted = true;
        }

        const envelope: CodexPayload = {
          sessionId,
          file,
          fileRank,
          row,
          part: { kind: codexPartKind(row), index: 0 },
          context: { ...context },
        };
        yield { source: CODEX_SOURCE, payload: envelope, originPath: file };
      }
    }
  }

  normalize(raw: RawEvent): Event | null {
    return normalizeCodex(raw);
  }

  private rolloutFiles(): string[] {
    return listFilesRecursive(this.rootDir, (name) => name.endsWith('.jsonl'));
  }
}

/** Whole-file read per rollout; files are small (measured max ~4.6 MB). */
function readLines(file: string): string[] {
  try {
    return readFileSync(file, 'utf8').split('\n');
  } catch {
    return []; // unreadable file — no data, not an error
  }
}

/** Top-down scan for the session_meta payload every yielded record needs. */
function findSessionMeta(lines: readonly string[]): Record<string, unknown> | undefined {
  for (const line of lines) {
    const row = parseJsonSafe(line.trim());
    if (isPlainRecord(row) && row.type === 'session_meta' && isPlainRecord(row.payload)) return row.payload;
  }
  return undefined;
}
