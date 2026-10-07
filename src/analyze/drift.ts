/**
 * Drift — the *change* between the first and second half of the span.
 *
 * The split is at the MEDIAN EVENT TIMESTAMP of the filtered stream, not at
 * the midpoint of the wall-clock span: activity bunches, and halving a span
 * would compare a busy stretch against an empty one and call ordinary
 * concentration "drift". Splitting on the median gives both windows equal
 * event mass and isolates what actually moved.
 *
 * Thresholds. Every comparison needs one; each is declared here with its
 * reason, and `moved()`/the guards below are the only place they are applied.
 *
 *   - MIN_EVENTS_PER_HALF = 200. Below this a single unusual session can
 *     swing any share by tens of points, so the report says "not enough
 *     data" and reports nothing rather than noise.
 *   - SHARE_DELTA_PP = 5. A project's share must move 5 percentage points;
 *     smaller moves are inside the variation of ordinary weeks.
 *   - SHARE_RELATIVE = 0.25. The 5-point move must also be >= 25% relative,
 *     which keeps a 5-point move on a 90% share (noise) from competing with
 *     a 5-point move on a 15% share (a real change of focus).
 *   - TERM_RANK_DELTA = 10. A term's rank must move 10 places; below rank
 *     10 frequencies are nearly tied and shuffle constantly.
 *   - TOOL_MIX_PP = 2. Tool shares are concentrated, so a 2-point move is a
 *     real change of habit.
 *   - LENGTH_PCT = 0.15. Median session length must move 15% before it is
 *     called; sessions normally vary by minutes either way.
 *   - HOUR_PP = 3. An hour's share of events must move 3 points; the hourly
 *     profile is the noisiest series, so it gets the tightest bar.
 */

import type { Event } from '../core/event.ts';
import { matchesClassFilter, type ClassFilter } from './classify.ts';
import { groupSessionsByRoot, UNLOCATED_PROJECT } from './projects.ts';
import { redactHome } from './redact.ts';
import type { Session } from './session.ts';
import { median } from './stat.ts';
import { hourOfDay } from './time.ts';
import { termsOfEvent } from './tokenize.ts';
import { topEntries } from './vocabulary.ts';

export const MIN_EVENTS_PER_HALF = 200;
export const SHARE_DELTA_PP = 5;
export const SHARE_RELATIVE = 0.25;
export const TERM_RANK_DELTA = 10;
export const TOOL_MIX_PP = 2;
export const LENGTH_PCT = 0.15;
export const HOUR_PP = 3;

export interface ShareMove {
  readonly label: string;
  readonly before: number;
  readonly after: number;
  /** Signed percentage-point change, after - before. */
  readonly deltaPp: number;
}

export interface TermMove {
  readonly term: string;
  readonly beforeRank: number | null;
  readonly afterRank: number | null;
  readonly beforeCount: number;
  readonly afterCount: number;
  readonly direction: 'rising' | 'falling' | 'new' | 'gone';
}

export interface HourMove {
  readonly hour: number;
  readonly before: number;
  readonly after: number;
  readonly deltaPp: number;
}

export interface Drift {
  readonly fromTs: number;
  readonly toTs: number;
  readonly splitTs: number;
  readonly splitLabel: string;
  readonly eventsBefore: number;
  readonly eventsAfter: number;
  readonly enoughData: boolean;
  /** Human-readable statement of what was compared (or why not). */
  readonly reason: string;
  /** How many terms were ranked; a rank of depth+1 means 'outside the top N'. */
  readonly termDepth: number;
  readonly projectMoves: readonly ShareMove[];
  readonly risingTerms: readonly TermMove[];
  readonly fallingTerms: readonly TermMove[];
  readonly toolMoves: readonly ShareMove[];
  readonly medianSessionMinutes: { readonly before: number | null; readonly after: number | null; readonly deltaPct: number | null };
  readonly hourMoves: readonly HourMove[];
}

/** Median event timestamp — the split both drift and the timeline draw at. */
export function driftSplitTs(events: readonly Event[]): number | null {
  if (events.length === 0) return null;
  const sorted = events.map((event) => event.ts).sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? null;
}

