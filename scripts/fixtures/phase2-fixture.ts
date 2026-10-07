/**
 * Fixture for the Phase 2 gate (`verify:phase2`).
 *
 * Deliberately NOT real data: the gate must produce identical numbers on any
 * machine, on any day. Built so every asserted number is hand-computable, and
 * it encodes the exact traps this phase was warned about:
 *
 *   1. A DELIBERATE repeated failure: `exec_command` returning ok:false three
 *      times in one session with the SAME command, paired call→result through
 *      `meta.toolCallId` (the pairing the adapters actually provide — the
 *      failing result carries no reliable tool name of its own).
 *   2. Tool calls that fail with DIFFERENT arguments — they must NOT be
 *      reported. This is the false-positive check the repeated-failure
 *      detector lives or dies by.
 *   3. A DELIBERATE long loop: 60 tool-call pairs with no user-role event
 *      between them (LOOP_MIN_PAIRS is 50). The rewrite that follows the loop
 *      is still tool traffic, so the measured run is 63 pairs, not 60.
 *   4. A DELIBERATE rewrite: one path written 3 times in one session with 2
 *      distinct contents, the last restoring the first (exact revert). The
 *      clean session writes a DIFFERENT path exactly once — not a rewrite.
 *   5. A DELIBERATE abandoned session: last event is a tool_result ok:false.
 *   6. Two sources whose comparison numbers are hand-computed below, with
 *      tool dominance, reasoning share and failure rate differing by more
 *      than each contrast threshold, so `contrasts()` must emit rows and each
 *      emitted row must carry both of its source numbers.
 *   7. Authored conversation text that must never reach the shareable report:
 *      CONVERSATION_NEEDLE appears in one message so the gate can prove it is
 *      absent from the markdown.
 *
 * The synthetic source ids are 'fixture-a' / 'fixture-b', which the session
 * classifier deliberately reports as class 'other' (see classify.ts: an
 * unknown source is never assumed human). The gate therefore scopes compare
 * and friction to 'all', which also proves 'other' sessions are visible to
 * both rather than silently dropped.
 *
 * Hand-computed arithmetic (session by session, below):
 *
 *   fixture-a · repeat session:  1 user + 3×(call+result) + 2×(call+result) + 1×(call+result) = 13 events, 6 calls
 *   fixture-a · loop session:    1 user + 60×2 = 121, + 20 reasoning, + 3×2 writes = 147 events, 63 calls
 *     → fixture-a totals: 160 events, 69 calls, 69 resolved results
 *     → exec_command calls 3 + 60 + 1 = 64 of 69 = 92.75%
 *     → reasoning 20 of 160 = 12.50%
 *     → failures 5 (3 repeat + 2 varied) of 69 = 7.25%
 *
 *   fixture-b · clean session:   1 user + 4×2 + 1×2 = 11 events, 5 calls
 *   fixture-b · abandoned:       3 events, 1 call
 *   fixture-b · search:          2 events, 0 calls
 *   fixture-b · spread session:  56 user turns + 56×3 = 168 events, 56 calls (14 each of 4 tools)
 *     → fixture-b totals: 184 events, 62 calls, 62 resolved results
 *     → top tool read_file (4 + 14) of 62 = 29.03%
 *     → reasoning 0%
 *     → failures 1 (the abandoned session) of 62 = 1.61%
 *
 *   contrasts that must fire:
 *     tool dominance 92.75% − 29.03% = 63.7pp ≥ TOOL_DOMINANCE_PP (15)
 *     reasoning      12.50% − 0%      = 12.5pp ≥ REASONING_PP (10)
 *     failure rate    7.25% − 1.61%   =  5.6pp ≥ FAILURE_PP (2)
 */

import { makeEventId, type Event } from '../../src/core/event.ts';

export const FIXTURE_TAG = 'memoirfixture2';
/** Token in every session id; the gate asserts it never reaches output. */
export const SESSION_ID_MARKER = 'sessidmarker2';
/** Authored conversation text that must never leave the machine. */
export const CONVERSATION_NEEDLE = '把监控指标补齐别忘了';
/** Absolute path used as the fixture's "home" directory. */
export const PROJECT_DIR = '/Users/volcanic/work/fixture2';
export const HOME_PREFIX = '/Users/volcanic';

/** Failing tool whose SAME arguments repeat three times. */
export const REPEAT_TOOL = 'exec_command';
export const REPEAT_ARGS = '{"cmd":"npm run -s build"}';
export const REPEAT_COUNT = 3;

