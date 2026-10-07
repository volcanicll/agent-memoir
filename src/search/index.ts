/**
 * Search over the unified Event stream — the reason the three histories were
 * merged in the first place.
 *
 * Index design (measured on this machine, 122,605 events, 2026-10-07):
 *
 *   - FTS5 IS available in `bun:sqlite` (SQLite 3.43.2, ENABLE_FTS5=1), so the
 *     free-text path is index-backed and never scans the events table.
 *   - The index is CONTENTLESS (`content=''`): it stores the inverted index,
 *     not a second copy of the body. Measured on the real store, a regular
 *     FTS table over all searchable columns costs 153 MB on top of a 182 MB
 *     database; the contentless form costs 41 MB. Because a contentless
 *     table cannot return column values, a `search_docs` mapping table
 *     (rid → event_id, 7 MB) bridges back to `events`, and that join keeps
 *     queries at 2-6 ms p50.
 *   - The body is segmented with the SAME CJK-aware tokenizer the analysis
 *     layer uses (analyze/tokenize.ts). Raw FTS5 over Chinese would index
 *     whole runs as single tokens and miss nearly everything, so what is
 *     stored is the tokenizer's output — bigrams included — space-joined.
 *     Stop words are consequently not searchable; parseQuery reports terms it
 *     discarded instead of hiding them.
 *   - `events.rowid` is never used as an event key: VACUUM may renumber it.
 *     The mapping table owns a dense rid that it generates itself, so a
 *     vacuumed store re-indexes cleanly (the UNIQUE event_id is the truth).
 *
 * Build cost is one-time and incremental: 3.5 s for the full corpus, and a
 * re-run after `sync` only inserts events that are absent from `search_docs`
 * (a count comparison short-circuits even that). The index lives in the
 * memoir's own store; the source histories stay read-only.
 *
 * Phrase (`"…"`) queries are exact substrings and are enforced with LIKE over
 * the raw columns, because "exact substring" is precisely what a token index
 * cannot promise. A phrase-only query therefore scans (measured: 86-100 ms
 * worst case on the real store); a phrase combined with free text filters the
 * token candidates instead.
 *
 * Privacy: search output is LOCAL-ONLY. In `--json` form it carries event ids
 * and session ids because it exists for the user's own scripting, and it must
 * never be routed through the export path (see the CLI help text). Every
 * rendered snippet is home-redacted via analyze/redact.ts — a search result is
 * display output like any other.
 */

import { matchesClassFilter, type ClassFilter } from '../analyze/classify.ts';
import { HOME_REDACTION, redactHome } from '../analyze/redact.ts';
import { buildSessions, type Session } from '../analyze/session.ts';
import { tokenize } from '../analyze/tokenize.ts';
import type { Event } from '../core/event.ts';
import type { MemoirStore } from '../store/sqlite.ts';
import { parseQuery, type ParsedQuery } from './query.ts';

/**
 * Bump when the indexed body or the tokenizer changes shape: an index built
 * by an older version is dropped and rebuilt rather than served with quietly
 * different matching semantics.
 */
export const SEARCH_SCHEMA_VERSION = 1;

/** Columns that form the searchable body, in snippet-priority order. */
const INDEXED_FIELDS = ['text', 'tool_name', 'tool_args_summary', 'refs_json', 'meta_json'] as const;

/**
 * Hard bound on how many matching rows one query examines. Filters that
 * cannot be pushed into SQL (phrase substring, session class, project) are
 * applied after the row is fetched, so an over-selective filter could
 * otherwise force the engine to walk the whole index. 20,000 is under 1/6 of
 * the corpus and every measured query stays far below it; when the bound is
 * hit the result reports `truncated: true` instead of being silently short.
 */
export const CANDIDATE_CAP = 20_000;

/** How many rows to inspect per round-trip. */
const BATCH_SIZE = 256;

export interface SearchIndexStats {
  /** True when an existing index was current and nothing was written. */
  readonly reused: boolean;
  /** Events inserted into the index by this call. */
  readonly indexed: number;
  readonly total: number;
  readonly buildMs: number;
}

