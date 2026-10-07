/**
 * Friction tests. The detector's two dangerous failure modes are opposite:
 * missing a real pattern (silent) and inventing one (a false accusation in the
 * most sensitive output the project produces). Both are tested here.
 */

import { describe, expect, test } from 'bun:test';
import { computeFriction, LOOP_MIN_PAIRS, REPEATED_FAILURE_MIN, writeTouchesOf } from '../src/analyze/friction.ts';
import { buildSessions } from '../src/analyze/session.ts';
import type { Event } from '../src/core/event.ts';

interface Call {
  session: string;
  callId: string;
  tool: string;
  args: string;
  ok?: boolean;
  resultName?: string;
}

/** Build one session from a flat call list, pairing call→result by callId. */
function session(source: string, name: string, calls: readonly Call[], options: { ts0?: number } = {}): Event[] {
  const sessionId = name;
  const events: Event[] = [];
  let ordinal = 0;
  let ts = options.ts0 ?? new Date(2026, 0, 1, 12, 0, 0, 0).getTime();
  events.push({
    id: `${source}:${sessionId}:${ordinal++}`,
    source,
    sessionId,
    ordinal: 0,
    ts: ts++,
    role: 'user',
    kind: 'message',
    text: 'start',
    meta: {},
  });
  for (const call of calls) {
    events.push({
      id: `${source}:${sessionId}:${ordinal}`,
      source,
      sessionId,
      ordinal: ordinal++,
      ts: ts++,
      role: 'assistant',
      kind: 'tool_call',
      tool: { name: call.tool, argsSummary: call.args },
      meta: { toolCallId: call.callId },
    });
    if (call.ok !== undefined) {
      const event: Event = {
        id: `${source}:${sessionId}:${ordinal}`,
        source,
        sessionId,
        ordinal: ordinal++,
        ts: ts++,
        role: 'tool',
        kind: 'tool_result',
        text: call.ok ? 'ok' : 'failed',
        tool: { name: call.resultName ?? call.tool, ok: call.ok },
        meta: { toolCallId: call.callId },
      };
      events.push(event);
    }
  }
  return events;
}

describe('repeated failures', () => {
  test('the same tool + same args failing three times is one finding', () => {
    const calls: Call[] = [0, 1, 2].map((i) => ({
      session: 's',
      callId: `c${i}`,
      tool: 'exec_command',
      args: '{"cmd":"npm run build"}',
      ok: false,
    }));
    const friction = computeFriction(buildSessions(session('codex', 's', calls)), 'all');
    expect(friction.repeatedFailures).toHaveLength(1);
    const finding = friction.repeatedFailures[0]!;
    expect(finding.label).toBe('exec_command');
    expect(finding.count).toBe(REPEATED_FAILURE_MIN);
    expect(finding.sessionCount).toBe(1);
  });

  test('the same tool with different args is not collapsed into a pattern', () => {
    const calls: Call[] = [1, 2, 3].map((i) => ({
      session: 's',
      callId: `c${i}`,
      tool: 'browser_navigate',
      args: `{"url":"https://site${i}.example"}`,
      ok: false,
    }));
    const friction = computeFriction(buildSessions(session('codex', 's', calls)), 'all');
    expect(friction.repeatedFailures).toHaveLength(0);
  });

  test('two failures are a retry, not a wall', () => {
    const calls: Call[] = [0, 1].map((i) => ({
      session: 's',
      callId: `c${i}`,
      tool: 'exec_command',
      args: '{"cmd":"x"}',
      ok: false,
    }));
    expect(computeFriction(buildSessions(session('codex', 's', calls)), 'all').repeatedFailures).toHaveLength(0);
  });

  test('pairing recovers the real tool name from an "unknown" result', () => {
    const calls: Call[] = [0, 1, 2].map((i) => ({
      session: 's',
      callId: `c${i}`,
      tool: 'exec_command',
      args: '{"cmd":"rg foo"}',
      ok: false,
      // Faithful to Codex: the failing result carries the placeholder name.
      resultName: 'unknown',
    }));
    const friction = computeFriction(buildSessions(session('codex', 's', calls)), 'all');
    expect(friction.repeatedFailures).toHaveLength(1);
    expect(friction.repeatedFailures[0]!.label).toBe('exec_command');
  });

  test('failures that cannot be paired and have an "unknown" name are dropped', () => {
    const events = session('codex', 's', []) as Event[];
    for (let i = 0; i < 4; i++) {
      events.push({
        id: `codex:s:${100 + i}`,
        source: 'codex',
        sessionId: 's',
        ordinal: 100 + i,
        ts: new Date(2026, 0, 1, 13, i, 0, 0).getTime(),
        role: 'tool',
        kind: 'tool_result',
        text: 'failed',
        tool: { name: 'unknown', ok: false },
        meta: {},
      });
    }
    const friction = computeFriction(buildSessions(events), 'all');
    expect(friction.repeatedFailures).toHaveLength(0);
  });

  test('findings carry their evidence: sessions, count and timestamps', () => {
    const calls: Call[] = [0, 1, 2].map((i) => ({
      session: 's',
      callId: `c${i}`,
      tool: 'exec_command',
      args: '{"cmd":"x"}',
      ok: false,
    }));
    const finding = computeFriction(buildSessions(session('codex', 's', calls)), 'all').repeatedFailures[0]!;
    expect(finding.sessions).toEqual(['codex:s']);
    expect(finding.firstTs).toBeLessThanOrEqual(finding.lastTs);
    expect(finding.detail.occurrences).toBe(3);
  });
});