/** Failures with the SAME tool but DIFFERENT args — must not become a pattern. */
export const VARIED_TOOL = 'browser_navigate';
export const VARIED_ARGS = ['{"url":"https://one.example"}', '{"url":"https://two.example"}'];

/** Call/result pairs in the deliberate long loop (must exceed LOOP_MIN_PAIRS). */
export const LOOP_PAIRS = 60;
/** The loop run includes the 3 rewrite calls that follow it: 60 + 3. */
export const EXPECTED_LOOP_RUN = 63;

/** The path rewritten in one session, and the one written only once. */
export const REWRITE_PATH = `${PROJECT_DIR}/src/loop.ts`;
export const SINGLE_WRITE_PATH = `${PROJECT_DIR}/src/once.ts`;
export const REWRITE_WRITES = 3;
export const REWRITE_VERSIONS = 2;

/** Distinct tools the spread session cycles through, 14 calls each. */
export const SPREAD_TOOLS = ['read_file', 'search_files', 'glob_files', 'list_dir'] as const;
export const SPREAD_CALLS_PER_TOOL = 14;

/** The unique free-text term the search assertions look for. */
export const SEARCH_TERM = 'zephyrquux';
/** A CJK term in the same message — exercises the bigram tokenizer path. */
export const SEARCH_CJK = '数据管线';

export interface Phase2Expectations {
  readonly totals: { readonly events: number; readonly sessions: number };
  readonly repeatFailure: { readonly tool: string; readonly count: number; readonly sessions: number };
  readonly longLoop: { readonly runPairs: number; readonly findings: number };
  readonly rewrites: { readonly findings: number; readonly exactRevert: number };
  readonly abandoned: number;
  readonly compare: {
    readonly sources: number;
    readonly a: {
      readonly source: string;
      readonly events: number;
      readonly sessions: number;
      readonly toolCalls: number;
      readonly topTool: string;
      readonly topShare: number;
      readonly reasoningShare: number;
      readonly failureRate: number;
    };
    readonly b: {
      readonly source: string;
      readonly events: number;
      readonly sessions: number;
      readonly toolCalls: number;
      readonly topTool: string;
      readonly topShare: number;
      readonly reasoningShare: number;
      readonly failureRate: number;
    };
  };
  readonly search: { readonly term: string; readonly eventId: string };
}

const DAY = new Date(2026, 5, 1, 10, 0, 0, 0).getTime();
const MINUTE = 60_000;

interface Draft {
  source: string;
  sessionId: string;
  ordinal: number;
  ts: number;
  role: Event['role'];
  kind: Event['kind'];
  text?: string;
  tool?: Event['tool'];
  meta?: Record<string, unknown>;
  refs?: Event['refs'];
}

function event(draft: Draft): Event {
  const value: Event = {
    id: makeEventId(draft.source, draft.sessionId, draft.ordinal),
    source: draft.source,
    sessionId: draft.sessionId,
    ordinal: draft.ordinal,
    ts: draft.ts,
    role: draft.role,
    kind: draft.kind,
    meta: draft.meta ?? {},
  };
  if (draft.text !== undefined) value.text = draft.text;
  if (draft.tool !== undefined) value.tool = draft.tool;
  if (draft.refs !== undefined) value.refs = draft.refs;
  return value;
}

const REFS = { cwd: PROJECT_DIR, model: 'fixture-model' };

