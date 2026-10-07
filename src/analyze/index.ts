/**
 * The analysis layer's one public entry point: analyzeAll(store, options) → Portrait.
 *
 * The Portrait is the single input to the renderer — the renderer never
 * touches the store, so what the page can show is exactly what the analysis
 * layer chose to expose. That keeps the privacy boundary auditable at one
 * seam and makes the whole pipeline testable against a synthetic fixture.
 *
 * Every section is computed once per session class. The brief's hard
 * requirement — 92% of sessions are cron on this machine, so a portrait over
 * raw totals describes a scheduler — is met structurally: there is no
 * unfiltered aggregate anywhere in this file. `views.all` exists only as a
 * comparison target for the toggle, never as the default.
 *
 * Data passing into a ClassView is display-ready: paths are redacted inside
 * projects/drift, so nothing downstream needs to remember to redact again.
 */

import type { Event } from '../core/event.ts';
import type { MemoirStore } from '../store/sqlite.ts';
import { CLASS_FILTERS, type ClassFilter, type SessionClass } from './classify.ts';
import { computeDrift, type Drift } from './drift.ts';
import { computeProjects, type Projects } from './projects.ts';
import { computeRhythm, type Rhythm, type TimeSpan } from './rhythm.ts';
import { buildSessions, filterSessions, tallyByClass, type Session } from './session.ts';
import { dayCountInclusive } from './time.ts';
import { computeVocabulary, type Vocabulary } from './vocabulary.ts';

export interface ClassView {
  readonly cls: ClassFilter;
  readonly sessions: number;
  readonly events: number;
  readonly rhythm: Rhythm;
  readonly vocabulary: Vocabulary;
  readonly projects: Projects;
  readonly drift: Drift | null;
}

export interface ClassTally {
  readonly sessions: number;
  readonly events: number;
}

export interface SourceTally {
  /** Adapter id ('hermes', 'claude-code', 'codex'). */
  readonly source: string;
  readonly sessions: number;
  readonly events: number;
}

export interface LabelTally {
  /** Human-facing session origin: 'telegram', 'cli', 'codex', … */
  readonly label: string;
  readonly source: string;
  readonly cls: SessionClass;
  readonly sessions: number;
  readonly events: number;
}

export interface Portrait {
  readonly generatedAt: number;
  readonly span: {
    readonly startTs: number;
    readonly endTs: number;
    /** Inclusive local-calendar days across the span. */
    readonly days: number;
  };
  readonly totals: {
    readonly events: number;
    readonly sessions: number;
    readonly byClass: Readonly<Record<SessionClass, ClassTally>>;
  };
  readonly sources: readonly SourceTally[];
  readonly labels: readonly LabelTally[];
  /** One view per class filter; `interactive` is the honest default. */
  readonly views: Readonly<Record<ClassFilter, ClassView>>;
}

export interface AnalyzeOptions {
  /** Top-N terms and tools per view. */
  readonly topTerms?: number;
  readonly topTools?: number;
}

const DEFAULTS = { topTerms: 40, topTools: 20 } as const;

/** Sessions in the store, built once and shared by every view. */
export function loadSessions(store: MemoirStore): Session[] {
  // The store is the only thing that knows how to page through events; it
  // returns them ordered by ts, and buildSessions re-sorts within a session
  // by ordinal (the stable per-session order).
  const events = store.db
    .query(
      `SELECT id, source, session_id, ordinal, ts, role, kind, text, raw_ref, tool_name,
              tool_args_summary, tool_ok, refs_json, meta_json
       FROM events ORDER BY ts, id`,
    )
    .iterate() as Iterable<Record<string, unknown>>;
  const all: Event[] = [];
  for (const row of events) all.push(rowToEvent(row));
  return buildSessions(all);
}

