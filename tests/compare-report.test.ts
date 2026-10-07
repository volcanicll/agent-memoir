/**
 * Compare and report tests.
 *
 * `contrasts()` is the one module where the project makes claims about a
 * person's behaviour ("Codex works this way"), so the properties that matter
 * are: every claim is arithmetic from the table, every claim carries its two
 * numbers, and a claim is withheld rather than guessed when the data cannot
 * support it.
 */

import { describe, expect, test } from 'bun:test';
import { computeCompare, contrasts, LENGTH_RATIO, MIN_MEDIAN_MINUTES } from '../src/analyze/compare.ts';
import { buildReportInsights, renderReport } from '../src/analyze/report.ts';
import { analyzeAll } from '../src/analyze/index.ts';
import { computeFriction } from '../src/analyze/friction.ts';
import { buildSessions } from '../src/analyze/session.ts';
import { assertExportable } from '../src/core/privacy.ts';
import { MemoirStore } from '../src/store/sqlite.ts';
import type { Event } from '../src/core/event.ts';
import { buildPhase2Fixture, CONVERSATION_NEEDLE, HOME_PREFIX, SEARCH_TERM, SESSION_ID_MARKER } from '../scripts/fixtures/phase2-fixture.ts';

function storeOf(events: readonly Event[]): MemoirStore {
  const store = new MemoirStore(':memory:');
  store.appendMany(events);
  return store;
}

describe('computeCompare', () => {
  test('produces one row per source, sorted by sessions', () => {
    const store = storeOf(buildPhase2Fixture().events);
    try {
      const comparison = computeCompare(buildSessions(buildPhase2Fixture().events), 'all');
      expect(comparison.sources.map((row) => row.source)).toEqual(['fixture-b', 'fixture-a']);
      for (const row of comparison.sources) {
        expect(row.hourHistogram).toHaveLength(24);
        expect(row.hourHistogram.reduce((total, count) => total + count, 0)).toBe(row.events);
        expect(row.classMix.interactive + row.classMix.automation + row.classMix.other).toBe(row.sessions);
      }
    } finally {
      store.close();
    }
  });

  test('a source with no resolved results reports null, never 0', () => {
    const events: Event[] = [
      { id: 'x:s:0', source: 'x', sessionId: 's', ordinal: 0, ts: 1, role: 'user', kind: 'message', text: 'hi', meta: {} },
      { id: 'x:s:1', source: 'x', sessionId: 's', ordinal: 1, ts: 2, role: 'assistant', kind: 'tool_call', tool: { name: 'Read' }, meta: {} },
    ];
    const comparison = computeCompare(buildSessions(events), 'all');
    expect(comparison.sources[0]!.failureRate).toBeNull();
    expect(comparison.sources[0]!.resolvedCount).toBe(0);
  });

  test('an empty scope yields no rows rather than an error', () => {
    expect(computeCompare([], 'interactive').sources).toEqual([]);
  });
});