const SEARCH_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(body, content='', tokenize='unicode61 remove_diacritics 2');
CREATE TABLE IF NOT EXISTS search_docs (rid INTEGER PRIMARY KEY, event_id TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS search_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

function stateGet(store: MemoirStore, key: string): string | null {
  const row = store.db.query('SELECT value FROM search_state WHERE key = ?').get(key) as { value: string } | null;
  return row?.value ?? null;
}

function stateSet(store: MemoirStore, key: string, value: string): void {
  store.db
    .query('INSERT INTO search_state(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

/** The tokenizer output for one events row — what actually gets indexed. */
function indexBody(row: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const field of INDEXED_FIELDS) {
    const value = row[field];
    if (typeof value === 'string' && value.length > 0) parts.push(value);
  }
  return tokenize(parts.join('\n')).join(' ');
}

/**
 * Bring the index up to date with the events table, rebuilding it when it is
 * missing or stale by schema version. Idempotent; safe to call before every
 * query (the steady-state cost is two COUNTs, ~1 ms).
 */
export function ensureSearchIndex(store: MemoirStore, options: { force?: boolean } = {}): SearchIndexStats {
  const started = performance.now();
  store.db.exec(SEARCH_SCHEMA);

  const version = stateGet(store, 'schema_version');
  const stale = version !== String(SEARCH_SCHEMA_VERSION);
  const eventsCount = store.count();

  if (options.force === true || stale) {
    if (stale && version !== null) {
      // A version change means the body format changed; an old index would
      // answer with the wrong matching semantics, so it is discarded.
      store.db.exec('DROP TABLE IF EXISTS search_fts');
      store.db.exec('DROP TABLE IF EXISTS search_docs');
      store.db.exec(SEARCH_SCHEMA);
    }
  } else {
    const indexed = (store.db.query('SELECT COUNT(*) AS c FROM search_docs').get() as { c: number }).c;
    if (indexed === eventsCount) {
      return { reused: true, indexed: 0, total: eventsCount, buildMs: performance.now() - started };
    }
  }

  const maxRid = (store.db.query('SELECT COALESCE(MAX(rid), 0) AS m FROM search_docs').get() as { m: number }).m;
  const insertDoc = store.db.query('INSERT INTO search_docs(rid, event_id) VALUES (?, ?)');
  const insertFts = store.db.query('INSERT INTO search_fts(rowid, body) VALUES (?, ?)');
  const pending = store.db
    .query(
      `SELECT e.id AS id, e.text AS text, e.tool_name AS tool_name, e.tool_args_summary AS tool_args_summary,
              e.refs_json AS refs_json, e.meta_json AS meta_json
       FROM events e
       LEFT JOIN search_docs d ON d.event_id = e.id
       WHERE d.event_id IS NULL
       ORDER BY e.rowid`,
    )
    .iterate() as Iterable<Record<string, unknown>>;

  let rid = maxRid;
  let indexed = 0;
  store.db.exec('BEGIN');
  try {
    for (const row of pending) {
      rid += 1;
      insertDoc.run(rid, String(row.id));
      insertFts.run(rid, indexBody(row));
      indexed += 1;
      if (indexed % 20_000 === 0) {
        store.db.exec('COMMIT');
        store.db.exec('BEGIN');
      }
    }
    stateSet(store, 'schema_version', String(SEARCH_SCHEMA_VERSION));
    stateSet(store, 'indexed_at', String(Date.now()));
    store.db.exec('COMMIT');
  } catch (err) {
    store.db.exec('ROLLBACK');
    throw err;
  }

  return { reused: false, indexed, total: store.count(), buildMs: performance.now() - started };
}

// ------------------------------------------------------------------ snippets

export type SnippetField = 'text' | 'tool.args' | 'tool.name' | 'refs' | 'meta';

export interface Snippet {
  /** Redacted, single-line window around the match. */
  readonly text: string;
  readonly field: SnippetField;
  /** False when nothing literal was found and the head of a field was shown. */
  readonly matched: boolean;
}

const SNIPPETS: ReadonlyArray<readonly [SnippetField, (event: Event) => string | undefined]> = [
  ['text', (event) => event.text],
  ['tool.args', (event) => event.tool?.argsSummary],
  ['tool.name', (event) => event.tool?.name],
  [
    'refs',
    (event) => {
      const refs = event.refs;
      if (refs === undefined) return undefined;
      const parts = [refs.cwd, refs.model, ...(refs.files ?? []), ...(refs.urls ?? [])].filter(
        (part): part is string => typeof part === 'string' && part.length > 0,
      );
      return parts.length === 0 ? undefined : parts.join(' ');
    },
  ],
  ['meta', (event) => (Object.keys(event.meta).length === 0 ? undefined : JSON.stringify(event.meta))],
];

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function windowAround(text: string, index: number, matchLength: number, width: number): string {
  const before = Math.min(60, index);
  const start = Math.max(0, index - before);
  const end = Math.min(text.length, index + matchLength + (width - before));
  const head = start > 0 ? '…' : '';
  const tail = end < text.length ? '…' : '';
  return `${head}${text.slice(start, end)}${tail}`;
}

/**
 * A short display window around the query's match in `event`, or the head of
 * the most useful field when the match was token-level and no literal
 * occurrence exists (possible when a term came from meta whose JSON escapes
 * the characters). Always home-redacted: a search result is display output.
 */
export function snippet(event: Event, query: ParsedQuery, width = 220): Snippet {
  const needles = [...query.phrases, ...query.terms];
  const lowered = needles.map((needle) => needle.toLowerCase());
  for (const [field, valueOf] of SNIPPETS) {
    const value = valueOf(event);
    if (value === undefined || value.length === 0) continue;
    const flat = collapse(value);
    const flatLower = flat.toLowerCase();
    let best = -1;
    let bestLength = 0;
    for (const needle of lowered) {
      if (needle.length === 0) continue;
      const at = flatLower.indexOf(needle);
      if (at >= 0 && (best < 0 || at < best)) {
        best = at;
        bestLength = needle.length;
      }
    }
    if (best >= 0) return { text: redactHome(windowAround(flat, best, bestLength, width)), field, matched: true };
  }
  for (const [field, valueOf] of SNIPPETS) {
    const value = valueOf(event);
    if (value !== undefined && value.length > 0) {
      return { text: redactHome(windowAround(collapse(value), 0, 0, width)), field, matched: false };
    }
  }
  return { text: '', field: 'text', matched: false };
}

// ------------------------------------------------------------------ querying

export interface SearchHit {
  /** The full local event. Contains conversation text — local output only. */
  readonly event: Event;
  readonly session: Session;
  /** bm25-derived relevance (higher is better) for free text; null otherwise. */
  readonly score: number | null;
  readonly snippet: string;
  readonly snippetField: SnippetField;
  readonly snippetMatched: boolean;
}

export interface SearchResult {
  readonly query: ParsedQuery;
  readonly hits: readonly SearchHit[];
  /** Rows examined; the honest denominator for a truncated run. */
  readonly examined: number;
  /** True when CANDIDATE_CAP stopped the search before the stream ended. */
  readonly truncated: boolean;
  readonly elapsedMs: number;
}

export interface SearchOptions {
  readonly limit?: number;
  /**
   * Session-class filter from the CLI flag. Default 'all': unlike the portrait
   * (which defaults to interactive because 84% of the corpus is a scheduler),
   * a SEARCH that silently hid automation results would make the user believe
   * a stored memory does not exist. Narrowing is explicit.
   */
  readonly classFilter?: ClassFilter;
  /** Skip the index freshness check (tests that just built it). */
  readonly skipIndexCheck?: boolean;
}

/** Row as SQLite returns it, before the Event shape is reconstructed. */
interface Row {
  id: string;
  source: string;
  session_id: string;
  ordinal: number;
  ts: number;
  role: string;
  kind: string;
  text: string | null;
  raw_ref: string | null;
  tool_name: string | null;
  tool_args_summary: string | null;
  tool_ok: number | null;
  refs_json: string | null;
  meta_json: string;
}

const EVENT_COLUMNS = `e.id AS id, e.source AS source, e.session_id AS session_id, e.ordinal AS ordinal,
  e.ts AS ts, e.role AS role, e.kind AS kind, e.text AS text, e.raw_ref AS raw_ref,
  e.tool_name AS tool_name, e.tool_args_summary AS tool_args_summary, e.tool_ok AS tool_ok,
  e.refs_json AS refs_json, e.meta_json AS meta_json`;

function parseJsonColumn(value: unknown): unknown {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function rowToEvent(row: Row): Event {
  const event: Event = {
    id: String(row.id),
    source: String(row.source),
    sessionId: String(row.session_id),
    ordinal: Number(row.ordinal),
    ts: Number(row.ts),
    role: String(row.role) as Event['role'],
    kind: String(row.kind) as Event['kind'],
    meta: {},
  };
  const meta = parseJsonColumn(row.meta_json);
  if (typeof meta === 'object' && meta !== null && !Array.isArray(meta)) event.meta = meta as Record<string, unknown>;
  if (typeof row.text === 'string' && row.text.length > 0) event.text = row.text;
  if (typeof row.raw_ref === 'string') event.rawRef = row.raw_ref;
  if (typeof row.tool_name === 'string' && row.tool_name.length > 0) {
    event.tool = {
      name: row.tool_name,
      ...(typeof row.tool_args_summary === 'string' ? { argsSummary: row.tool_args_summary } : {}),
      ...(row.tool_ok === null ? {} : { ok: Number(row.tool_ok) === 1 }),
    };
  }
  const refs = parseJsonColumn(row.refs_json);
  if (typeof refs === 'object' && refs !== null) event.refs = refs as Event['refs'];
  return event;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** The raw haystack columns, matching the indexed fields. */
function haystackOf(row: Row): string {
  const parts: string[] = [];
  for (const field of INDEXED_FIELDS) {
    const value = row[field];
    if (typeof value === 'string' && value.length > 0) parts.push(value);
  }
  return parts.join('\n');
}

interface Pushdown {
  /** SQL fragments joined with AND. */
  readonly clauses: string[];
  readonly params: Array<string | number>;
}

/**
 * Filters that go into SQL, so the FTS candidate stream is narrowed before a
 * row is ever hydrated.
 *
 * `tool:` and `project:` are substring matches (the brief's semantics), which
 * a LIKE serves exactly as well as a JS `includes` — and pushing them down
 * matters: `class:interactive tool:exec_command` matched 7,700 candidates and
 * spent 107 ms hydrating them just to reject almost all (measured before this
 * pushdown). Class stays in JS either way: it is a derivation over a whole
 * session's events, not a property of one row.
 *
 * A `project:` term written in the redacted `~/…` form is translated to the
 * raw home prefix for the LIKE. That translation is a SUPERSET: a raw path is
 * only rejected later by the exact redacted check in jsFiltersPass, so a
 * boundary case like `/Users/volcanic2` is filtered out again rather than
 * admitted.
 */
function pushdownFor(query: ParsedQuery): Pushdown {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (query.sources.length > 0) {
    clauses.push(`e.source IN (${query.sources.map(() => '?').join(', ')})`);
    params.push(...query.sources);
  }
  if (query.kinds.length > 0) {
    clauses.push(`e.kind IN (${query.kinds.map(() => '?').join(', ')})`);
    params.push(...query.kinds);
  }
  if (query.after !== null) {
    clauses.push('e.ts >= ?');
    params.push(query.after);
  }
  if (query.before !== null) {
    clauses.push('e.ts < ?');
    params.push(query.before);
  }
  if (query.tools.length > 0) {
    clauses.push(`(${query.tools.map(() => `e.tool_name LIKE ? ESCAPE '\\'`).join(' OR ')})`);
    for (const tool of query.tools) params.push(`%${escapeLike(tool)}%`);
  }
  if (query.projects.length > 0) {
    clauses.push(`(${query.projects.map(() => `e.refs_json LIKE ? ESCAPE '\\'`).join(' OR ')})`);
    for (const project of query.projects) {
      const raw = project.startsWith('~/') ? `${HOME_REDACTION}/${project.slice(2)}` : project;
      params.push(`%${escapeLike(raw)}%`);
    }
  }
  if (query.phrases.length > 0 && query.terms.length === 0) {
    // Phrase-only: no token candidates exist, so the substrings ARE the query
    // and the scan happens here. LIKE is ASCII-case-insensitive by default,
    // which makes the match case-insensitive for Latin and exact for CJK
    // (where case does not exist).
    const perColumn = (column: string): string =>
      `(${query.phrases.map(() => `e.${column} LIKE ? ESCAPE '\\'`).join(' OR ')})`;
    clauses.push(`(${INDEXED_FIELDS.map(perColumn).join(' OR ')})`);
    for (const phrase of query.phrases) {
      const needle = `%${escapeLike(phrase)}%`;
      for (const _ of INDEXED_FIELDS) params.push(needle);
    }
  }
  return { clauses, params };
}

/**
 * The checks that need the row only, run BEFORE the session is loaded. Order
 * matters for latency: loading a session costs a full query over its events
 * (Codex sessions hold thousands), so the expensive class test is last.
 */
function rowFiltersPass(query: ParsedQuery, row: Row, event: Event): boolean {
  if (query.tools.length > 0) {
    const name = (event.tool?.name ?? '').toLowerCase();
    if (!query.tools.some((tool) => name.includes(tool.toLowerCase()))) return false;
  }
  if (query.projects.length > 0) {
    const cwd = event.refs?.cwd;
    if (cwd === undefined) return false;
    // The brief's rule: a project filter matches the redacted ~/… form or a
    // raw substring, so a user can type either one and get the same rows.
    const redacted = redactHome(cwd);
    if (!query.projects.some((project) => redacted.includes(project) || cwd.includes(project))) return false;
  }
  if (query.phrases.length > 0 && query.terms.length > 0) {
    // Terms already matched in the index; phrases are exact substrings and
    // must be checked literally against the fetched row.
    const lowered = haystackOf(row).toLowerCase();
    if (!query.phrases.every((phrase) => lowered.includes(phrase.toLowerCase()))) return false;
  }
  return true;
}

/**
 * Search the store. `query` may be a raw string (parsed here) or an already
 * parsed Query — the CLI parses once so it can report what it understood.
 */
export function search(store: MemoirStore, query: string | ParsedQuery, options: SearchOptions = {}): SearchResult {
  const started = performance.now();
  const parsed = typeof query === 'string' ? parseQuery(query) : query;
  const limit = Math.max(1, options.limit ?? 20);
  const classFilter: ClassFilter = options.classFilter ?? 'all';

  if (options.skipIndexCheck !== true) ensureSearchIndex(store);

  const pushdown = pushdownFor(parsed);
  const usingTerms = parsed.terms.length > 0;
  const hits: SearchHit[] = [];
  const sessions = new Map<string, Session>();
  let examined = 0;
  let truncated = false;

  const rowsById = (ids: readonly string[]): Map<string, Row> => {
    if (ids.length === 0) return new Map();
    const rows = store.db
      .query(`SELECT ${EVENT_COLUMNS} FROM events e WHERE e.id IN (${ids.map(() => '?').join(', ')})`)
      .all(...ids) as Row[];
    return new Map(rows.map((row) => [row.id, row]));
  };

  /** Load (and cache) the session a hit belongs to. */
  const sessionFor = (event: Event): Session => {
    const key = `${event.source}:${event.sessionId}`;
    const cached = sessions.get(key);
    if (cached !== undefined) return cached;
    const sessionRows = store.db
      .query(`SELECT ${EVENT_COLUMNS} FROM events e WHERE e.session_id = ? ORDER BY e.ordinal`)
      .all(event.sessionId) as Row[];
    for (const session of buildSessions(sessionRows.map((row) => rowToEvent(row)))) {
      sessions.set(session.key, session);
    }
    const built = sessions.get(key);
    if (built !== undefined) return built;
    // No row found (impossible after a hit hydrated from the same table, but
    // keep the function total).
    return buildSessions([event])[0] as Session;
  };

  /** Consume one batch of candidates; returns true when `limit` is reached. */
  const consume = (candidates: ReadonlyArray<{ id: string; rank: number | null }>): boolean => {
    const byId = rowsById(candidates.map((candidate) => candidate.id));
    for (const candidate of candidates) {
      const row = byId.get(candidate.id);
      if (row === undefined) continue;
      examined += 1;
      const event = rowToEvent(row);
      // Row-local checks first: they are pure string tests. The session load
      // and the class derivation are the expensive steps, so they run last —
      // and only when the cheap filters did not already reject the row.
      if (!rowFiltersPass(parsed, row, event)) continue;
      const session = sessionFor(event);
      if (!matchesClassFilter(session.cls, classFilter)) continue;
      if (parsed.classes.length > 0 && !parsed.classes.includes(session.cls)) continue;
      const found = snippet(event, parsed);
      hits.push({
        event,
        session,
        score: candidate.rank === null ? null : -candidate.rank,
        snippet: found.text,
        snippetField: found.field,
        snippetMatched: found.matched,
      });
      if (hits.length >= limit) return true;
    }
    return false;
  };

  if (usingTerms) {
    const match = parsed.terms.map((term) => `"${term}"`).join(' AND ');
    const where = pushdown.clauses.length > 0 ? ` AND ${pushdown.clauses.join(' AND ')}` : '';
    const sql = `SELECT d.event_id AS id, bm25(search_fts) AS rank
      FROM search_fts JOIN search_docs d ON d.rid = search_fts.rowid JOIN events e ON e.id = d.event_id
      WHERE search_fts MATCH ?${where}
      ORDER BY rank LIMIT ? OFFSET ?`;
    const params: Array<string | number> = [match, ...pushdown.params];
    for (let offset = 0; offset < CANDIDATE_CAP; offset += BATCH_SIZE) {
      const batch = store.db.query(sql).all(...params, BATCH_SIZE, offset) as Array<{ id: string; rank: number }>;
      if (batch.length === 0) break;
      if (consume(batch)) return finish();
      if (offset + batch.length >= CANDIDATE_CAP) {
        truncated = true;
        break;
      }
    }
  } else {
    // No free text: filters and/or phrases only, ordered by recency.
    //
    // Paged with .all() rather than a live .iterate(): hydrating a batch runs
    // further statements on the same connection, and bun:sqlite invalidates an
    // open iterator when that happens ("bad parameter or other API misuse").
    // The order is (ts, id) — total and stable — so OFFSET paging cannot skip
    // or repeat a row.
    const where = pushdown.clauses.length > 0 ? ` WHERE ${pushdown.clauses.join(' AND ')}` : '';
    const sql = `SELECT ${EVENT_COLUMNS} FROM events e${where} ORDER BY e.ts DESC, e.id DESC LIMIT ? OFFSET ?`;
    const params: Array<string | number> = [...pushdown.params];
    for (let offset = 0; offset < CANDIDATE_CAP; offset += BATCH_SIZE) {
      const batch = store.db.query(sql).all(...params, BATCH_SIZE, offset) as Row[];
      if (batch.length === 0) break;
      if (
        consume(
          batch.map((row) => ({ id: row.id, rank: null })),
        )
      ) {
        return finish();
      }
      if (offset + batch.length >= CANDIDATE_CAP) {
        truncated = true;
        break;
      }
    }
  }

  function finish(): SearchResult {
    return { query: parsed, hits, examined, truncated, elapsedMs: performance.now() - started };
  }
  return finish();
}
