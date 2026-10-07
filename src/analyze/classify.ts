/**
 * Session classification — the honesty layer of the whole portrait.
 *
 * Measured on this machine: 92% of Hermes sessions are `cron`. An aggregate
 * drawn over raw totals is a portrait of a scheduler, not of a person, so
 * every aggregate in `src/analyze` takes a class filter and the rendered
 * portrait defaults to `interactive` only.
 *
 * The three classes are deliberately not symmetric:
 *
 *   automation  — machine-driven work. Two independent signals: the Hermes
 *                 session source is 'cron', or the session contains nothing
 *                 but tool traffic (no authored turn at all). Automation
 *                 wins over every other rule: a cron session usually DOES
 *                 carry `role: 'user'` events, but the prompt was written by
 *                 the scheduler, not by a human, so authorship cannot be
 *                 inferred from role alone.
 *   interactive — a session with at least one user-authored turn from a
 *                 source that is human-driven by construction (Hermes
 *                 telegram/cli/dingtalk/feishu/tui/acp; Claude Code and
 *                 Codex, whose transcripts only exist because a person ran
 *                 them). Sessions from an unknown Hermes source are NOT
 *                 assumed human: an unrecognized label is exactly the case
 *                 where guessing would be dishonest.
 *   other       — everything else: unlabeled sessions without an authored
 *                 turn, unknown sources, empty sessions. `other` is a real
 *                 bucket that is reported, never folded into the other two
 *                 and never silently dropped.
 *
 * Decision order is part of the contract and is pinned by tests.
 */

import type { Event } from '../core/event.ts';

export type SessionClass = 'interactive' | 'automation' | 'other';

/** Canonical order — stable output ordering for reports. */
export const SESSION_CLASSES: readonly SessionClass[] = ['interactive', 'automation', 'other'];

/** A class filter used by every aggregate. 'all' means no filtering. */
export type ClassFilter = SessionClass | 'all';

export const CLASS_FILTERS: readonly ClassFilter[] = ['all', 'interactive', 'automation', 'other'];

export function matchesClassFilter(cls: SessionClass, filter: ClassFilter): boolean {
  return filter === 'all' || cls === filter;
}

const HERMES_SOURCE = 'hermes';
/** Hermes session sources that exist only because a human opened them. */
const HUMAN_HERMES_SOURCES = new Set(['telegram', 'cli', 'dingtalk', 'feishu', 'tui', 'acp']);
/** Sources whose transcripts are human-driven by construction. */
const ALWAYS_HUMAN_DRIVEN = new Set(['claude-code', 'codex', 'opencode', 'pi', 'gemini', 'grok']);

/**
 * The Hermes session-source label ('cron', 'telegram', …), carried on every
 * Hermes event as `meta.source` by the hermes normalizer. Undefined for
 * non-Hermes sources, and undefined for structured labels: Codex also stores
 * a `source` field in its session_meta (a launch origin like 'vscode', or a
 * JSON blob describing a subagent thread), but it is per-FILE, and one
 * session's files can disagree — a single shell file would otherwise
 * mislabel a 2,799-event conversation as 'vscode'.
 */
export function sessionSourceLabel(events: readonly Event[]): string | undefined {
  const first = events[0];
  if (first === undefined || first.source !== 'hermes') return undefined;
  for (const event of events) {
    const label = event.meta.source;
    if (typeof label === 'string' && label.length > 0 && !label.startsWith('{')) return label;
  }
  return undefined;
}

/** A user-role message carrying non-empty text is the only authored signal. */
export function isAuthoredUserTurn(event: Event): boolean {
  if (event.role !== 'user' || event.kind !== 'message') return false;
  return typeof event.text === 'string' && event.text.trim().length > 0;
}

export function classifySession(events: readonly Event[]): SessionClass {
  if (events.length === 0) return 'other';

  // Rule 1: pure tool traffic — a machine talked to a machine.
  const toolOnly = events.every((event) => event.kind === 'tool_call' || event.kind === 'tool_result');
  if (toolOnly) return 'automation';

  const source = events[0]?.source;
  const label = sessionSourceLabel(events);

  // Rule 2: an explicitly scheduled session; its 'user' turns are prompts
  // written by a crontab, so they must not count as authored turns.
  if (source === HERMES_SOURCE && label === 'cron') return 'automation';

  // Rule 3: authored turn + a source that guarantees authorship.
  const humanDriven =
    source === HERMES_SOURCE
      ? label !== undefined && HUMAN_HERMES_SOURCES.has(label)
      : source !== undefined && ALWAYS_HUMAN_DRIVEN.has(source);
  if (humanDriven && events.some(isAuthoredUserTurn)) return 'interactive';

  return 'other';
}
