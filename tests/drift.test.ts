/**
 * Drift tests — the threshold is the whole point of the module, so each test
 * pins a REAL move and a sub-threshold move on both sides of the bar.
 */

import { describe, expect, test } from 'bun:test';
import { computeDrift, SHARE_DELTA_PP, TERM_RANK_DELTA, TOOL_MIX_PP } from '../src/analyze/drift.ts';
import { buildSessions } from '../src/analyze/session.ts';
import { redactHome } from '../src/analyze/redact.ts';
import { makeEvent, localTs } from './helpers.ts';
import type { Event } from '../src/core/event.ts';

const DAY = 86_400_000;

/** One event per call, alternating between two projects over `days` days. */
function syntheticProjectStream(options: {
  days: number;
  beforeProjectA: number; // share of events to project A in the first half
  afterProjectA: number;
  startTs: number;
}): Event[] {
  const { days, beforeProjectA, afterProjectA, startTs } = options;
  const events: Event[] = [];
  const half = Math.floor(days / 2);
  let ordinal = 0;
  for (let day = 0; day < days; day++) {
    const inFirstHalf = day < half;
    const shareA = inFirstHalf ? beforeProjectA : afterProjectA;
    const total = 20;
    const countA = Math.round(total * shareA);
    for (let i = 0; i < total; i++) {
      const cwd = i < countA ? '/Users/volcanic/work/project-a' : '/Users/volcanic/work/project-b';
      events.push(
        makeEvent({
          source: 'codex',
          sessionId: `s-${day}`,
          ordinal: ordinal++,
          ts: startTs + day * DAY + i * 60_000,
          role: i % 2 === 0 ? 'user' : 'assistant',
          text: i % 2 === 0 ? 'alpha topic deployment' : 'beta topic testing',
          cwd,
          metaSource: 'codex',
        }),
      );
    }
  }
  return events;
}

describe('computeDrift thresholds', () => {
  const startTs = localTs(2026, 1, 1, 9);

  test('reports a real project-share move', () => {
    // Project A goes from 10% to 90% of activity — far above every bar.
    const events = syntheticProjectStream({ days: 40, beforeProjectA: 0.1, afterProjectA: 0.9, startTs });
    const drift = computeDrift(buildSessions(events), 'all');
    expect(drift).not.toBeNull();
    expect(drift?.enoughData).toBe(true);
    const move = drift?.projectMoves.find((candidate) => candidate.label.endsWith('project-a'));
    expect(move).toBeDefined();
    expect(move?.deltaPp).toBeGreaterThan(SHARE_DELTA_PP);
  });

  test('suppresses a sub-threshold project-share move', () => {
    // 50% → 51.5%: a 1.5-point move, below the 5-point bar.
    const events = syntheticProjectStream({ days: 40, beforeProjectA: 0.5, afterProjectA: 0.515, startTs });
    const drift = computeDrift(buildSessions(events), 'all');
    expect(drift?.projectMoves).toEqual([]);
  });

  test('refuses to report at all when a half is too small', () => {
    const events = syntheticProjectStream({ days: 4, beforeProjectA: 0.1, afterProjectA: 0.9, startTs });
    const drift = computeDrift(buildSessions(events), 'all');
    expect(drift).not.toBeNull();
    expect(drift?.enoughData).toBe(false);
    expect(drift?.projectMoves).toEqual([]);
    expect(drift?.reason).toContain('required');
  });

  test('reports a real tool-mix move', () => {
    const events: Event[] = [];
    let ordinal = 0;
    for (let day = 0; day < 40; day++) {
      const tool = day < 20 ? 'old_tool' : 'new_tool';
      for (let i = 0; i < 20; i++) {
        events.push(
          makeEvent({
            source: 'codex',
            sessionId: `s-${day}`,
            ordinal: ordinal++,
            ts: startTs + day * DAY + i * 60_000,
            role: 'assistant',
            kind: 'tool_call',
            tool: { name: tool },
            cwd: '/Users/volcanic/work/p',
            metaSource: 'codex',
          }),
        );
      }
    }
    const drift = computeDrift(buildSessions(events), 'all');
    const moved = drift?.toolMoves.find((move) => move.label === 'new_tool');
    expect(moved?.deltaPp).toBeGreaterThanOrEqual(TOOL_MIX_PP);
  });

  test('reports a term whose rank moves at least the rank threshold', () => {
    const events: Event[] = [];
    let ordinal = 0;
    for (let day = 0; day < 40; day++) {
      const first = day < 20;
      for (let i = 0; i < 20; i++) {
        const text = first ? 'kubernetes deployment pipeline' : 'kubernetes deployment pipeline';
        events.push(
          makeEvent({
            source: 'codex',
            sessionId: `s-${day}`,
            ordinal: ordinal++,
            ts: startTs + day * DAY + i * 60_000,
            role: 'user',
            text: first && i === 0 ? `${text} kubernetes kubernetes` : text,
            cwd: '/Users/volcanic/work/p',
            metaSource: 'codex',
          }),
        );
      }
    }
    // Baseline: a term present in both halves with a stable rank is not
    // reported. Move a term 20 ranks by injecting a burst of it late.
    for (let i = 0; i < 200; i++) {
      events.push(
        makeEvent({
          source: 'codex',
          sessionId: 's-39',
          ordinal: ordinal++,
          ts: startTs + 39 * DAY + 30_000 + i * 100,
          role: 'user',
          text: 'newcomer newcomer newcomer',
          cwd: '/Users/volcanic/work/p',
          metaSource: 'codex',
        }),
      );
    }
    const drift = computeDrift(buildSessions(events), 'all');
    const riser = drift?.risingTerms.find((move) => move.term === 'newcomer');
    expect(riser?.direction).toBe('new');
    expect(TERM_RANK_DELTA).toBeGreaterThan(0);
  });

  test('drift runs on the interactive filter without automation events', () => {
    const events = syntheticProjectStream({ days: 40, beforeProjectA: 0.1, afterProjectA: 0.9, startTs });
    // A mirrored cron stream pulling the other way: it must not leak into the
    // interactive view, or the move would cancel out. Separate sessions and
    // the hermes cron label keep the two streams apart.
    let ordinal = 0;
    const cron: Event[] = syntheticProjectStream({ days: 40, beforeProjectA: 0.9, afterProjectA: 0.1, startTs }).map(
      (event) => ({
        ...event,
        id: `hermes:cron-${event.sessionId}:${ordinal}`,
        source: 'hermes',
        sessionId: `cron-${event.sessionId}`,
        ordinal: ordinal++,
        meta: { source: 'cron' },
      }),
    );
    const sessions = buildSessions([...events, ...cron]);
    const drift = computeDrift(sessions, 'interactive');
    expect(drift?.enoughData).toBe(true);
    const move = drift?.projectMoves.find((candidate) => candidate.label.endsWith('project-a'));
    expect(move).toBeDefined();
    expect(move!.deltaPp).toBeGreaterThan(0);
  });
});

describe('redactHome', () => {
  test('replaces the home prefix at a path boundary', () => {
    expect(redactHome('/Users/volcanic/codespace/x')).toBe('~/codespace/x');
  });

  test('does not touch a sibling directory with a shared prefix', () => {
    expect(redactHome('/Users/volcanic2/code')).toBe('/Users/volcanic2/code');
  });

  test('replaces a bare home path', () => {
    expect(redactHome('/Users/volcanic')).toBe('~');
  });

  test('leaves unrelated paths alone', () => {
    expect(redactHome('/opt/homebrew/bin')).toBe('/opt/homebrew/bin');
  });
});