/** 1 user turn + 3 same-arg failures + 2 different-arg failures. */
function repeatFailureSession(): Event[] {
  const source = 'fixture-a';
  const sessionId = `${SESSION_ID_MARKER}-${FIXTURE_TAG}-repeat`;
  const events: Event[] = [];
  let ordinal = 0;
  events.push(
    event({
      source,
      sessionId,
      ordinal: ordinal++,
      ts: DAY,
      role: 'user',
      kind: 'message',
      text: 'run the build until it passes',
      meta: { fixture: true },
      refs: REFS,
    }),
  );
  for (let i = 0; i < REPEAT_COUNT; i++) {
    const callId = `call_repeat_${i}`;
    events.push(
      event({
        source,
        sessionId,
        ordinal: ordinal++,
        ts: DAY + (i * 2 + 1) * MINUTE,
        role: 'assistant',
        kind: 'tool_call',
        tool: { name: REPEAT_TOOL, argsSummary: REPEAT_ARGS },
        meta: { toolCallId: callId },
        refs: REFS,
      }),
      event({
        source,
        sessionId,
        ordinal: ordinal++,
        ts: DAY + (i * 2 + 2) * MINUTE,
        role: 'tool',
        kind: 'tool_result',
        text: 'build failed',
        // Faithful to the real adapters: Codex's failing results carry the
        // placeholder name 'unknown' (832 of them on this machine), so the
        // signature can only be recovered by PAIRING to the tool_call. A
        // detector that reads the result's own name would report a fake
        // 'unknown' pattern instead of this one.
        tool: { name: 'unknown', ok: false },
        meta: { toolCallId: callId },
        refs: REFS,
      }),
    );
  }
  for (let i = 0; i < VARIED_ARGS.length; i++) {
    const callId = `call_varied_${i}`;
    events.push(
      event({
        source,
        sessionId,
        ordinal: ordinal++,
        ts: DAY + (10 + i * 2) * MINUTE,
        role: 'assistant',
        kind: 'tool_call',
        tool: { name: VARIED_TOOL, argsSummary: VARIED_ARGS[i] ?? '' },
        meta: { toolCallId: callId },
        refs: REFS,
      }),
      event({
        source,
        sessionId,
        ordinal: ordinal++,
        ts: DAY + (11 + i * 2) * MINUTE,
        role: 'tool',
        kind: 'tool_result',
        text: 'navigation failed',
        tool: { name: VARIED_TOOL, ok: false },
        meta: { toolCallId: callId },
        refs: REFS,
      }),
    );
  }
  // The person retries and it works: without this the session would also end
  // on a failure and be counted as abandoned, which the fixture must not do
  // by accident — abandonment is planted in exactly one session.
  events.push(
    event({
      source,
      sessionId,
      ordinal: ordinal++,
      ts: DAY + 20 * MINUTE,
      role: 'assistant',
      kind: 'tool_call',
      tool: { name: REPEAT_TOOL, argsSummary: '{"cmd":"npm test"}' },
      meta: { toolCallId: 'call_recovered' },
      refs: REFS,
    }),
    event({
      source,
      sessionId,
      ordinal: ordinal++,
      ts: DAY + 21 * MINUTE,
      role: 'tool',
      kind: 'tool_result',
      text: 'tests passed',
      tool: { name: REPEAT_TOOL, ok: true },
      meta: { toolCallId: 'call_recovered' },
      refs: REFS,
    }),
  );
  return events;
}

/** A healthy session: short loops, one single write, no friction. */
function cleanSession(): Event[] {
  const source = 'fixture-b';
  const sessionId = `${SESSION_ID_MARKER}-${FIXTURE_TAG}-clean`;
  const events: Event[] = [];
  let ordinal = 0;
  events.push(
    event({
      source,
      sessionId,
      ordinal: ordinal++,
      ts: DAY + 60 * MINUTE,
      role: 'user',
      kind: 'message',
      // The needle lives here: authored text that must never be exported.
      text: `${CONVERSATION_NEEDLE} — 顺便看一下 lint`,
      meta: { fixture: true },
      refs: REFS,
    }),
  );
  for (let i = 0; i < 4; i++) {
    const callId = `call_clean_${i}`;
    events.push(
      event({
        source,
        sessionId,
        ordinal: ordinal++,
        ts: DAY + (61 + i * 2) * MINUTE,
        role: 'assistant',
        kind: 'tool_call',
        tool: { name: 'read_file', argsSummary: `{"path":"${PROJECT_DIR}/src/a.ts"}` },
        meta: { toolCallId: callId },
        refs: REFS,
      }),
      event({
        source,
        sessionId,
        ordinal: ordinal++,
        ts: DAY + (62 + i * 2) * MINUTE,
        role: 'tool',
        kind: 'tool_result',
        text: 'ok',
        tool: { name: 'read_file', ok: true },
        meta: { toolCallId: callId },
        refs: REFS,
      }),
    );
  }
  events.push(
    event({
      source,
      sessionId,
      ordinal: ordinal++,
      ts: DAY + 75 * MINUTE,
      role: 'assistant',
      kind: 'tool_call',
      tool: { name: 'write_file', argsSummary: `{"path":"${SINGLE_WRITE_PATH}","content":"first"}` },
      meta: { toolCallId: 'call_single' },
      refs: REFS,
    }),
    event({
      source,
      sessionId,
      ordinal: ordinal++,
      ts: DAY + 76 * MINUTE,
      role: 'tool',
      kind: 'tool_result',
      text: 'ok',
      tool: { name: 'write_file', ok: true },
      meta: { toolCallId: 'call_single' },
      refs: REFS,
    }),
  );
  return events;
}

