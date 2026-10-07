/**
 * Session view of the Event stream — the unit every aggregate runs on.
 *
 * The store hands back a flat, ts-ordered event list; every analysis module
 * wants sessions. Building them once, here, means classification, cwd/model
 * dominance and time bounds are computed exactly once and every aggregate
 * afterwards is a pure function over the same annotated objects.
 *
 * A session is identified by (source, sessionId): session ids are unique per
 * source but not across sources (Codex forked rollouts and Hermes ids can
 * collide), so the pair is the key. The raw key is local-only — it never
 * reaches the Portrait or the rendered site.
 */

import type { Event } from '../core/event.ts';
import {
  classifySession,
  matchesClassFilter,
  sessionSourceLabel,
  type ClassFilter,
  type SessionClass,
} from './classify.ts';

export interface Session {
  /** `${source}:${sessionId}` — local only, never rendered. */
  readonly key: string;
  readonly source: string;
  readonly sessionId: string;
  /** Human-facing origin: Hermes session source ('telegram'), else the adapter id. */
  readonly label: string;
  readonly cls: SessionClass;
  /** Events sorted by ordinal (the store's stable within-session order). */
  readonly events: readonly Event[];
  readonly eventCount: number;
  readonly startTs: number;
  readonly endTs: number;
  /** Dominant cwd across the session's events, raw (un-redacted). Local only. */
  readonly cwd?: string;
  /** Dominant model across the session's events. */
  readonly model?: string;
  readonly metaSource?: string;
}

function dominantValue(counts: Map<string, number>): string | undefined {
  let best: string | undefined;
  let bestCount = -1;
  for (const [value, count] of counts) {
    // Ties break on lexicographic order so the choice is deterministic.
    if (count > bestCount || (count === bestCount && best !== undefined && value < best)) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

function bump(counts: Map<string, number>, value: string): void {
  counts.set(value, (counts.get(value) ?? 0) + 1);
}

/**
 * Group events into sessions. Input order does not matter; within a session
 * events are sorted by ordinal because that is the stable source order
 * (same-millisecond ts collisions are common and ts is not monotonic with
 * the conversation).
 */
export function buildSessions(events: readonly Event[]): Session[] {
  const groups = new Map<string, Event[]>();
  for (const event of events) {
    const key = `${event.source}:${event.sessionId}`;
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [event]);
    else list.push(event);
  }

  const sessions: Session[] = [];
  for (const [key, group] of groups) {
    group.sort((a, b) => a.ordinal - b.ordinal);
    const first = group[0];
    if (first === undefined) continue; // cannot happen: groups are never empty
    let startTs = first.ts;
    let endTs = first.ts;
    const cwds = new Map<string, number>();
    const models = new Map<string, number>();
    for (const event of group) {
      if (event.ts < startTs) startTs = event.ts;
      if (event.ts > endTs) endTs = event.ts;
      if (typeof event.refs?.cwd === 'string' && event.refs.cwd.length > 0) bump(cwds, event.refs.cwd);
      if (typeof event.refs?.model === 'string' && event.refs.model.length > 0) bump(models, event.refs.model);
    }
    const metaSource = sessionSourceLabel(group);
    const cwd = dominantValue(cwds);
    const model = dominantValue(models);
    sessions.push({
      key,
      source: first.source,
      sessionId: first.sessionId,
      // Hermes carries its channel label on every event; every other adapter
      // is its own best label. See sessionSourceLabel() for why the Codex
      // per-file `source` field is not used here.
      label: metaSource ?? first.source,
      cls: classifySession(group),
      events: group,
      eventCount: group.length,
      startTs,
      endTs,
      ...(cwd === undefined ? {} : { cwd }),
      ...(model === undefined ? {} : { model }),
      metaSource,
    });
  }

  sessions.sort((a, b) => a.startTs - b.startTs || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return sessions;
}

/** The one filter predicate every aggregate must route sessions through. */
export function filterSessions(sessions: readonly Session[], filter: ClassFilter): Session[] {
  return sessions.filter((session) => matchesClassFilter(session.cls, filter));
}

export interface SessionClassTally {
  sessions: number;
  events: number;
}

export function tallyByClass(sessions: readonly Session[]): Record<SessionClass, SessionClassTally> {
  const tally: Record<SessionClass, SessionClassTally> = {
    interactive: { sessions: 0, events: 0 },
    automation: { sessions: 0, events: 0 },
    other: { sessions: 0, events: 0 },
  };
  for (const session of sessions) {
    const entry = tally[session.cls];
    entry.sessions += 1;
    entry.events += session.eventCount;
  }
  return tally;
}
