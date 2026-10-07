/**
 * OpenCode adapter — reads the local SQLite store ~/.local/share/opencode.db
 * (actual path: ~/.local/share/opencode/opencode.db).
 *
 * Zero-write guarantee, identical to the Hermes adapter: the db runs in WAL
 * mode, and even a plain readonly open touches the -shm file's mtime. We open
 * with `?immutable=1`, which skips shm/wal entirely; the cost is that WAL
 * content not yet checkpointed is invisible until OpenCode checkpoints.
 *
 * read() joins session → message → part in stream order and numbers messages
 * 0-based per session (see ./normalize.ts for the ordinal scheme). Read-only;
 * nothing is ever written back.
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
  OPENCODE_SOURCE,
  OPENCODE_PART_SPACE,
  isOpencodeMessageRow,
  isOpencodePartRow,
  isOpencodeSessionRow,
  type OpencodePartKind,
  type OpencodePartRow,
  normalizeOpencode,
  opencodePartsFor,
  type OpencodePayload,
} from './normalize.ts';

export class OpencodeAdapter implements Adapter {
  readonly id: EventSource = OPENCODE_SOURCE;

  constructor(private readonly dbPath: string = join(homedir(), '.local', 'share', 'opencode', 'opencode.db')) {}

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
        SELECT s.id AS s_id, s.directory AS s_directory, s.title AS s_title,
               s.time_created AS s_time_created, s.time_updated AS s_time_updated,
               s.parent_id AS s_parent_id,
               m.id AS m_id, m.session_id AS m_session_id, m.time_created AS m_time_created, m.data AS m_data
        FROM session s
        JOIN message m ON m.session_id = s.id
        ORDER BY m.session_id, m.time_created, m.id
      `);
      let currentSessionId = '';
      let messageRank = -1;
      for (const row of stmt.iterate()) {
        const r = row as Record<string, unknown>;
        const session = {
          id: r.s_id,
          directory: r.s_directory,
          title: r.s_title,
          time_created: r.s_time_created,
          time_updated: r.s_time_updated,
          parent_id: r.s_parent_id,
        };
        if (!isOpencodeSessionRow(session)) continue;
        const message = { id: r.m_id, session_id: r.m_session_id, time_created: r.m_time_created, data: r.m_data };
        if (!isOpencodeMessageRow(message)) continue;
        if (message.session_id !== currentSessionId) {
          currentSessionId = message.session_id;
          messageRank = 0;
        } else if (messageRank >= 0) {
          messageRank++;
        }
        if (messageRank < 0) continue;
        const messageData = parseJsonSafe(message.data);
        if (!isPlainRecord(messageData)) continue;
        const role = typeof messageData.role === 'string' ? messageData.role : '';
        const parts = partsFor(db, message.id, role);

        // Fan-out: one part per mappable unit of this message (synthetic text
        // parts are dropped inside partsFor()). A user message whose parts are
        // all synthetic maps whole; an assistant message's text lives in its
        // part rows.
        if (parts.length === 0 && role === 'user') {
          const payload: OpencodePayload = {
            session,
            message,
            messageRank,
            messageData,
            part: { kind: 'message', index: 0 },
            offset: 0,
          };
          yield { source: OPENCODE_SOURCE, payload, originPath: this.dbPath };
          continue;
        }
        const kindCounter = new Map<string, number>();
        for (let offset = 0; offset < parts.length; offset++) {
          const { partRow, kind } = parts[offset]!;
          const index = kindCounter.get(kind) ?? 0;
          kindCounter.set(kind, index + 1);
          if (offset >= OPENCODE_PART_SPACE) continue;
          const payload: OpencodePayload = {
            session,
            message,
            messageRank,
            partRow,
            messageData,
            part: { kind, index },
            offset,
          };
          yield { source: OPENCODE_SOURCE, payload, originPath: this.dbPath };
        }
      }
    } finally {
      db.close();
    }
  }

  normalize(raw: RawEvent): Event | null {
    return normalizeOpencode(raw);
  }
}

interface MappablePart {
  partRow: OpencodePartRow;
  kind: OpencodePartKind;
}

/** Mappable part-rows of one message, expanded per row, in stored order. */
function partsFor(db: Database, messageId: string, role: string): MappablePart[] {
  const stmt = db.query('SELECT id, message_id, session_id, data FROM part WHERE message_id = ? ORDER BY time_created, id');
  const found: MappablePart[] = [];
  for (const row of stmt.iterate(messageId)) {
    const r = row as Record<string, unknown>;
    const partRow = { id: r.id, message_id: r.message_id, session_id: r.session_id, data: r.data };
    if (!isOpencodePartRow(partRow)) continue;
    const blob = parseJsonSafe(partRow.data);
    if (!isPlainRecord(blob)) continue;
    for (const part of opencodePartsFor(role, blob)) {
      // Synthetic text parts (editor-context reminders) are dropped: they are
      // not conversation content and would corrupt the user-turn analysis.
      if (part.kind === 'message' && blob.synthetic === true) continue;
      found.push({ partRow, kind: part.kind });
    }
  }
  return found;
}
