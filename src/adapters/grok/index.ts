/**
 * Grok CLI adapter — reads the local SQLite store ~/.grok/grok.db.
 *
 * Zero-write guarantee, identical to the Hermes adapter: the db runs in WAL
 * mode, so we open with `?immutable=1` and accept that WAL content not yet
 * checkpointed is invisible until grok checkpoints.
 *
 * read() joins session → message in stream order and parses each message's
 * ModelMessage JSON once (see ./normalize.ts for the ordinal scheme).
 * Read-only; nothing is ever written back.
 */

import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Adapter } from '../../core/adapter.ts';
import type { Event, EventSource } from '../../core/event.ts';
import type { RawEvent } from '../../core/privacy.ts';
import { isPlainRecord, parseJsonSafe } from '../shared.ts';
import {
  GROK_SOURCE,
  grokParts,
  isGrokMessageRow,
  isGrokSessionRow,
  normalizeGrok,
  type GrokPayload,
} from './normalize.ts';

export class GrokAdapter implements Adapter {
  readonly id: EventSource = GROK_SOURCE;

  constructor(private readonly dbPath: string = join(homedir(), '.grok', 'grok.db')) {}

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
        SELECT s.id AS s_id, s.title AS s_title, s.model AS s_model, s.mode AS s_mode,
               s.cwd_at_start AS s_cwd_at_start, s.cwd_last AS s_cwd_last,
               s.status AS s_status, s.created_at AS s_created_at, s.updated_at AS s_updated_at,
               m.session_id AS m_session_id, m.seq AS m_seq, m.role AS m_role,
               m.message_json AS m_message_json, m.created_at AS m_created_at
        FROM sessions s
        JOIN messages m ON m.session_id = s.id
        ORDER BY m.session_id, m.seq
      `);
      for (const row of stmt.iterate()) {
        const r = row as Record<string, unknown>;
        const session = {
          id: r.s_id,
          title: r.s_title,
          model: r.s_model,
          mode: r.s_mode,
          cwd_at_start: r.s_cwd_at_start,
          cwd_last: r.s_cwd_last,
          status: r.s_status,
          created_at: r.s_created_at,
          updated_at: r.s_updated_at,
        };
        if (!isGrokSessionRow(session)) continue;
        const message = {
          session_id: r.m_session_id,
          seq: r.m_seq,
          role: r.m_role,
          message_json: r.m_message_json,
          created_at: r.m_created_at,
        };
        if (!isGrokMessageRow(message)) continue;
        const messageData = parseJsonSafe(message.message_json);
        if (!isPlainRecord(messageData)) continue;
        for (const part of grokParts(message.role, messageData)) {
          const payload: GrokPayload = { session, message, messageData, part };
          yield { source: GROK_SOURCE, payload, originPath: this.dbPath };
        }
      }
    } finally {
      db.close();
    }
  }

  normalize(raw: RawEvent): Event | null {
    return normalizeGrok(raw);
  }
}
