/**
 * Fixed synthetic fixture for `verify:portrait`.
 *
 * Deliberately NOT the machine's real data: the gate must produce the same
 * numbers on any day, on any machine. The fixture is built so every asserted
 * number is hand-computable, and it encodes the exact traps this phase was
 * warned about:
 *
 *   1. A cron session WITH user-role prompts (a scheduler writes those) —
 *      it must stay automation and must not leak into the interactive view.
 *   2. Quiet days. Days 3 and 7 carry cron traffic only, so the interactive
 *      day series has real zeros there while the all-sessions series has
 *      none. That contrast is the reason the class filter exists.
 *   3. One project (proj-a) whose events arrive through THREE cwds: the root,
 *      plus one-session children `packages/api` and `packages/web`. Children
 *      fold into the root.
 *   4. A deliberate drift: proj-a owns ~80% of the first half and ~20% of the
 *      second; proj-b mirrors it; tools swing Read → Bash; the vocabulary
 *      turns over alphaword → betaword.
 *
 * Layout — 10 local days, 2026-05-01 .. 2026-05-10. "A-heavy" = 48 proj-a
 * events (12 tool calls + 36 messages) + 12 proj-b events; "B-heavy" is the
 * reverse.
 *
 *   day  1  A-heavy + telegram a (2)                  interactive 62
 *   day  2  A-heavy, proj-a events via packages/api   interactive 60
 *   day  3  cron only (3)                             interactive  0  ← zero
 *   day  4  A-heavy                                   interactive 60
 *   day  5  A-heavy                                   interactive 60
 *   day  6  B-heavy                                   interactive 60
 *   day  7  cron only (3)                             interactive  0  ← zero
 *   day  8  B-heavy                                   interactive 60
 *   day  9  B-heavy, proj-a events via packages/web   interactive 60
 *   day 10  B-heavy + telegram b (2)                  interactive 62
 *
 * Derived by hand:
 *   interactive events  484   (8 days × 60 + 2 + 2)
 *   automation events     6   (2 cron sessions × 3)
 *   interactive sessions 18   (16 project sessions + 2 telegram)
 *   drift split         at index floor(484/2) = 242 = first event of day 6,
 *                       so the halves are exactly 242 / 242
 *   proj-a share        192/242 = 79.34% → 48/242 = 19.83%  (Δ ≈ −59.5pp)
 *   proj-b share        48/242  = 19.83% → 192/242 = 79.34% (Δ ≈ +59.5pp)
 *   tool Read share     48/64 = 75% → 16/64 = 25%  (Δ = −50pp)
 *   tool Bash share     16/64 = 25% → 48/64 = 75%  (Δ = +50pp)
 *   alphaword           176 occurrences, all first half  → 'gone'
 *   betaword            176 occurrences, all second half → 'new'
 *   interactive days     8 active of 10, longest streak 3, longest gap 1
 *   all-session days    10 active of 10, longest streak 10, longest gap 0
 */

import { makeEventId, type Event } from '../../src/core/event.ts';

export const FIXTURE_TAG = 'memoirfixture';
/** Token embedded in every fixture session id; the gate asserts it never
 *  reaches the rendered site. */
export const SESSION_ID_MARKER = 'sessidmarker';

export const PROJECT_A_ROOT = '/Users/volcanic/work/proj-a';
export const PROJECT_A_API = `${PROJECT_A_ROOT}/packages/api`;
export const PROJECT_A_WEB = `${PROJECT_A_ROOT}/packages/web`;
export const PROJECT_B_ROOT = '/Users/volcanic/work/proj-b';
export const PROJECT_A_REDACTED = '~/work/proj-a';

const YEAR = 2026;
const MONTH = 5; // May

/** Events per category on an "A-heavy" day. */
export const A_HEAVY = { aToolCalls: 12, aMessages: 36, bToolCalls: 4, bMessages: 8 };
export const B_HEAVY = { aToolCalls: 4, aMessages: 8, bToolCalls: 12, bMessages: 36 };
export const READ_TOOL = 'Read';
export const BASH_TOOL = 'Bash';
export const A_WORD = 'alphaword';
export const B_WORD = 'betaword';

interface DayPlan {
  day: number;
  /** 'a' = A-heavy day, 'b' = B-heavy day. */
  heavy: 'a' | 'b';
  /** cwd the proj-a events of this day use. */
  aCwd: string;
  /** Cron-only day: no main stream, no telegram — the day is machine-only. */
  cron?: boolean;
  telegram?: boolean;
}

