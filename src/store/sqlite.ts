/**
 * SQLite persistence for the unified Event stream — fully source-agnostic.
 *
 * The events table knows nothing about Hermes/Claude/Codex; source-specific
 * structure only exists inside the `meta`/`refs` JSON columns, exactly as in
 * the Event schema. Incremental sync relies on INSERT OR IGNORE keyed by the
 * deterministic event id.
 */

import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Event } from '../core/event.ts';

export interface InsertStats {
  inserted: number;
  ignored: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id          TEXT PRIMARY KEY,
  source      TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  ordinal     INTEGER NOT NULL,
  ts          INTEGER NOT NULL,
  role        TEXT NOT NULL,
  kind        TEXT NOT NULL,
  text        TEXT,
  raw_ref     TEXT,
  tool_name   TEXT,
  tool_args_summary TEXT,
  tool_ok     INTEGER,
  refs_json   TEXT,
  meta_json   TEXT NOT NULL,
  ingested_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_source ON events(source);
-- Query-shape indexes added in Phase 2 (measured, 122k rows):
--   search narrows by source or kind and then wants the newest matches, so
--   the composite (equality column, ts) lets SQLite walk the ts index inside
--   the equality instead of scanning the whole ts order backwards
--   (source:codex kind:reasoning measured 46 ms → single digits).
CREATE INDEX IF NOT EXISTS idx_events_source_ts ON events(source, ts);
CREATE INDEX IF NOT EXISTS idx_events_kind_ts ON events(kind, ts);
-- Friction's repeated-failure pass reads exactly these (tool_ok = 0 rows) and
-- measureTouches reads the write-like tools; both are tiny slivers of the
-- table and scanning them linearly is wasted work on every call.
CREATE INDEX IF NOT EXISTS idx_events_tool_ok ON events(tool_ok) WHERE tool_ok = 0;
`;

export class MemoirStore {
  readonly db: Database;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(SCHEMA);
  }

  private insertStatement = () =>
    this.db.query(
      `INSERT OR IGNORE INTO events
       (id, source, session_id, ordinal, ts, role, kind, text, raw_ref,
        tool_name, tool_args_summary, tool_ok, refs_json, meta_json, ingested_at)
       VALUES ($id, $source, $sessionId, $ordinal, $ts, $role, $kind, $text, $rawRef,
               $toolName, $toolArgsSummary, $toolOk, $refsJson, $metaJson, $ingestedAt)`,
    );

  append(event: Event): InsertStats {
    const info = this.insertStatement().run({
      $id: event.id,
      $source: event.source,
      $sessionId: event.sessionId,
      $ordinal: event.ordinal,
      $ts: event.ts,
      $role: event.role,
      $kind: event.kind,
      $text: event.text ?? null,
      $rawRef: event.rawRef ?? null,
      $toolName: event.tool?.name ?? null,
      $toolArgsSummary: event.tool?.argsSummary ?? null,
      $toolOk: event.tool?.ok === undefined ? null : event.tool.ok ? 1 : 0,
      $refsJson: event.refs === undefined ? null : JSON.stringify(event.refs),
      $metaJson: JSON.stringify(event.meta),
      $ingestedAt: Date.now(),
    });
    return { inserted: info.changes, ignored: 1 - info.changes };
  }

  appendMany(events: Iterable<Event>): InsertStats {
    let inserted = 0;
    let ignored = 0;
    this.db.exec('BEGIN');
    try {
      for (const e of events) {
        const s = this.append(e);
        inserted += s.inserted;
        ignored += s.ignored;
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return { inserted, ignored };
  }

  count(source?: string): number {
    if (source === undefined) {
      return (this.db.query('SELECT COUNT(*) AS c FROM events').get() as { c: number }).c;
    }
    return (
      this.db.query('SELECT COUNT(*) AS c FROM events WHERE source = ?').get(source) as { c: number }
    ).c;
  }

  /** Per-source event counts and ts range — proves cross-source coexistence. */
  sourceSummaries(): Array<{ source: string; count: number; minTs: number; maxTs: number }> {
    return this.db
      .query(
        `SELECT source, COUNT(*) AS count, MIN(ts) AS minTs, MAX(ts) AS maxTs
         FROM events GROUP BY source ORDER BY MIN(ts)`,
      )
      .all() as Array<{ source: string; count: number; minTs: number; maxTs: number }>;
  }

  /** Events ordered by ts (crossing sources), for the cross-source query proof. */
  byTime(limit = 10): Array<{ ts: number; source: string; kind: string }> {
    return this.db
      .query('SELECT ts, source, kind FROM events ORDER BY ts LIMIT ?')
      .all(limit) as Array<{ ts: number; source: string; kind: string }>;
  }

  close(): void {
    this.db.close();
  }
}