describe('long loops', () => {
  test('a run of pairs with no user turn between is reported', () => {
    const calls: Call[] = Array.from({ length: LOOP_MIN_PAIRS }, (_, i) => ({
      session: 's',
      callId: `c${i}`,
      tool: 'exec_command',
      args: `{"cmd":"step ${i}"}`,
      ok: true,
    }));
    const friction = computeFriction(buildSessions(session('codex', 's', calls)), 'all');
    expect(friction.longLoops).toHaveLength(1);
    expect(friction.longLoops[0]!.count).toBe(LOOP_MIN_PAIRS);
    expect(friction.longLoops[0]!.detail.topTool).toBe('exec_command');
  });

  test('a user turn interrupts the run before it can be long', () => {
    // Two runs of LOOP_MIN_PAIRS-1 pairs, split by a user turn: neither counts.
    const half = LOOP_MIN_PAIRS - 1;
    const events: Event[] = [];
    let ordinal = 0;
    let ts = new Date(2026, 0, 1, 12, 0, 0, 0).getTime();
    const push = (event: Event): void => {
      events.push(event);
      ordinal++;
      ts++;
    };
    for (let block = 0; block < 2; block++) {
      push({ id: `x:s:${ordinal}`, source: 'x', sessionId: 's', ordinal, ts, role: 'user', kind: 'message', text: `q${block}`, meta: {} });
      for (let i = 0; i < half; i++) {
        const callId = `b${block}c${i}`;
        push({ id: `x:s:${ordinal}`, source: 'x', sessionId: 's', ordinal, ts, role: 'assistant', kind: 'tool_call', tool: { name: 'exec_command', argsSummary: `{"cmd":"${i}"}` }, meta: { toolCallId: callId } });
        push({ id: `x:s:${ordinal}`, source: 'x', sessionId: 's', ordinal, ts, role: 'tool', kind: 'tool_result', text: 'ok', tool: { name: 'exec_command', ok: true }, meta: { toolCallId: callId } });
      }
    }
    const friction = computeFriction(buildSessions(events), 'all');
    expect(friction.longLoops).toHaveLength(0);
  });
});

