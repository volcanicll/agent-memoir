/**
 * Cross-source comparison — three agents, three working styles, side by side.
 *
 * The unified store has always merged the sources into one stream; this module
 * is the first thing that looks at them as three separate subjects. Every row
 * is computed the same way for every source, so the columns are directly
 * comparable — that is the whole point. Two asymmetries are deliberately kept
 * VISIBLE rather than normalized away:
 *
 *   - Hermes rarely carries a cwd (measured: 3 of 2,898 sessions do), so its
 *     top-projects column is often empty where Claude Code's is full. That is
 *     a fact about the data, not an error to paper over.
 *   - `tool.ok` only exists on `tool_result` events, and Hermes records it far
 *     less often than Codex does (measured: 3,336 of 17,874 results vs 18,172
 *     of 19,817). The failure rate therefore reports its own denominator; a
 *     source with no resolved results reports null, never 0.
 *
 * `contrasts()` states what actually differs, and every contrast carries the
 * two numbers it was derived from — the renderer never has to parse prose and
 * the reader can check the arithmetic. Thresholds are declared as constants
 * with their reasons; a contrast below its threshold is not emitted at all.
 */

import { matchesClassFilter, type ClassFilter } from './classify.ts';
import { groupSessionsByRoot, UNLOCATED_PROJECT } from './projects.ts';
import { anonymizePath, redactHome } from './redact.ts';
import type { Session } from './session.ts';
import { median } from './stat.ts';
import { hourOfDay, localDayKey } from './time.ts';
import { topEntries } from './vocabulary.ts';

/**
 * Minimum tool calls in a source before its tool mix may be used in a
 * contrast. Below 50 calls one unusual session can own the whole
 * distribution, and the "dominant tool" claim becomes a claim about one
 * afternoon.
 */
export const MIN_CALLS_FOR_TOOL_MIX = 50;

/** Minimum events before reasoning share / hour profile claims are emitted. */
export const MIN_EVENTS_FOR_SHARE = 100;

/** Minimum sessions before median-length claims are emitted. */
export const MIN_SESSIONS_FOR_LENGTH = 5;

/** Minimum resolved tool results on BOTH sides of a failure-rate contrast. */
export const MIN_RESOLVED_FOR_FAILURE = 50;

/** Tool dominances must differ by at least this many points to be a contrast. */
export const TOOL_DOMINANCE_PP = 15;

/** Reasoning shares must differ by at least this many points. */
export const REASONING_PP = 10;

/** Failure rates must differ by at least this many points. */
export const FAILURE_PP = 2;

/** Median session lengths / events per session must differ by this ratio. */
export const LENGTH_RATIO = 1.5;

/**
 * Floor on a median session length for the length contrast. Hermes sessions
 * are overwhelmingly single-shot cron runs whose start and end fall in the
 * same minute, so a raw ratio against them divides by ~0 and produces claims
 * like "130,802×". A source whose median is under a minute is simply not
 * comparable on duration and the contrast is withheld.
 */
export const MIN_MEDIAN_MINUTES = 1;

/** Peak hours must differ by at least this many hours. */
export const PEAK_HOUR_DELTA = 2;

export interface ToolShare {
  readonly name: string;
  readonly count: number;
  /** Share of that source's tool_call events, 0..1. */
  readonly share: number;
}

export interface ProjectShare {
  /** Redacted project label, display-ready. */
  readonly label: string;
  readonly sessions: number;
  readonly events: number;
}

export interface SourceComparison {
  readonly source: string;
  readonly sessions: number;
  readonly events: number;
  /** Median session wall-clock length in minutes; null with no sessions. */
  readonly medianSessionMinutes: number | null;
  readonly eventsPerSession: number | null;
  /** Top tool names by call count with shares, deterministic order. */
  readonly toolMix: readonly ToolShare[];
  readonly toolCalls: number;
  /** Event counts per local hour of day, length 24. */
  readonly hourHistogram: readonly number[];
  readonly topProjects: readonly ProjectShare[];
  /** Distinct project roots this source's sessions folded into. */
  readonly locatedProjects: number;
  /** Sessions of this source with no recorded cwd. */
  readonly unlocatedSessions: number;
  /** kind === 'reasoning' over all events, 0..1. */
  readonly reasoningShare: number;
  /** tool.ok === false over tool.ok !== undefined; null when none resolved. */
  readonly failureRate: number | null;
  readonly failureCount: number;
  readonly resolvedCount: number;
  /** Session-class mix of this source inside the scope, for context. */
  readonly classMix: Readonly<Record<'interactive' | 'automation' | 'other', number>>;
}