/**
 * A session with many tool calls — but each pair is separated by a user turn,
 * so it is NOT a long loop — spread evenly across four tools so fixture-b has
 * no dominant tool.
 */
function spreadSession(): Event[] {
  const source = 'fixture-b';
  const sessionId = `${SESSION_ID_MARKER}-${FIXTURE_TAG}-spread`;
  const events: Event[] = [];
  let ordinal = 0;
  let ts = DAY + 200 * MINUTE;
  for (let i = 0; i < SPREAD_CALLS_PER_TOOL * SPREAD_TOOLS.length; i++) {
    const tool = SPREAD_TOOLS[i % SPREAD_TOOLS.length] ?? 'read_file';
    const callId = `call_spread_${i}`;
    events.push(
      event({
        source,
        sessionId,
        ordinal: ordinal++,
        ts: ts,
        role: 'user',
        kind: 'message',
        text: `next file ${i}`,
        meta: { fixture: true },
        refs: REFS,
      }),
      event({
        source,
        sessionId,
        ordinal: ordinal++,
        ts: ts + 30_000,
        role: 'assistant',
        kind: 'tool_call',
        tool: { name: tool, argsSummary: `{"target":"${PROJECT_DIR}/src/f${i}.ts"}` },
        meta: { toolCallId: callId },
        refs: REFS,
      }),
      event({
        source,
        sessionId,
        ordinal: ordinal++,
        ts: ts + 60_000,
        role: 'tool',
        kind: 'tool_result',
        text: 'ok',
        tool: { name: tool, ok: true },
        meta: { toolCallId: callId },
        refs: REFS,
      }),
    );
    ts += 2 * MINUTE;
  }
  return events;
}

/** The planted long loop, then the planted rewrite (still tool traffic). */
function loopAndRewriteSession(): Event[] {
  const source = 'fixture-a';
  const sessionId = `${SESSION_ID_MARKER}-${FIXTURE_TAG}-loop`;
  const events: Event[] = [];
  let ordinal = 0;
  events.push(
    event({
      source,
      sessionId,
      ordinal: ordinal++,
      ts: DAY + 120 * MINUTE,
      role: 'user',
      kind: 'message',
      text: 'keep going until it passes',
      meta: { fixture: true },
      refs: REFS,
    }),
  );
  for (let i = 0; i < LOOP_PAIRS; i++) {
    const callId = `call_loop_${i}`;
    events.push(
      event({
        source,
        sessionId,
        ordinal: ordinal++,
        ts: DAY + (121 + i) * MINUTE,
        role: 'assistant',
        kind: 'tool_call',
        tool: { name: 'exec_command', argsSummary: `{"cmd":"step ${i}"}` },
        meta: { toolCallId: callId },
        refs: REFS,
      }),
      event({
        source,
        sessionId,
        ordinal: ordinal++,
        ts: DAY + (121 + i) * MINUTE + 30_000,
        role: 'tool',
        kind: 'tool_result',
        text: `step ${i} ok`,
        tool: { name: 'exec_command', ok: true },
        meta: { toolCallId: callId },
        refs: REFS,
      }),
    );
  }
  // Reasoning events: fixture-a must out-reason fixture-b by more than
  // REASONING_PP so the contrast is exercised.
  for (let i = 0; i < 20; i++) {
    events.push(
      event({
        source,
        sessionId,
        ordinal: ordinal++,
        ts: DAY + (200 + i) * MINUTE,
        role: 'assistant',
        kind: 'reasoning',
        text: `thinking about step ${i}`,
        meta: { fixture: true },
        refs: REFS,
      }),
    );
  }
  // The rewrite: 3 writes to one path, 2 distinct contents, last === first.
  const contents = ['version one', 'version two', 'version one'];
  for (let i = 0; i < contents.length; i++) {
    const callId = `call_write_${i}`;
    events.push(
      event({
        source,
        sessionId,
        ordinal: ordinal++,
        ts: DAY + (300 + i * 2) * MINUTE,
        role: 'assistant',
        kind: 'tool_call',
        tool: { name: 'write_file', argsSummary: `{"path":"${REWRITE_PATH}","content":"${contents[i]}"}` },
        meta: { toolCallId: callId },
        refs: REFS,
      }),
      event({
        source,
        sessionId,
        ordinal: ordinal++,
        ts: DAY + (301 + i * 2) * MINUTE,
        role: 'tool',
        kind: 'tool_result',
        text: 'ok',
        tool: { name: 'write_file', ok: true },
        meta: { toolCallId: callId },
        refs: REFS,
      }),
    );
  }
  return events;
}

