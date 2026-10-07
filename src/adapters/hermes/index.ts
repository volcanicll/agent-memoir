/**
 * Hermes adapter — reads ~/.hermes/state.db (SQLite).
 *
 * Zero-write guarantee: the db runs in WAL mode, and even a plain
 * `readonly` open touches the -shm file's mtime. We therefore open with a
 * `?immutable=1` URI, which tells SQLite the file will never change and
 * makes it skip shm/wal entirely. The cost: WAL content that has not been
 * checkpointed into the main db is invisible to us — the newest moments of
 * a live session may be missing until Hermes checkpoints.
 *
 * This adapter fans message rows out into one RawEvent per mappable part;
 * see ./normalize.ts for the payload shape and ordinal scheme.
 */

import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Adapter } from '../../core/adapter.ts';
import type { EventSource } from '../../core/event.ts';
import type { Event } from '../../core/event.ts';
import type { RawEvent } from '../../core/privacy.ts';
import {
  HERMES_SUB_SPACE,
  HERMES_SOURCE,
  normalizeHermes,
  parseToolCalls,
  type HermesMessageRow,
  type HermesSessionRow,
} from './normalize.ts';

export class HermesAdapter implements Adapter {  readonly id: EventSource = HERMES_SOURCE;

  constructor(private readonly dbPath: string = join(homedir(), '.hermes', 'state.db')) {}

  async detect(): Promise<boolean> {
    return existsSync(this.dbPath);
  }

  sourcePaths(): string[] {
    return [this.dbPath];
  }

  async *read(): AsyncIterable<RawEvent> {
    if (!existsSync(this.dbPath)) return;
    // immutable=1 is mandatory here — see the module docblock.
    const db = new Database(`file:${encodeURI(this.dbPath)}?immutable=1`, { readonly: true });
    try {
      const stmt = db.query(`
        SELECT m.id, m.session_id, m.role, m.content, m.tool_call_id, m.tool_calls,
               m.tool_name, m.timestamp, m.token_count, m.finish_reason, m.reasoning,
               s.id AS s_id, s.source AS s_source, s.model AS s_model,
               s.started_at AS s_started_at, s.ended_at AS s_ended_at,
               s.title AS s_title, s.cwd AS s_cwd, s.profile_name AS s_profile_name
        FROM messages m LEFT JOIN sessions s ON s.id = m.session_id
        ORDER BY m.session_id, m.id
      `);
      for (const row of stmt.iterate()) {
        const r = row as Record<string, unknown>;
        const message: HermesMessageRow = {
          id: (r.id as number) ?? null,
          session_id: (r.session_id as string) ?? null,
          role: (r.role as string) ?? null,
          content: (r.content as string) ?? null,
          tool_call_id: (r.tool_call_id as string) ?? null,
          tool_calls: (r.tool_calls as string) ?? null,
          tool_name: (r.tool_name as string) ?? null,
          timestamp: (r.timestamp as number) ?? null,
          token_count: (r.token_count as number) ?? null,
          finish_reason: (r.finish_reason as string) ?? null,
          reasoning: (r.reasoning as string) ?? null,
        };
        const session: HermesSessionRow = {
          id: (r.s_id as string) ?? null,
          source: (r.s_source as string) ?? null,
          model: (r.s_model as string) ?? null,
          started_at: (r.s_started_at as number) ?? null,
          ended_at: (r.s_ended_at as number) ?? null,
          title: (r.s_title as string) ?? null,
          cwd: (r.s_cwd as string) ?? null,
          profile_name: (r.s_profile_name as string) ?? null,
        };

        // Fan-out: one part per mappable unit of this row (Adapter.normalize
        // is 1 raw → 1 event). Every row yields at least its 'message' part;
        // assistant rows additionally yield one part per parsed tool call.
        const parts: HermesPayloadParts[] = [{ kind: 'message', index: 0 }];
        if (message.role === 'assistant') {
          for (let i = 0; i < parseToolCalls(message.tool_calls).length && i < HERMES_SUB_SPACE - 1; i++) {
            parts.push({ kind: 'tool_call', index: i });
          }
        }
        for (const part of parts) {
          yield { source: HERMES_SOURCE, payload: { session, message, part }, originPath: this.dbPath };
        }
      }
    } finally {
      db.close();
    }
  }

  normalize(raw: RawEvent): Event | null {
    return normalizeHermes(raw);
  }
}

type HermesPayloadParts = { kind: 'message' | 'tool_call'; index: number };