describe('contrasts', () => {
  test('emits the planted contrasts on the fixture and each carries both numbers', () => {
    const comparison = computeCompare(buildSessions(buildPhase2Fixture().events), 'all');
    const found = contrasts(comparison);
    const keys = found.map((contrast) => contrast.key);
    expect(keys).toContain('top_tool_dominance');
    expect(keys).toContain('reasoning_share');
    expect(keys).toContain('tool_failure_rate');
    for (const contrast of found) {
      expect(contrast.sourceA).not.toBe(contrast.sourceB);
      expect(Number.isFinite(contrast.valueA)).toBe(true);
      expect(Number.isFinite(contrast.valueB)).toBe(true);
      expect(contrast.labelA.length).toBeGreaterThan(0);
      expect(contrast.labelB.length).toBeGreaterThan(0);
      // The statement contains both formatted values — the claim and its
      // arithmetic in one sentence, with nothing hand-written.
      const format = (value: number): string => {
        if (contrast.unit === 'share') return `${(value * 100).toFixed(1)}%`;
        if (contrast.unit === 'hour') return `${String(Math.round(value)).padStart(2, '0')}:00`;
        if (contrast.unit === 'minutes') return `${value.toFixed(0)}`;
        return value.toFixed(1);
      };
      expect(contrast.statement).toContain(format(contrast.valueA));
      expect(contrast.statement).toContain(format(contrast.valueB));
    }
  });

  test('claims nothing from a single source', () => {
    const events: Event[] = Array.from({ length: 200 }, (_, i) => ({
      id: `only:s:${i}`,
      source: 'only',
      sessionId: 's',
      ordinal: i,
      ts: 1000 + i,
      role: 'assistant',
      kind: 'tool_call',
      tool: { name: 'Read' },
      meta: {},
    }));
    expect(contrasts(computeCompare(buildSessions(events), 'all'))).toEqual([]);
  });

  test('a within-noise difference produces no contrast', () => {
    // Two sources with the same tool mix: nothing should be claimed.
    const make = (source: string): Event[] =>
      Array.from({ length: 60 }, (_, i) => ({
        id: `${source}:s:${i}`,
        source,
        sessionId: 's',
        ordinal: i,
        ts: 1000 + i,
        role: 'assistant' as const,
        kind: 'tool_call' as const,
        tool: { name: i % 2 === 0 ? 'Read' : 'Write' },
        meta: {},
      }));
    const comparison = computeCompare(buildSessions([...make('one'), ...make('two')]), 'all');
    expect(contrasts(comparison).filter((contrast) => contrast.key === 'top_tool_dominance')).toHaveLength(0);
  });

  test('a near-zero median session length is not turned into a giant ratio', () => {
    // This is the real-data bug: Hermes' median is ~0 minutes, which made the
    // first implementation claim "130,802× the median hermes session".
    const make = (source: string, durationMs: number, count: number): Event[] =>
      Array.from({ length: count }, (_, i) => ({
        id: `${source}:s${i}:0`,
        source,
        sessionId: `s${i}`,
        ordinal: 0,
        ts: durationMs * i + 1000,
        role: 'user' as const,
        kind: 'message' as const,
        text: 'hi',
        meta: {},
      }));
    const one = { source: 'instant', durationMs: 1, count: 10 };
    const long = { source: 'long', durationMs: 600_000, count: 10 };
    const comparison = computeCompare(
      buildSessions([...make(one.source, one.durationMs, one.count), ...make(long.source, long.durationMs, long.count)]),
      'all',
    );
    const lengthContrast = contrasts(comparison).find((contrast) => contrast.key === 'session_length');
    // The instant source's median is below the floor, so no length claim.
    expect(lengthContrast).toBeUndefined();
    expect((comparison.sources.find((row) => row.source === 'instant')?.medianSessionMinutes ?? 1) < MIN_MEDIAN_MINUTES).toBe(true);
    expect(LENGTH_RATIO).toBeGreaterThan(1);
  });

  test('is deterministic across runs', () => {
    const first = contrasts(computeCompare(buildSessions(buildPhase2Fixture().events), 'all')).map((c) => c.key);
    const second = contrasts(computeCompare(buildSessions(buildPhase2Fixture().events), 'all')).map((c) => c.key);
    expect(first).toEqual(second);
  });
});

describe('report', () => {
  test('every embedded Insight passes the export guard', () => {
    const { events } = buildPhase2Fixture();
    const store = storeOf(events);
    try {
      const sessions = buildSessions(events);
      const insights = buildReportInsights(
        analyzeAll(store),
        computeCompare(sessions, 'all'),
        computeFriction(sessions, 'all'),
      );
      expect(insights.length).toBeGreaterThan(0);
      for (const insight of insights) {
        expect(() => assertExportable(insight)).not.toThrow();
      }
    } finally {
      store.close();
    }
  });

  test('the rendered markdown leaks no path, session id, uuid or conversation text', () => {
    const { events } = buildPhase2Fixture();
    const store = storeOf(events);
    try {
      const sessions = buildSessions(events);
      const insights = buildReportInsights(
        analyzeAll(store),
        computeCompare(sessions, 'all'),
        computeFriction(sessions, 'all'),
      );
      const markdown = renderReport(insights);
      expect(markdown).not.toContain(HOME_PREFIX);
      expect(markdown).not.toContain('/Users/');
      expect(markdown).not.toContain(SESSION_ID_MARKER);
      for (const session of sessions) expect(markdown).not.toContain(session.sessionId);
      for (const needle of [CONVERSATION_NEEDLE, SEARCH_TERM, 'npm run -s build', 'loop.ts']) {
        expect(markdown).not.toContain(needle);
      }
      expect(markdown).toMatch(/^# /);
    } finally {
      store.close();
    }
  });

  test('friction appears as counts only, with no per-finding evidence', () => {
    const { events } = buildPhase2Fixture();
    const store = storeOf(events);
    try {
      const sessions = buildSessions(events);
      const friction = computeFriction(sessions, 'all');
      const insights = buildReportInsights(analyzeAll(store), computeCompare(sessions, 'all'), friction);
      const markdown = renderReport(insights);
      expect(markdown).toContain('recurring failure patterns');
      // The report DOES name tools — they are identifiers, and the source
      // table would be meaningless without them. What must never appear is a
      // finding's evidence: its raw signature (a command line), a rewritten
      // path, or a reconstructed session key.
      for (const finding of friction.revertedWork) {
        expect(markdown).not.toContain(finding.label);
        expect(markdown).not.toContain(finding.signature);
      }
      for (const finding of friction.repeatedFailures) {
        expect(markdown).not.toContain(finding.signature);
        const args = String(finding.detail.args ?? '');
        if (args.length > 0) expect(markdown).not.toContain(args);
      }
      for (const finding of friction.longLoops) {
        expect(markdown).not.toContain(finding.signature);
      }
    } finally {
      store.close();
    }
  });
});