/** Ends on a failed tool_result — the planted abandonment. */
function abandonedSession(): Event[] {
  const source = 'fixture-b';
  const sessionId = `${SESSION_ID_MARKER}-${FIXTURE_TAG}-abandoned`;
  const events: Event[] = [];
  let ordinal = 0;
  const callId = 'call_abandon';
  events.push(
    event({
      source,
      sessionId,
      ordinal: ordinal++,
      ts: DAY + 400 * MINUTE,
      role: 'user',
      kind: 'message',
      text: 'try the migration',
      meta: { fixture: true },
      refs: REFS,
    }),
    event({
      source,
      sessionId,
      ordinal: ordinal++,
      ts: DAY + 401 * MINUTE,
      role: 'assistant',
      kind: 'tool_call',
      tool: { name: 'exec_command', argsSummary: '{"cmd":"migrate up"}' },
      meta: { toolCallId: callId },
      refs: REFS,
    }),
    event({
      source,
      sessionId,
      ordinal: ordinal++,
      ts: DAY + 402 * MINUTE,
      role: 'tool',
      kind: 'tool_result',
      text: 'migration failed',
      tool: { name: 'exec_command', ok: false },
      meta: { toolCallId: callId },
      refs: REFS,
    }),
  );
  return events;
}

/** The search target: a unique term plus a CJK term, in one authored message. */
function searchSession(): { events: Event[]; eventId: string } {
  const source = 'fixture-b';
  const sessionId = `${SESSION_ID_MARKER}-${FIXTURE_TAG}-search`;
  const answer = event({
    source,
    sessionId,
    ordinal: 1,
    ts: DAY + 500 * MINUTE,
    role: 'assistant',
    kind: 'message',
    text: `the ${SEARCH_TERM} loop is the bug — ${SEARCH_CJK} also shows it`,
    meta: { fixture: true },
    refs: REFS,
  });
  return {
    events: [
      event({
        source,
        sessionId,
        ordinal: 0,
        ts: DAY + 499 * MINUTE,
        role: 'user',
        kind: 'message',
        text: 'what is wrong with the parser?',
        meta: { fixture: true },
        refs: REFS,
      }),
      answer,
    ],
    eventId: answer.id,
  };
}

export interface Phase2Fixture {
  events: Event[];
  expected: Phase2Expectations;
}

export function buildPhase2Fixture(): Phase2Fixture {
  const repeat = repeatFailureSession();
  const clean = cleanSession();
  const spread = spreadSession();
  const loop = loopAndRewriteSession();
  const abandoned = abandonedSession();
  const search = searchSession();
  const events = [...repeat, ...clean, ...spread, ...loop, ...abandoned, ...search.events];

  // Counts kept as literals with the arithmetic in the docblock above; the
  // gate asserts these against the computed values so a drift in either the
  // fixture or a detector is caught rather than accommodated.
  const aCalls = 6 + LOOP_PAIRS + 3;
  const aEvents = 13 + 121 + 20 + 6;
  const bEvents = 11 + SPREAD_CALLS_PER_TOOL * SPREAD_TOOLS.length * 3 + 3 + 2;
  const bCalls = 5 + SPREAD_CALLS_PER_TOOL * SPREAD_TOOLS.length + 1;

  return {
    events,
    expected: {
      totals: { events: events.length, sessions: 6 },
      repeatFailure: { tool: REPEAT_TOOL, count: REPEAT_COUNT, sessions: 1 },
      longLoop: { runPairs: EXPECTED_LOOP_RUN, findings: 1 },
      rewrites: { findings: 1, exactRevert: 1 },
      abandoned: 1,
      compare: {
        sources: 2,
        a: {
          source: 'fixture-a',
          events: aEvents,
          sessions: 2,
          toolCalls: aCalls,
          topTool: 'exec_command',
          topShare: 64 / aCalls,
          reasoningShare: 20 / aEvents,
          failureRate: 5 / aCalls,
        },
        b: {
          source: 'fixture-b',
          events: bEvents,
          sessions: 4,
          toolCalls: bCalls,
          topTool: 'read_file',
          topShare: (4 + SPREAD_CALLS_PER_TOOL) / bCalls,
          reasoningShare: 0,
          failureRate: 1 / bCalls,
        },
      },
      search: { term: SEARCH_TERM, eventId: search.eventId },
    },
  };
}