function share(counts: ReadonlyMap<string, number>): Map<string, number> {
  let total = 0;
  for (const value of counts.values()) total += value;
  const out = new Map<string, number>();
  if (total === 0) return out;
  for (const [key, value] of counts) out.set(key, value / total);
  return out;
}

function countBy<T>(values: readonly T[], keyOf: (value: T) => string | undefined): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    const key = keyOf(value);
    if (key === undefined) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function countTerms(events: readonly Event[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const event of events) {
    for (const [term, count] of termsOfEvent(event)) counts.set(term, (counts.get(term) ?? 0) + count);
  }
  return counts;
}

/** Rank of each term among the top `n`, 1-based. */
function rankMap(counts: ReadonlyMap<string, number>, n: number): Map<string, number> {
  const map = new Map<string, number>();
  topEntries(counts, n).forEach(([term], index) => map.set(term, index + 1));
  return map;
}

function isRealMove(beforeShare: number, afterShare: number, minPp: number): boolean {
  const deltaPp = (afterShare - beforeShare) * 100;
  if (Math.abs(deltaPp) < minPp) return false;
  const base = Math.max(beforeShare, afterShare);
  return base === 0 || Math.abs(afterShare - beforeShare) / base >= SHARE_RELATIVE;
}

function projectMovesOf(beforeEvents: readonly Event[], afterEvents: readonly Event[], sessions: readonly Session[]): ShareMove[] {
  // Same root derivation as the projects section, so the two sections agree
  // about what a project is.
  const rootMap = new Map<string, string>();
  for (const [root, group] of groupSessionsByRoot(sessions.filter((session) => session.cwd !== undefined))) {
    for (const session of group) if (session.cwd !== undefined) rootMap.set(session.cwd, root);
  }
  const keyOf = (event: Event): string | undefined => {
    const cwd = event.refs?.cwd;
    if (cwd === undefined) return UNLOCATED_PROJECT;
    return redactHome(rootMap.get(cwd) ?? cwd);
  };
  const before = share(countBy(beforeEvents, keyOf));
  const after = share(countBy(afterEvents, keyOf));
  const moves: ShareMove[] = [];
  for (const label of new Set([...before.keys(), ...after.keys()])) {
    const beforeShare = before.get(label) ?? 0;
    const afterShare = after.get(label) ?? 0;
    if (isRealMove(beforeShare, afterShare, SHARE_DELTA_PP)) {
      moves.push({ label, before: beforeShare, after: afterShare, deltaPp: (afterShare - beforeShare) * 100 });
    }
  }
  return moves.sort((a, b) => Math.abs(b.deltaPp) - Math.abs(a.deltaPp));
}

/**
 * A term entering or leaving the language must clear this many occurrences to
 * be reported as 'new'/'gone'. Without a floor, every term mentioned once in
 * the second half claims to be "new" and buries the real arrivals.
 */
export const TERM_ENTRY_MIN_COUNT = 5;

