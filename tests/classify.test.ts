/**
 * Session classifier tests — the cron/telegram/empty cases are the ones the
 * whole portrait depends on, and each rule's ordering is part of the contract.
 */

import { describe, expect, test } from 'bun:test';
import { classifySession } from '../src/analyze/classify.ts';
import { buildSessions, filterSessions, tallyByClass } from '../src/analyze/session.ts';
import { makeEvent, localTs } from './helpers.ts';

const TS = localTs(2026, 4, 10, 10);

describe('classifySession', () => {
  test('a cron session is automation even though it has user-role prompts', () => {
    const events = [
      makeEvent({ ts: TS, ordinal: 0, role: 'user', kind: 'message', text: 'scheduled prompt', metaSource: 'cron' }),
      makeEvent({ ts: TS + 1000, ordinal: 1, role: 'assistant', kind: 'message', text: 'working', metaSource: 'cron' }),
    ];
    expect(classifySession(events)).toBe('automation');
  });

  test('a telegram session with an authored turn is interactive', () => {
    const events = [
      makeEvent({ ts: TS, ordinal: 0, role: 'user', kind: 'message', text: '帮我看下这个 bug', metaSource: 'telegram' }),
      makeEvent({ ts: TS + 1000, ordinal: 1, role: 'assistant', kind: 'message', text: '好的', metaSource: 'telegram' }),
    ];
    expect(classifySession(events)).toBe('interactive');
  });

  test('an empty session is other', () => {
    expect(classifySession([])).toBe('other');
  });

  test('a pure tool session with no authored turn is automation', () => {
    const events = [
      makeEvent({ ts: TS, ordinal: 0, role: 'tool', kind: 'tool_result', text: 'ok', metaSource: 'telegram' }),
      makeEvent({ ts: TS + 1000, ordinal: 1, role: 'assistant', kind: 'tool_call', tool: { name: 'bash' }, metaSource: 'telegram' }),
    ];
    expect(classifySession(events)).toBe('automation');
  });

  test('a claude-code session is interactive without needing meta.source', () => {
    const events = [
      makeEvent({ source: 'claude-code', sessionId: 'abc', ts: TS, ordinal: 0, role: 'user', kind: 'message', text: 'fix this' }),
      makeEvent({ source: 'claude-code', sessionId: 'abc', ts: TS + 1000, ordinal: 1, role: 'assistant', kind: 'message', text: 'done' }),
    ];
    expect(classifySession(events)).toBe('interactive');
  });

  test('a claude-code session with no authored turn is other', () => {
    const events = [
      makeEvent({ source: 'claude-code', sessionId: 'abc', ts: TS, ordinal: 0, role: 'system', kind: 'session_start' }),
      makeEvent({ source: 'claude-code', sessionId: 'abc', ts: TS + 1000, ordinal: 1, role: 'assistant', kind: 'message', text: 'hi' }),
    ];
    // Not pure-tool traffic, not cron, and no authored user turn → other.
    expect(classifySession(events)).toBe('other');
  });

  test('an unknown hermes source is not assumed human', () => {
    const events = [
      makeEvent({ ts: TS, ordinal: 0, role: 'user', kind: 'message', text: 'hello', metaSource: 'mystery-channel' }),
    ];
    expect(classifySession(events)).toBe('other');
  });

  test('a hermes session with no source label at all is other', () => {
    const events = [makeEvent({ ts: TS, ordinal: 0, role: 'user', kind: 'message', text: 'hello' })];
    expect(classifySession(events)).toBe('other');
  });

  test('an empty user message does not make a session interactive', () => {
    const events = [
      makeEvent({ ts: TS, ordinal: 0, role: 'user', kind: 'message', text: '   ', metaSource: 'telegram' }),
      makeEvent({ ts: TS + 1000, ordinal: 1, role: 'assistant', kind: 'message', text: 'hi', metaSource: 'telegram' }),
    ];
    expect(classifySession(events)).toBe('other');
  });
});

describe('session grouping and filtering', () => {
  test('buildSessions groups by (source, sessionId) and sorts by ordinal', () => {
    const events = [
      makeEvent({ ts: TS + 5000, ordinal: 5, role: 'assistant', text: 'second' }),
      makeEvent({ ts: TS, ordinal: 1, role: 'user', text: 'first' }),
      makeEvent({ source: 'codex', sessionId: 'x', ts: TS, ordinal: 0, role: 'user', text: 'other source' }),
    ];
    const sessions = buildSessions(events);
    expect(sessions).toHaveLength(2);
    const hermes = sessions.find((session) => session.source === 'hermes');
    expect(hermes?.eventCount).toBe(2);
    expect(hermes?.events[0]?.ordinal).toBe(1);
    expect(hermes?.startTs).toBe(TS);
    expect(hermes?.endTs).toBe(TS + 5000);
  });

  test('filterSessions excludes automation on the interactive filter', () => {
    const events = [
      makeEvent({ sessionId: 'cron', ts: TS, ordinal: 0, role: 'user', text: 'p', metaSource: 'cron' }),
      makeEvent({ sessionId: 'tg', ts: TS, ordinal: 1, role: 'user', text: 'p', metaSource: 'telegram' }),
    ];
    const sessions = buildSessions(events);
    expect(filterSessions(sessions, 'interactive')).toHaveLength(1);
    expect(filterSessions(sessions, 'interactive')[0]?.label).toBe('telegram');
    expect(filterSessions(sessions, 'all')).toHaveLength(2);
    expect(filterSessions(sessions, 'automation')).toHaveLength(1);
  });

  test('tallyByClass counts sessions and events per class', () => {
    const events = [
      makeEvent({ sessionId: 'cron', ts: TS, ordinal: 0, role: 'user', text: 'p', metaSource: 'cron' }),
      makeEvent({ sessionId: 'cron', ts: TS + 1, ordinal: 1, role: 'assistant', text: 'q', metaSource: 'cron' }),
      makeEvent({ sessionId: 'tg', ts: TS, ordinal: 2, role: 'user', text: 'p', metaSource: 'telegram' }),
    ];
    const tally = tallyByClass(buildSessions(events));
    expect(tally.automation).toEqual({ sessions: 1, events: 2 });
    expect(tally.interactive).toEqual({ sessions: 1, events: 1 });
    expect(tally.other).toEqual({ sessions: 0, events: 0 });
  });
});