describe('reverted work', () => {
  test('two different writes to one path in one session is a rewrite', () => {
    const calls: Call[] = [
      { session: 's', callId: 'w1', tool: 'write_file', args: '{"path":"/tmp/a.ts","content":"one"}', ok: true },
      { session: 's', callId: 'w2', tool: 'write_file', args: '{"path":"/tmp/a.ts","content":"two"}', ok: true },
    ];
    const friction = computeFriction(buildSessions(session('hermes', 's', calls)), 'all');
    expect(friction.revertedWork).toHaveLength(1);
    expect(friction.revertedWork[0]!.detail.versions).toBe(2);
    expect(friction.revertedWork[0]!.detail.exactRevert).toBe(false);
  });

  test('a rewrite that restores an earlier content is an exact revert', () => {
    const calls: Call[] = [
      { session: 's', callId: 'w1', tool: 'write_file', args: '{"path":"/tmp/a.ts","content":"one"}', ok: true },
      { session: 's', callId: 'w2', tool: 'write_file', args: '{"path":"/tmp/a.ts","content":"two"}', ok: true },
      { session: 's', callId: 'w3', tool: 'write_file', args: '{"path":"/tmp/a.ts","content":"one"}', ok: true },
    ];
    const friction = computeFriction(buildSessions(session('hermes', 's', calls)), 'all');
    expect(friction.revertedWork[0]!.detail.exactRevert).toBe(true);
    expect(friction.revertedWork[0]!.detail.writes).toBe(3);
  });

  test('identical repeated content and a single write are not rewrites', () => {
    const same = computeFriction(
      buildSessions(
        session('hermes', 's', [
          { session: 's', callId: 'a', tool: 'write_file', args: '{"path":"/tmp/a","content":"same"}', ok: true },
          { session: 's', callId: 'b', tool: 'write_file', args: '{"path":"/tmp/a","content":"same"}', ok: true },
        ]),
      ),
      'all',
    );
    expect(same.revertedWork).toHaveLength(0);
    const once = computeFriction(
      buildSessions(session('hermes', 's', [{ session: 's', callId: 'a', tool: 'write_file', args: '{"path":"/tmp/a","content":"x"}', ok: true }])),
      'all',
    );
    expect(once.revertedWork).toHaveLength(0);
  });

  test('the label is home-redacted', () => {
    const calls: Call[] = [
      { session: 's', callId: 'w1', tool: 'write_file', args: `{"path":"${'/Users/volcanic'}/p/a.ts","content":"one"}`, ok: true },
      { session: 's', callId: 'w2', tool: 'write_file', args: `{"path":"${'/Users/volcanic'}/p/a.ts","content":"two"}`, ok: true },
    ];
    const finding = computeFriction(buildSessions(session('hermes', 's', calls)), 'all').revertedWork[0]!;
    expect(finding.label.startsWith('~/')).toBe(true);
    expect(finding.label).not.toContain('/Users/volcanic');
  });
});

describe('writeTouchesOf', () => {
  test('reads JSON path and content', () => {
    expect(writeTouchesOf('write_file', '{"path":"a.ts","content":"body"}')).toEqual([{ path: 'a.ts', content: 'body' }]);
    expect(writeTouchesOf('Write', '{"file_path":"a.ts","content":"body"}')).toEqual([{ path: 'a.ts', content: 'body' }]);
  });

  test('reads a hermes patch as new_string', () => {
    expect(writeTouchesOf('patch', '{"path":"a.ts","old_string":"x","new_string":"y"}')).toEqual([
      { path: 'a.ts', content: 'y' },
    ]);
  });

  test('reads every file section of an apply_patch', () => {
    const patch = ['*** Begin Patch', '*** Update File: one.ts', '@@', '-a', '+b', '*** Update File: two.ts', '@@', '-c', '+d', '*** End Patch'].join('\n');
    const touches = writeTouchesOf('apply_patch', patch);
    expect(touches.map((touch) => touch.path)).toEqual(['one.ts', 'two.ts']);
    expect(touches[0]!.content).toContain('+b');
    expect(touches[1]!.content).toContain('+d');
  });

  test('unreadable args produce no touches rather than an invented finding', () => {
    expect(writeTouchesOf('write_file', 'not json at all')).toEqual([]);
    expect(writeTouchesOf('write_file', '{"path":"a.ts"}')).toEqual([]);
    expect(writeTouchesOf('write_file', undefined)).toEqual([]);
  });
});

describe('abandoned sessions', () => {
  test('a session ending on a failed result is abandoned', () => {
    const calls: Call[] = [{ session: 's', callId: 'c', tool: 'exec_command', args: '{}', ok: false }];
    const friction = computeFriction(buildSessions(session('codex', 's', calls)), 'all');
    expect(friction.abandonedSessions).toHaveLength(1);
    expect(friction.abandonedSessions[0]!.detail.endedFailedResult).toBe(true);
  });

  test('a session ending mid-tool-call is abandoned', () => {
    const calls: Call[] = [{ session: 's', callId: 'c', tool: 'exec_command', args: '{}' }];
    const friction = computeFriction(buildSessions(session('codex', 's', calls)), 'all');
    expect(friction.abandonedSessions).toHaveLength(1);
    expect(friction.abandonedSessions[0]!.detail.endedMidCall).toBe(true);
  });

  test('a session ending on a successful result is not abandoned', () => {
    const calls: Call[] = [{ session: 's', callId: 'c', tool: 'exec_command', args: '{}', ok: true }];
    expect(computeFriction(buildSessions(session('codex', 's', calls)), 'all').abandonedSessions).toHaveLength(0);
  });
});