const PLAN: readonly DayPlan[] = [
  { day: 1, heavy: 'a', aCwd: PROJECT_A_ROOT, telegram: true },
  { day: 2, heavy: 'a', aCwd: PROJECT_A_API },
  { day: 3, heavy: 'a', aCwd: PROJECT_A_ROOT, cron: true },
  { day: 4, heavy: 'a', aCwd: PROJECT_A_ROOT },
  { day: 5, heavy: 'a', aCwd: PROJECT_A_ROOT },
  { day: 6, heavy: 'b', aCwd: PROJECT_A_ROOT },
  { day: 7, heavy: 'b', aCwd: PROJECT_A_ROOT, cron: true },
  { day: 8, heavy: 'b', aCwd: PROJECT_A_ROOT },
  { day: 9, heavy: 'b', aCwd: PROJECT_A_WEB },
  { day: 10, heavy: 'b', aCwd: PROJECT_A_ROOT, telegram: true },
];

function at(day: number, hour: number, minute: number): number {
  return new Date(YEAR, MONTH - 1, day, hour, minute, 0, 0).getTime();
}

interface ProjectEventOptions {
  sessionId: string;
  source: string;
  ordinal: number;
  ts: number;
  cwd: string;
  kind: 'message' | 'tool_call';
  text?: string;
  toolName?: string;
  role?: 'user' | 'assistant';
}

function projectEvent(options: ProjectEventOptions): Event {
  const event: Event = {
    id: makeEventId(options.source, options.sessionId, options.ordinal),
    source: options.source,
    sessionId: options.sessionId,
    ordinal: options.ordinal,
    ts: options.ts,
    role: options.role ?? (options.kind === 'tool_call' ? 'assistant' : 'user'),
    kind: options.kind,
    meta: {},
    refs: { cwd: options.cwd, model: 'fixture-model' },
  };
  if (options.text !== undefined) event.text = options.text;
  if (options.kind === 'tool_call') event.tool = { name: options.toolName ?? 'unknown' };
  return event;
}

export interface FixtureExpectations {
  readonly spanDays: number;
  readonly totals: { readonly events: number; readonly sessions: number };
  readonly interactive: { readonly sessions: number; readonly events: number };
  readonly automation: { readonly sessions: number; readonly events: number };
  /** Interactive event counts per day, 2026-05-01 .. 2026-05-10. */
  readonly interactiveDayCounts: readonly number[];
  /** All-session event counts per day (cron fills days 3 and 7). */
  readonly allDayCounts: readonly number[];
  readonly interactiveStreak: number;
  readonly interactiveGap: number;
  readonly interactiveActiveDays: number;
  readonly allStreak: number;
  readonly allGap: number;
  readonly projectA: { readonly sessions: number; readonly cwds: number; readonly events: number };
  readonly projectB: { readonly sessions: number; readonly events: number };
  /** Telegram sessions land in the unlocated bucket (no cwd). */
  readonly unlocatedInteractiveSessions: number;
  readonly drift: {
    readonly eventsBefore: number;
    readonly eventsAfter: number;
    readonly projectADeltaPp: number;
    readonly projectBDeltaPp: number;
    readonly bashDeltaPp: number;
    readonly readDeltaPp: number;
  };
  readonly topTerm: { readonly term: string; readonly count: number };
  readonly goneTerm: string;
  readonly newTerm: string;
}

export const EXPECTED: FixtureExpectations = {
  spanDays: 10,
  totals: { events: 490, sessions: 20 },
  interactive: { sessions: 18, events: 484 },
  automation: { sessions: 2, events: 6 },
  interactiveDayCounts: [62, 60, 0, 60, 60, 60, 0, 60, 60, 62],
  allDayCounts: [62, 60, 3, 60, 60, 60, 3, 60, 60, 62],
  interactiveStreak: 3,
  interactiveGap: 1,
  interactiveActiveDays: 8,
  allStreak: 10,
  allGap: 0,
  projectA: { sessions: 8, cwds: 3, events: 240 },
  projectB: { sessions: 8, events: 240 },
  unlocatedInteractiveSessions: 2,
  drift: {
    eventsBefore: 242,
    eventsAfter: 242,
    // 192/242 → 48/242, in percentage points.
    projectADeltaPp: (48 / 242) * 100 - (192 / 242) * 100,
    projectBDeltaPp: (192 / 242) * 100 - (48 / 242) * 100,
    bashDeltaPp: 50,
    readDeltaPp: -50,
  },
  topTerm: { term: A_WORD, count: 176 },
  goneTerm: A_WORD,
  newTerm: B_WORD,
};