function termMovesOf(beforeEvents: readonly Event[], afterEvents: readonly Event[], topN: number): { rising: TermMove[]; falling: TermMove[] } {
  const beforeCounts = countTerms(beforeEvents);
  const afterCounts = countTerms(afterEvents);
  const beforeRanks = rankMap(beforeCounts, topN);
  const afterRanks = rankMap(afterCounts, topN);
  const arriving: TermMove[] = [];
  const departing: TermMove[] = [];
  const rising: TermMove[] = [];
  const falling: TermMove[] = [];

  for (const term of new Set([...beforeCounts.keys(), ...afterCounts.keys()])) {
    const beforeCount = beforeCounts.get(term) ?? 0;
    const afterCount = afterCounts.get(term) ?? 0;
    const beforeRank = beforeRanks.get(term);
    const afterRank = afterRanks.get(term);

    // Arrivals/departures are claims about the language, so they additionally
    // require prominence: a term must be in the ranked region of the half it
    // appears in, not merely present.
    if (beforeCount === 0 && afterCount >= TERM_ENTRY_MIN_COUNT && afterRank !== undefined) {
      arriving.push({ term, beforeRank: null, afterRank, beforeCount, afterCount, direction: 'new' });
      continue;
    }
    if (afterCount === 0 && beforeCount >= TERM_ENTRY_MIN_COUNT && beforeRank !== undefined) {
      departing.push({ term, beforeRank, afterRank: null, beforeCount, afterCount, direction: 'gone' });
      continue;
    }
    if (beforeCount === 0 || afterCount === 0) continue;

    // Present in both halves: compare effective ranks, treating anything
    // outside the top-N as rank N+1 so a real slide past the depth is still
    // measurable rather than reported as absence.
    const effectiveBefore = beforeRank ?? topN + 1;
    const effectiveAfter = afterRank ?? topN + 1;
    if (effectiveBefore - effectiveAfter >= TERM_RANK_DELTA) {
      rising.push({ term, beforeRank: effectiveBefore, afterRank: effectiveAfter, beforeCount, afterCount, direction: 'rising' });
    } else if (effectiveAfter - effectiveBefore >= TERM_RANK_DELTA) {
      falling.push({ term, beforeRank: effectiveBefore, afterRank: effectiveAfter, beforeCount, afterCount, direction: 'falling' });
    }
  }

  const climb = (move: TermMove): number => (move.beforeRank ?? topN + 1) - (move.afterRank ?? topN + 1);
  // Arrivals first (strongest signal, ordered by how prominent they are),
  // then genuine rank climbs ordered by size of the climb.
  arriving.sort((a, b) => (a.afterRank ?? topN) - (b.afterRank ?? topN) || b.afterCount - a.afterCount);
  rising.sort((a, b) => climb(b) - climb(a) || b.afterCount - a.afterCount);
  departing.sort((a, b) => (a.beforeRank ?? topN) - (b.beforeRank ?? topN) || b.beforeCount - a.beforeCount);
  falling.sort((a, b) => climb(a) - climb(b) || b.beforeCount - a.beforeCount);
  return { rising: [...arriving, ...rising], falling: [...departing, ...falling] };
}

function toolMovesOf(beforeEvents: readonly Event[], afterEvents: readonly Event[]): ShareMove[] {
  // Only tool_call events, matching the vocabulary section: tool_result
  // events carry a tool name too, but adapters that cannot resolve it label
  // them 'unknown' (Claude Code's tool_result channel does), and counting
  // those would put an adapter artifact in the tool-mix report.
  const calls = (events: readonly Event[]): Event[] =>
    events.filter((event) => event.kind === 'tool_call' && event.tool !== undefined);
  const before = share(countBy(calls(beforeEvents), (event) => event.tool?.name));
  const after = share(countBy(calls(afterEvents), (event) => event.tool?.name));
  const moves: ShareMove[] = [];
  for (const name of new Set([...before.keys(), ...after.keys()])) {
    const beforeShare = before.get(name) ?? 0;
    const afterShare = after.get(name) ?? 0;
    const deltaPp = (afterShare - beforeShare) * 100;
    // Tool shares move more freely than projects, so this bar is absolute
    // only — the relative guard would suppress changes on small tools.
    if (Math.abs(deltaPp) >= TOOL_MIX_PP) {
      moves.push({ label: name, before: beforeShare, after: afterShare, deltaPp });
    }
  }
  return moves.sort((a, b) => Math.abs(b.deltaPp) - Math.abs(a.deltaPp));
}

function hourMovesOf(beforeEvents: readonly Event[], afterEvents: readonly Event[]): HourMove[] {
  const countsOf = (events: readonly Event[]): number[] => {
    const counts = new Array<number>(24).fill(0);
    for (const event of events) counts[hourOfDay(event.ts)] = (counts[hourOfDay(event.ts)] ?? 0) + 1;
    return counts;
  };
  const beforeCounts = countsOf(beforeEvents);
  const afterCounts = countsOf(afterEvents);
  const beforeTotal = beforeCounts.reduce((total, count) => total + count, 0);
  const afterTotal = afterCounts.reduce((total, count) => total + count, 0);
  const moves: HourMove[] = [];
  for (let hour = 0; hour < 24; hour++) {
    const beforeShare = beforeTotal === 0 ? 0 : (beforeCounts[hour] ?? 0) / beforeTotal;
    const afterShare = afterTotal === 0 ? 0 : (afterCounts[hour] ?? 0) / afterTotal;
    const deltaPp = (afterShare - beforeShare) * 100;
    if (Math.abs(deltaPp) >= HOUR_PP) moves.push({ hour, before: beforeShare, after: afterShare, deltaPp });
  }
  return moves.sort((a, b) => Math.abs(b.deltaPp) - Math.abs(a.deltaPp));
}

