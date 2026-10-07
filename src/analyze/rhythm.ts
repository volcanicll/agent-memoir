/**
 * Rhythm — the *when* of the portrait.
 *
 * Every series is computed from local time (see time.ts) and over a span that
 * is fixed by the caller, so the same span is used for every class view: the
 * interactive and automation series are directly comparable and a quiet day
 * is a zero in both, not a missing index.
 *
 * Zero days are first-class. A gap month collapses the shape of a working
 * life — the point of the daily series is that quiet periods are visible, so
 * days with no events are emitted as count 0 rather than omitted.
 *
 * Note what is NOT counted here: `hourOfDay` and the daily series count
 * EVENTS, while `sessionStartHours` counts SESSIONS by their first event.
 * Both are useful and they answer different questions ("when is work
 * happening" vs "when does work begin"), so they stay separate fields.
 */

import type { Event } from '../core/event.ts';
import { matchesClassFilter, type ClassFilter } from './classify.ts';
import type { Session } from './session.ts';
import { argMax } from './stat.ts';
import {
  dayOfWeekMondayFirst,
  enumerateDayKeys,
  hourOfDay,
  localDayKey,
} from './time.ts';

export const HOURS_PER_DAY = 24;
export const DAYS_PER_WEEK = 7;
/** Monday-first labels, aligned with dayOfWeekMondayFirst(). */
export const WEEKDAY_LABELS: readonly string[] = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export interface DayPoint {
  readonly day: string;
  readonly count: number;
}

export interface Rhythm {
  /** Event counts per local hour of day, length 24. */
  readonly hourOfDay: readonly number[];
  /** Event counts per weekday (0 = Monday), length 7. */
  readonly dayOfWeek: readonly number[];
  /** Event counts per weekday × hour, 7 rows of 24. */
  readonly hourOfWeek: ReadonlyArray<readonly number[]>;
  /** Sessions binned by the local hour their first event happened. */
  readonly sessionStartHours: readonly number[];
  /** Sessions binned by the local hour their last event happened. */
  readonly sessionEndHours: readonly number[];
  readonly activeDays: number;
  readonly spanDays: number;
  readonly longestStreakDays: number;
  readonly longestGapDays: number;
  /** One entry per day of the span, in order, zeros included. */
  readonly daySeries: readonly DayPoint[];
  readonly busiestDay: DayPoint | null;
  readonly peakHour: { hour: number; count: number } | null;
}

export interface TimeSpan {
  readonly startTs: number;
  readonly endTs: number;
}

/**
 * Longest run of non-zero days and longest run of zero days strictly between
 * the first and last active day.
 *
 * Leading and trailing zeros are not gaps: the span is fixed by the caller
 * (the whole corpus), so a filter that selects nothing at the edges should
 * not manufacture a "gap" out of the corpus simply starting later. An empty
 * or all-zero input has neither activity nor gaps and returns 0/0 — no data
 * is not a stretch of silence.
 */
export function streakAndGap(dayCounts: readonly number[]): { streak: number; gap: number } {
  let streak = 0;
  let gap = 0;
  let currentStreak = 0;
  let currentGap = 0;
  let seenActive = false;
  let lastActive = -1;
  for (let i = 0; i < dayCounts.length; i++) {
    if ((dayCounts[i] ?? 0) > 0) lastActive = i;
  }
  if (lastActive < 0) return { streak: 0, gap: 0 };
  let firstActive = 0;
  for (let i = 0; i < dayCounts.length; i++) {
    if ((dayCounts[i] ?? 0) > 0) {
      firstActive = i;
      break;
    }
  }
  for (let i = firstActive; i <= lastActive; i++) {
    if ((dayCounts[i] ?? 0) > 0) {
      currentStreak += 1;
      currentGap = 0;
      seenActive = true;
      if (currentStreak > streak) streak = currentStreak;
    } else {
      currentGap += 1;
      currentStreak = 0;
      if (seenActive && currentGap > gap) gap = currentGap;
    }
  }
  return { streak, gap };
}

function indexedBump(target: number[], index: number, by = 1): void {
  target[index] = (target[index] ?? 0) + by;
}

function eventsOf(sessions: readonly Session[], filter: ClassFilter): Event[] {
  const events: Event[] = [];
  for (const session of sessions) {
    if (!matchesClassFilter(session.cls, filter)) continue;
    for (const event of session.events) events.push(event);
  }
  return events;
}

/**
 * Compute one class view of the rhythm. `span` is required and is normally
 * the span of the WHOLE corpus (all classes), so every view shares one
 * timeline and zero days line up across views.
 */
export function computeRhythm(sessions: readonly Session[], filter: ClassFilter, span: TimeSpan): Rhythm {
  const hourOfDay_ = new Array<number>(HOURS_PER_DAY).fill(0);
  const dayOfWeek_ = new Array<number>(DAYS_PER_WEEK).fill(0);
  const hourOfWeek_ = Array.from({ length: DAYS_PER_WEEK }, () => new Array<number>(HOURS_PER_DAY).fill(0));
  const sessionStartHours_ = new Array<number>(HOURS_PER_DAY).fill(0);
  const sessionEndHours_ = new Array<number>(HOURS_PER_DAY).fill(0);

  for (const session of sessions) {
    if (!matchesClassFilter(session.cls, filter)) continue;
    indexedBump(sessionStartHours_, hourOfDay(session.startTs));
    indexedBump(sessionEndHours_, hourOfDay(session.endTs));
  }

  const dayKeys = enumerateDayKeys(span.startTs, span.endTs);
  const dayIndex = new Map<string, number>();
  dayKeys.forEach((key, index) => dayIndex.set(key, index));
  const dayCounts = new Array<number>(dayKeys.length).fill(0);

  for (const event of eventsOf(sessions, filter)) {
    const hour = hourOfDay(event.ts);
    const weekday = dayOfWeekMondayFirst(event.ts);
    indexedBump(hourOfDay_, hour);
    indexedBump(dayOfWeek_, weekday);
    const row = hourOfWeek_[weekday];
    if (row !== undefined) indexedBump(row, hour);
    const index = dayIndex.get(localDayKey(event.ts));
    if (index !== undefined) indexedBump(dayCounts, index);
  }

  const daySeries: DayPoint[] = dayKeys.map((day, index) => ({ day, count: dayCounts[index] ?? 0 }));
  const { streak, gap } = streakAndGap(dayCounts);
  const busiestIndex = argMax(dayCounts);
  const peakIndex = argMax(hourOfDay_);
  const activeDays = dayCounts.reduce((total, count) => (count > 0 ? total + 1 : total), 0);
  const busiestCount = busiestIndex < 0 ? 0 : dayCounts[busiestIndex] ?? 0;
  const peakCount = peakIndex < 0 ? 0 : hourOfDay_[peakIndex] ?? 0;

  return {
    hourOfDay: hourOfDay_,
    dayOfWeek: dayOfWeek_,
    hourOfWeek: hourOfWeek_,
    sessionStartHours: sessionStartHours_,
    sessionEndHours: sessionEndHours_,
    activeDays,
    spanDays: dayKeys.length,
    longestStreakDays: streak,
    longestGapDays: gap,
    daySeries,
    busiestDay: busiestCount > 0 ? { day: dayKeys[busiestIndex] ?? '', count: busiestCount } : null,
    peakHour: peakCount > 0 ? { hour: peakIndex, count: peakCount } : null,
  };
}