function parseJsonColumn(value: unknown): unknown {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function rowToEvent(row: Record<string, unknown>): Event {
  const toolName = row.tool_name;
  const refs = parseJsonColumn(row.refs_json);
  const meta = parseJsonColumn(row.meta_json);
  const event: Event = {
    id: String(row.id),
    source: String(row.source),
    sessionId: String(row.session_id),
    ordinal: Number(row.ordinal),
    ts: Number(row.ts),
    role: String(row.role) as Event['role'],
    kind: String(row.kind) as Event['kind'],
    meta: meta !== undefined && typeof meta === 'object' && meta !== null ? (meta as Record<string, unknown>) : {},
  };
  if (typeof row.text === 'string' && row.text.length > 0) event.text = row.text;
  if (typeof row.raw_ref === 'string') event.rawRef = row.raw_ref;
  if (typeof toolName === 'string' && toolName.length > 0) {
    event.tool = {
      name: toolName,
      ...(typeof row.tool_args_summary === 'string' ? { argsSummary: row.tool_args_summary } : {}),
      ...(row.tool_ok === null || row.tool_ok === undefined ? {} : { ok: Number(row.tool_ok) === 1 }),
    };
  }
  if (refs !== undefined && typeof refs === 'object' && refs !== null) event.refs = refs as Event['refs'];
  return event;
}

/**
 * The whole analysis, from a store to a renderable Portrait.
 *
 * Span is fixed once from ALL sessions and reused by every view so the
 * series lengths line up and zeros are comparable across the toggle.
 */
export function analyzeAll(store: MemoirStore, options: AnalyzeOptions = {}): Portrait {
  const topTerms = options.topTerms ?? DEFAULTS.topTerms;
  const topTools = options.topTools ?? DEFAULTS.topTools;

  const sessions = loadSessions(store);
  let startTs = Number.POSITIVE_INFINITY;
  let endTs = 0;
  for (const session of sessions) {
    if (session.startTs < startTs) startTs = session.startTs;
    if (session.endTs > endTs) endTs = session.endTs;
  }
  if (sessions.length === 0) {
    startTs = 0;
    endTs = 0;
  }
  const span: TimeSpan = { startTs, endTs };

  const tally = tallyByClass(sessions);
  const views = {} as Record<ClassFilter, ClassView>;
  for (const filter of CLASS_FILTERS) {
    const selected = filterSessions(sessions, filter);
    views[filter] = {
      cls: filter,
      sessions: selected.length,
      events: selected.reduce((total, session) => total + session.eventCount, 0),
      rhythm: computeRhythm(sessions, filter, span),
      vocabulary: computeVocabulary(sessions, filter, Math.max(topTerms, topTools)),
      projects: computeProjects(sessions, filter),
      drift: computeDrift(sessions, filter, { termDepth: 200, termLimit: 12 }),
    };
  }

  const sourceMap = new Map<string, SourceTally>();
  const labelMap = new Map<string, LabelTally>();
  for (const session of sessions) {
    const source = sourceMap.get(session.source) ?? { source: session.source, sessions: 0, events: 0 };
    sourceMap.set(session.source, { ...source, sessions: source.sessions + 1, events: source.events + session.eventCount });
    const key = `${session.label}|${session.source}|${session.cls}`;
    const label = labelMap.get(key) ?? { label: session.label, source: session.source, cls: session.cls, sessions: 0, events: 0 };
    labelMap.set(key, { ...label, sessions: label.sessions + 1, events: label.events + session.eventCount });
  }

  return {
    generatedAt: Date.now(),
    span: { startTs, endTs, days: dayCountInclusive(startTs, endTs) },
    totals: {
      events: sessions.reduce((total, session) => total + session.eventCount, 0),
      sessions: sessions.length,
      byClass: {
        interactive: tally.interactive,
        automation: tally.automation,
        other: tally.other,
      },
    },
    sources: [...sourceMap.values()].sort((a, b) => b.events - a.events),
    labels: [...labelMap.values()].sort((a, b) => b.events - a.events),
    views,
  };
}