function medianSessionMinutes(sessions: readonly Session[]): number | null {
  return median(sessions.map((session) => (session.endTs - session.startTs) / 60_000));
}

export interface DriftOptions {
  /** How many terms to rank before measuring rank movement. */
  readonly termDepth: number;
  /** Cap on rising/falling term entries carried into the Portrait. */
  readonly termLimit: number;
}

export const DRIFT_DEFAULTS: DriftOptions = { termDepth: 200, termLimit: 12 };

export function computeDrift(sessions: readonly Session[], filter: ClassFilter, options: DriftOptions = DRIFT_DEFAULTS): Drift | null {
  const selected = sessions.filter((session) => matchesClassFilter(session.cls, filter));
  const events: Event[] = [];
  for (const session of selected) for (const event of session.events) events.push(event);
  if (events.length === 0) return null;

  const timeSorted = [...events].sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const splitIndex = Math.floor(timeSorted.length / 2);
  const splitTs = timeSorted[splitIndex]?.ts;
  if (splitTs === undefined) return null;

  const beforeEvents = timeSorted.slice(0, splitIndex);
  const afterEvents = timeSorted.slice(splitIndex);
  // Sessions join the half their START falls in — a session is one act, and
  // cutting it in half would double-count it in the length statistics.
  const beforeSessions = selected.filter((session) => session.startTs <= splitTs);
  const afterSessions = selected.filter((session) => session.startTs > splitTs);

  const base = {
    fromTs: timeSorted[0]?.ts ?? 0,
    toTs: timeSorted[timeSorted.length - 1]?.ts ?? 0,
    splitTs,
    splitLabel: new Date(splitTs).toISOString().slice(0, 10),
    eventsBefore: beforeEvents.length,
    eventsAfter: afterEvents.length,
  };

  if (beforeEvents.length < MIN_EVENTS_PER_HALF || afterEvents.length < MIN_EVENTS_PER_HALF) {
    return {
      ...base,
      enoughData: false,
      reason: `halves hold ${beforeEvents.length}/${afterEvents.length} events — ${MIN_EVENTS_PER_HALF} per half required`,
      termDepth: options.termDepth,
      projectMoves: [],
      risingTerms: [],
      fallingTerms: [],
      toolMoves: [],
      medianSessionMinutes: { before: null, after: null, deltaPct: null },
      hourMoves: [],
    };
  }

  const beforeMedian = medianSessionMinutes(beforeSessions);
  const afterMedian = medianSessionMinutes(afterSessions);
  const deltaPct = beforeMedian === null || afterMedian === null || beforeMedian === 0 ? null : (afterMedian - beforeMedian) / beforeMedian;
  const termMoves = termMovesOf(beforeEvents, afterEvents, options.termDepth);

  return {
    ...base,
    enoughData: true,
    reason: `comparing the halves either side of the median event (${base.splitLabel})`,
    termDepth: options.termDepth,
    projectMoves: projectMovesOf(beforeEvents, afterEvents, selected),
    risingTerms: termMoves.rising.slice(0, options.termLimit),
    fallingTerms: termMoves.falling.slice(0, options.termLimit),
    toolMoves: toolMovesOf(beforeEvents, afterEvents).slice(0, 8),
    medianSessionMinutes: { before: beforeMedian, after: afterMedian, deltaPct },
    // Only report an hourly move when it is also a real move for the hour.
    hourMoves: hourMovesOf(beforeEvents, afterEvents).slice(0, 6),
  };
}