export interface Comparison {
  readonly cls: ClassFilter;
  readonly sources: readonly SourceComparison[];
}

export interface CompareOptions {
  /** Top-N tool mix carried per source. */
  readonly topTools?: number;
  /** Top-N projects carried per source. */
  readonly topProjects?: number;
}

const COMPARE_DEFAULTS = { topTools: 5, topProjects: 3 } as const;

function sessionsOf(sessions: readonly Session[], filter: ClassFilter): Session[] {
  return sessions.filter((session) => matchesClassFilter(session.cls, filter));
}

function buildOne(
  source: string,
  group: readonly Session[],
  options: Required<CompareOptions>,
): SourceComparison {
  const events = group.flatMap((session) => session.events);
  const toolCounts = new Map<string, number>();
  const hours = new Array<number>(24).fill(0);
  let reasoning = 0;
  let failures = 0;
  let resolved = 0;

  for (const event of events) {
    const hour = hourOfDay(event.ts);
    hours[hour] = (hours[hour] ?? 0) + 1;
    if (event.kind === 'reasoning') reasoning += 1;
    if (event.kind === 'tool_call' && event.tool !== undefined && event.tool.name.length > 0) {
      toolCounts.set(event.tool.name, (toolCounts.get(event.tool.name) ?? 0) + 1);
    }
    if (event.tool?.ok !== undefined) {
      resolved += 1;
      if (event.tool.ok === false) failures += 1;
    }
  }

  const toolCalls = [...toolCounts.values()].reduce((total, count) => total + count, 0);
  const toolMix = topEntries(toolCounts, options.topTools).map(([name, count]) => ({
    name,
    count,
    share: toolCalls === 0 ? 0 : count / toolCalls,
  }));

  // Project labelling follows the projects section exactly (same folding,
  // same redaction) so the two chapters never disagree about what a project
  // is. Sessions without a cwd are their own bucket, as everywhere else.
  const byRoot = groupSessionsByRoot(group);
  const projectRows: ProjectShare[] = [];
  let unlocated = 0;
  for (const session of group) if (session.cwd === undefined) unlocated += 1;
  for (const [root, sessionsOfRoot] of byRoot) {
    projectRows.push({
      label: anonymizePath(redactHome(root)),
      sessions: sessionsOfRoot.length,
      events: sessionsOfRoot.reduce((total, session) => total + session.eventCount, 0),
    });
  }
  if (unlocated > 0) {
    const unlocatedSessions = group.filter((session) => session.cwd === undefined);
    projectRows.push({
      label: UNLOCATED_PROJECT,
      sessions: unlocatedSessions.length,
      events: unlocatedSessions.reduce((total, session) => total + session.eventCount, 0),
    });
  }
  projectRows.sort((a, b) => b.sessions - a.sessions || a.label.localeCompare(b.label));

  const classMix = { interactive: 0, automation: 0, other: 0 };
  for (const session of group) classMix[session.cls] += 1;

  const located = byRoot.size;
  return {
    source,
    sessions: group.length,
    events: events.length,
    medianSessionMinutes: group.length === 0 ? null : median(group.map((s) => (s.endTs - s.startTs) / 60_000)),
    eventsPerSession: group.length === 0 ? null : events.length / group.length,
    toolMix,
    toolCalls,
    hourHistogram: hours,
    topProjects: projectRows.slice(0, options.topProjects),
    locatedProjects: located,
    unlocatedSessions: unlocated,
    reasoningShare: events.length === 0 ? 0 : reasoning / events.length,
    failureRate: resolved === 0 ? null : failures / resolved,
    failureCount: failures,
    resolvedCount: resolved,
    classMix,
  };
}

/** One comparison row per source present in the scope, most sessions first. */
export function computeCompare(
  sessions: readonly Session[],
  filter: ClassFilter = 'all',
  options: CompareOptions = {},
): Comparison {
  const resolvedOptions: Required<CompareOptions> = {
    topTools: options.topTools ?? COMPARE_DEFAULTS.topTools,
    topProjects: options.topProjects ?? COMPARE_DEFAULTS.topProjects,
  };
  const selected = sessionsOf(sessions, filter);
  const groups = new Map<string, Session[]>();
  for (const session of selected) {
    const list = groups.get(session.source);
    if (list === undefined) groups.set(session.source, [session]);
    else list.push(session);
  }
  const sources = [...groups.entries()]
    .map(([source, group]) => buildOne(source, group, resolvedOptions))
    .sort((a, b) => b.sessions - a.sessions || a.source.localeCompare(b.source));
  return { cls: filter, sources };
}