/**
 * Build the fixture. Pure and deterministic: the same events come out on
 * every call, on every machine, in local time.
 */
export function buildPortraitFixture(): { events: Event[]; expected: FixtureExpectations } {
  const events: Event[] = [];

  for (const plan of PLAN) {
    if (plan.cron) {
      // A scheduler-driven session that DOES carry a user-role prompt — which
      // is exactly why authorship cannot be inferred from role alone.
      const sessionId = `${SESSION_ID_MARKER}-${FIXTURE_TAG}-cron-${plan.day}`;
      events.push({
        id: makeEventId('hermes', sessionId, 0),
        source: 'hermes',
        sessionId,
        ordinal: 0,
        ts: at(plan.day, 3, 0),
        role: 'user',
        kind: 'message',
        text: 'scheduled maintenance sweep',
        meta: { source: 'cron' },
      });
      events.push({
        id: makeEventId('hermes', sessionId, 1),
        source: 'hermes',
        sessionId,
        ordinal: 1,
        ts: at(plan.day, 3, 1),
        role: 'assistant',
        kind: 'message',
        text: 'sweep complete',
        meta: { source: 'cron' },
      });
      events.push({
        id: makeEventId('hermes', sessionId, 2),
        source: 'hermes',
        sessionId,
        ordinal: 2,
        ts: at(plan.day, 3, 2),
        role: 'tool',
        kind: 'tool_result',
        text: 'ok',
        tool: { name: 'exec_command' },
        meta: { source: 'cron' },
      });
      continue; // machine-only day: nothing else happens
    }

    if (plan.telegram) {
      const sessionId = `${SESSION_ID_MARKER}-${FIXTURE_TAG}-tg-${plan.day}`;
      events.push({
        id: makeEventId('hermes', sessionId, 0),
        source: 'hermes',
        sessionId,
        ordinal: 0,
        ts: at(plan.day, 8, 0),
        role: 'user',
        kind: 'message',
        text: plan.day === 1 ? '看一下部署脚本' : '把监控指标补齐',
        meta: { source: 'telegram' },
      });
      events.push({
        id: makeEventId('hermes', sessionId, 1),
        source: 'hermes',
        sessionId,
        ordinal: 1,
        ts: at(plan.day, 8, 5),
        role: 'assistant',
        kind: 'message',
        text: '好，我先看一遍。',
        meta: { source: 'telegram' },
      });
    }

    // Main stream: proj-a first, then proj-b, one event per minute from 09:00.
    const counts = plan.heavy === 'a' ? A_HEAVY : B_HEAVY;
    const word = plan.heavy === 'a' ? A_WORD : B_WORD;
    const aSession = `${SESSION_ID_MARKER}-${FIXTURE_TAG}-a-${plan.day}`;
    const bSession = `${SESSION_ID_MARKER}-${FIXTURE_TAG}-b-${plan.day}`;
    let minute = 0;
    let aOrdinal = 0;
    let bOrdinal = 0;
    for (let i = 0; i < counts.aToolCalls; i++) {
      events.push(
        projectEvent({
          sessionId: aSession,
          source: 'codex',
          ordinal: aOrdinal++,
          ts: at(plan.day, 9, minute++),
          cwd: plan.aCwd,
          kind: 'tool_call',
          toolName: READ_TOOL,
        }),
      );
    }
    for (let i = 0; i < counts.aMessages; i++) {
      events.push(
        projectEvent({
          sessionId: aSession,
          source: 'codex',
          ordinal: aOrdinal++,
          ts: at(plan.day, 9, minute++),
          cwd: plan.aCwd,
          kind: 'message',
          text: word,
          role: i % 2 === 0 ? 'user' : 'assistant',
        }),
      );
    }
    for (let i = 0; i < counts.bToolCalls; i++) {
      events.push(
        projectEvent({
          sessionId: bSession,
          source: 'codex',
          ordinal: bOrdinal++,
          ts: at(plan.day, 9, minute++),
          cwd: PROJECT_B_ROOT,
          kind: 'tool_call',
          toolName: BASH_TOOL,
        }),
      );
    }
    for (let i = 0; i < counts.bMessages; i++) {
      events.push(
        projectEvent({
          sessionId: bSession,
          source: 'codex',
          ordinal: bOrdinal++,
          ts: at(plan.day, 9, minute++),
          cwd: PROJECT_B_ROOT,
          kind: 'message',
          text: word,
          role: i % 2 === 0 ? 'user' : 'assistant',
        }),
      );
    }
  }

  return { events, expected: EXPECTED };
}
