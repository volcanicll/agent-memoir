/**
 * Rhythm tests — streak/gap edge cases (single day, all-zero span) and the
 * hard requirement that zero days appear in the day series rather than being
 * omitted.
 */

import { describe, expect, test } from 'bun:test';
import { buildSessions } from '../src/analyze/session.ts';
import { computeRhythm, streakAndGap } from '../src/analyze/rhythm.ts';
import { enumerateDayKeys } from '../src/analyze/time.ts';
import { makeEvent, localTs } from './helpers.ts';

describe('streakAndGap', () => {
  test('a single-day span with activity is a one-day streak and no gap', () => {
    expect(streakAndGap([5])).toEqual({ streak: 1, gap: 0 });
  });

  test('an all-zero span has no streak and no gap', () => {
    expect(streakAndGap([0, 0, 0])).toEqual({ streak: 0, gap: 0 });
  });

  test('an empty series has neither', () => {
    expect(streakAndGap([])).toEqual({ streak: 0, gap: 0 });
  });

  test('counts the longest interior zero run as the gap', () => {
    //          day:  1  2  3  4  5  6  7
    const counts = [1, 0, 0, 1, 1, 0, 1];
    expect(streakAndGap(counts)).toEqual({ streak: 2, gap: 2 });
  });

  test('leading and trailing zeros are not gaps', () => {
    expect(streakAndGap([0, 0, 1, 1, 1, 0, 0])).toEqual({ streak: 3, gap: 0 });
  });
});

describe('enumerateDayKeys', () => {
  test('a single day yields one key', () => {
    expect(enumerateDayKeys(localTs(2026, 4, 10, 1), localTs(2026, 4, 10, 23))).toEqual(['2026-04-10']);
  });

  test('enumerates inclusively across a month boundary', () => {
    expect(enumerateDayKeys(localTs(2026, 4, 29, 1), localTs(2026, 5, 2, 1))).toEqual([
      '2026-04-29',
      '2026-04-30',
      '2026-05-01',
      '2026-05-02',
    ]);
  });

  test('an inverted range is empty', () => {
    expect(enumerateDayKeys(localTs(2026, 4, 10), localTs(2026, 4, 1))).toEqual([]);
  });
});

describe('computeRhythm', () => {
  test('quiet days appear as explicit zeros', () => {
    const events = [
      makeEvent({ sessionId: 's', ts: localTs(2026, 4, 10, 9), ordinal: 0, role: 'user', text: 'a', metaSource: 'telegram' }),
      makeEvent({ sessionId: 's', ts: localTs(2026, 4, 13, 9), ordinal: 1, role: 'user', text: 'b', metaSource: 'telegram' }),
    ];
    const sessions = buildSessions(events);
    const rhythm = computeRhythm(sessions, 'all', {
      startTs: localTs(2026, 4, 10, 9),
      endTs: localTs(2026, 4, 13, 9),
    });
    expect(rhythm.daySeries.map((point) => point.count)).toEqual([1, 0, 0, 1]);
    expect(rhythm.daySeries.map((point) => point.day)).toEqual([
      '2026-04-10',
      '2026-04-11',
      '2026-04-12',
      '2026-04-13',
    ]);
    expect(rhythm.longestStreakDays).toBe(1);
    expect(rhythm.longestGapDays).toBe(2);
    expect(rhythm.activeDays).toBe(2);
    expect(rhythm.spanDays).toBe(4);
  });

  test('the interactive filter excludes automation events from every series', () => {
    const events = [
      makeEvent({ sessionId: 'c', ts: localTs(2026, 4, 10, 9), ordinal: 0, role: 'user', text: 'a', metaSource: 'cron' }),
      makeEvent({ sessionId: 'c', ts: localTs(2026, 4, 10, 10), ordinal: 1, role: 'assistant', text: 'b', metaSource: 'cron' }),
      makeEvent({ sessionId: 't', ts: localTs(2026, 4, 10, 14), ordinal: 2, role: 'user', text: 'c', metaSource: 'telegram' }),
    ];
    const sessions = buildSessions(events);
    const span = { startTs: localTs(2026, 4, 10, 9), endTs: localTs(2026, 4, 10, 14) };
    const all = computeRhythm(sessions, 'all', span);
    const interactive = computeRhythm(sessions, 'interactive', span);
    expect(all.daySeries[0]?.count).toBe(3);
    expect(interactive.daySeries[0]?.count).toBe(1);
    expect(all.hourOfDay[9]).toBe(1);
    expect(all.hourOfDay[10]).toBe(1);
    expect(interactive.hourOfDay[9]).toBe(0);
    expect(interactive.hourOfDay[10]).toBe(0);
    expect(interactive.hourOfDay[14]).toBe(1);
  });

  test('session start and end hours bin by first and last event', () => {
    const events = [
      makeEvent({ sessionId: 's', ts: localTs(2026, 4, 10, 8), ordinal: 0, role: 'user', text: 'a', metaSource: 'cli' }),
      makeEvent({ sessionId: 's', ts: localTs(2026, 4, 10, 11), ordinal: 1, role: 'assistant', text: 'b', metaSource: 'cli' }),
    ];
    const rhythm = computeRhythm(buildSessions(events), 'all', {
      startTs: localTs(2026, 4, 10, 8),
      endTs: localTs(2026, 4, 10, 11),
    });
    expect(rhythm.sessionStartHours[8]).toBe(1);
    expect(rhythm.sessionEndHours[11]).toBe(1);
    expect(rhythm.peakHour).toEqual({ hour: 8, count: 1 });
  });

  test('an empty view over a non-empty span yields all zeros, not an empty series', () => {
    const rhythm = computeRhythm([], 'interactive', {
      startTs: localTs(2026, 4, 10, 0),
      endTs: localTs(2026, 4, 12, 0),
    });
    expect(rhythm.daySeries.map((point) => point.count)).toEqual([0, 0, 0]);
    expect(rhythm.longestStreakDays).toBe(0);
    expect(rhythm.busiestDay).toBeNull();
    expect(rhythm.peakHour).toBeNull();
  });
});