// ------------------------------------------------------------------ contrasts

export type ContrastKey =
  | 'top_tool_dominance'
  | 'reasoning_share'
  | 'tool_failure_rate'
  | 'session_length'
  | 'events_per_session'
  | 'peak_hour';

export interface Contrast {
  /** Stable identifier so the gate and renderer can key on it. */
  readonly key: ContrastKey;
  /** One computed sentence; contains numbers, names, no prose invention. */
  readonly statement: string;
  /** Which source the first (higher) value belongs to. */
  readonly sourceA: string;
  readonly valueA: number;
  readonly labelA: string;
  readonly sourceB: string;
  readonly valueB: number;
  readonly labelB: string;
  /** How the values are expressed when formatted. */
  readonly unit: 'share' | 'minutes' | 'per_session' | 'hour';
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function pickExtremes<T>(
  rows: readonly T[],
  valueOf: (row: T) => number | null,
  eligible: (row: T) => boolean,
): { high: T; low: T } | null {
  const candidates = rows.filter((row) => eligible(row) && valueOf(row) !== null);
  if (candidates.length < 2) return null;
  let high = candidates[0] as T;
  let low = candidates[0] as T;
  for (const row of candidates) {
    const value = valueOf(row) as number;
    if (value > (valueOf(high) as number)) high = row;
    if (value < (valueOf(low) as number)) low = row;
  }
  return high === low ? null : { high, low };
}

function peakHourOf(row: SourceComparison): number | null {
  let best = -1;
  let bestCount = 0;
  for (let hour = 0; hour < row.hourHistogram.length; hour++) {
    const count = row.hourHistogram[hour] ?? 0;
    if (count > bestCount) {
      bestCount = count;
      best = hour;
    }
  }
  return bestCount === 0 ? null : best;
}

function hourLabel(hour: number): string {
  return `${hour < 10 ? '0' : ''}${hour}:00`;
}

/**
 * What actually differs between the sources, computed from the table above.
 *
 * Emission order is fixed (tool dominance, reasoning, failure, session length,
 * events per session, peak hour) so output is deterministic; each family only
 * speaks when its threshold constant is cleared, and each single contrast
 * requires a second eligible source to compare against.
 */
export function contrasts(comparison: Comparison): Contrast[] {
  const rows = comparison.sources;
  const found: Contrast[] = [];

  const tools = pickExtremes(
    rows,
    (row) => row.toolMix[0]?.share ?? null,
    (row) => row.toolCalls >= MIN_CALLS_FOR_TOOL_MIX,
  );
  if (tools !== null) {
    const shareA = tools.high.toolMix[0]?.share ?? 0;
    const shareB = tools.low.toolMix[0]?.share ?? 0;
    if ((shareA - shareB) * 100 >= TOOL_DOMINANCE_PP) {
      const topA = tools.high.toolMix[0];
      const topB = tools.low.toolMix[0];
      if (topA !== undefined && topB !== undefined) {
        found.push({
          key: 'top_tool_dominance',
          statement:
            `${tools.high.source} puts ${pct(topA.share)} of its ${tools.high.toolCalls.toLocaleString('en-US')} ` +
            `tool calls into one tool (${topA.name}); ${tools.low.source}'s most-used tool is ${topB.name} at ` +
            `${pct(topB.share)} of ${tools.low.toolCalls.toLocaleString('en-US')}.`,
          sourceA: tools.high.source,
          valueA: topA.share,
          labelA: topA.name,
          sourceB: tools.low.source,
          valueB: topB.share,
          labelB: topB.name,
          unit: 'share',
        });
      }
    }
  }

  const reasoning = pickExtremes(
    rows,
    (row) => row.reasoningShare,
    (row) => row.events >= MIN_EVENTS_FOR_SHARE,
  );
  if (reasoning !== null && (reasoning.high.reasoningShare - reasoning.low.reasoningShare) * 100 >= REASONING_PP) {
    found.push({
      key: 'reasoning_share',
      statement:
        `${pct(reasoning.high.reasoningShare)} of ${reasoning.high.source}'s events are model reasoning, against ` +
        `${pct(reasoning.low.reasoningShare)} for ${reasoning.low.source}.`,
      sourceA: reasoning.high.source,
      valueA: reasoning.high.reasoningShare,
      labelA: 'reasoning share',
      sourceB: reasoning.low.source,
      valueB: reasoning.low.reasoningShare,
      labelB: 'reasoning share',
      unit: 'share',
    });
  }

  const failure = pickExtremes(
    rows,
    (row) => row.failureRate,
    (row) => row.resolvedCount >= MIN_RESOLVED_FOR_FAILURE,
  );
  if (failure !== null) {
    const rateA = failure.high.failureRate as number;
    const rateB = failure.low.failureRate as number;
    if ((rateA - rateB) * 100 >= FAILURE_PP) {
      found.push({
        key: 'tool_failure_rate',
        statement:
          `${pct(rateA)} of ${failure.high.source}'s ${failure.high.resolvedCount.toLocaleString('en-US')} resolved ` +
          `tool results report failure, against ${pct(rateB)} of ${failure.low.resolvedCount.toLocaleString('en-US')} ` +
          `for ${failure.low.source}.`,
        sourceA: failure.high.source,
        valueA: rateA,
        labelA: 'failure rate',
        sourceB: failure.low.source,
        valueB: rateB,
        labelB: 'failure rate',
        unit: 'share',
      });
    }
  }

  const length = pickExtremes(
    rows,
    (row) => row.medianSessionMinutes,
    (row) =>
      row.sessions >= MIN_SESSIONS_FOR_LENGTH && (row.medianSessionMinutes ?? 0) >= MIN_MEDIAN_MINUTES,
  );
  if (length !== null) {
    const minutesA = length.high.medianSessionMinutes as number;
    const minutesB = length.low.medianSessionMinutes as number;
    if (minutesB > 0 && minutesA / minutesB >= LENGTH_RATIO) {
      found.push({
        key: 'session_length',
        statement:
          `A median ${length.high.source} session runs ${minutesA.toFixed(0)} minutes — ` +
          `${(minutesA / minutesB).toFixed(1)}× the median ${length.low.source} session (${minutesB.toFixed(0)} minutes).`,
        sourceA: length.high.source,
        valueA: minutesA,
        labelA: 'median session minutes',
        sourceB: length.low.source,
        valueB: minutesB,
        labelB: 'median session minutes',
        unit: 'minutes',
      });
    }
  }

  const perSession = pickExtremes(
    rows,
    (row) => row.eventsPerSession,
    (row) => row.sessions >= MIN_SESSIONS_FOR_LENGTH && (row.eventsPerSession ?? 0) > 0,
  );
  if (perSession !== null) {
    const eventsA = perSession.high.eventsPerSession as number;
    const eventsB = perSession.low.eventsPerSession as number;
    if (eventsB > 0 && eventsA / eventsB >= LENGTH_RATIO) {
      found.push({
        key: 'events_per_session',
        statement:
          `${perSession.high.source} records ${eventsA.toFixed(0)} events per session where ` +
          `${perSession.low.source} records ${eventsB.toFixed(0)}.`,
        sourceA: perSession.high.source,
        valueA: eventsA,
        labelA: 'events per session',
        sourceB: perSession.low.source,
        valueB: eventsB,
        labelB: 'events per session',
        unit: 'per_session',
      });
    }
  }

  let peakHour: { row: SourceComparison; hour: number } | null = null;
  let quietHour: { row: SourceComparison; hour: number } | null = null;
  for (const row of rows) {
    if (row.events < MIN_EVENTS_FOR_SHARE) continue;
    const hour = peakHourOf(row);
    if (hour === null) continue;
    if (peakHour === null || hour > peakHour.hour) peakHour = { row, hour };
    if (quietHour === null || hour < quietHour.hour) quietHour = { row, hour };
  }
  if (peakHour !== null && quietHour !== null && peakHour.hour - quietHour.hour >= PEAK_HOUR_DELTA) {
    found.push({
      key: 'peak_hour',
      statement:
        `${peakHour.row.source} peaks at ${hourLabel(peakHour.hour)} local where ${quietHour.row.source} peaks at ` +
        `${hourLabel(quietHour.hour)}.`,
      sourceA: peakHour.row.source,
      valueA: peakHour.hour,
      labelA: 'peak hour',
      sourceB: quietHour.row.source,
      valueB: quietHour.hour,
      labelB: 'peak hour',
      unit: 'hour',
    });
  }

  return found;
}

/** Distinct active days per source — a compact "how spread out" signal. */
export function activeDaysBySource(sessions: readonly Session[], filter: ClassFilter = 'all'): Map<string, number> {
  const days = new Map<string, Set<string>>();
  for (const session of sessionsOf(sessions, filter)) {
    const set = days.get(session.source) ?? new Set<string>();
    for (const event of session.events) set.add(localDayKey(event.ts));
    days.set(session.source, set);
  }
  return new Map([...days.entries()].map(([source, set]) => [source, set.size]));
}
