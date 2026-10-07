/**
 * Vocabulary — the *what* of the portrait.
 *
 * Terms come from AUTHORED conversation only (user/assistant messages — see
 * termsOfEvent in tokenize.ts). Folding in tool_result text would turn the
 * word list into a frequency table of terminal output: on this machine the
 * tool channel carries 30 MB against 5.5 MB of authored text.
 *
 * Tool usage and the kind distribution are counted over ALL events of the
 * selected sessions, because "the tool I reached for" is equally meaningful
 * on tool_result events, and the kind mix is the honest denominator of what
 * the corpus contains.
 *
 * Counts are term occurrences (a term repeated three times in one message
 * counts three times), which is what the drift comparison needs to see a
 * change of emphasis rather than a change of message volume.
 */

import type { Event, EventKind } from '../core/event.ts';
import { matchesClassFilter, type ClassFilter } from './classify.ts';
import type { Session } from './session.ts';
import { termsOfEvent, tokenize } from './tokenize.ts';

export interface TermCount {
  readonly term: string;
  readonly count: number;
}

export interface ToolCount {
  readonly name: string;
  readonly count: number;
}

export interface Vocabulary {
  readonly topTerms: readonly TermCount[];
  readonly topTools: readonly ToolCount[];
  readonly kindCounts: Readonly<Partial<Record<EventKind, number>>>;
  readonly totalTerms: number;
  readonly distinctTerms: number;
  readonly totalEvents: number;
  readonly userMessages: number;
  readonly assistantMessages: number;
  /** Total characters of authored text — the corpus size behind the terms. */
  readonly authoredChars: number;
}

/** Events of the matching sessions, in session order. */
export function eventsFor(sessions: readonly Session[], filter: ClassFilter): Event[] {
  const events: Event[] = [];
  for (const session of sessions) {
    if (!matchesClassFilter(session.cls, filter)) continue;
    for (const event of session.events) events.push(event);
  }
  return events;
}

export function computeVocabulary(sessions: readonly Session[], filter: ClassFilter, topN: number): Vocabulary {
  const termCounts = new Map<string, number>();
  let totalTerms = 0;
  const toolCounts = new Map<string, number>();
  const kindCounts: Partial<Record<EventKind, number>> = {};
  let totalEvents = 0;
  let userMessages = 0;
  let assistantMessages = 0;
  let authoredChars = 0;

  for (const event of eventsFor(sessions, filter)) {
    totalEvents += 1;
    kindCounts[event.kind] = (kindCounts[event.kind] ?? 0) + 1;

    for (const [term, count] of termsOfEvent(event)) {
      termCounts.set(term, (termCounts.get(term) ?? 0) + count);
      totalTerms += count;
    }
    if ((event.role === 'user' || event.role === 'assistant') && event.kind === 'message' && event.text !== undefined) {
      authoredChars += event.text.length;
      if (event.role === 'user') userMessages += 1;
      else assistantMessages += 1;
    }
    if (event.kind === 'tool_call' && event.tool !== undefined && event.tool.name.length > 0) {
      toolCounts.set(event.tool.name, (toolCounts.get(event.tool.name) ?? 0) + 1);
    }
  }

  return {
    topTerms: topEntries(termCounts, topN).map(([term, count]) => ({ term, count })),
    topTools: topEntries(toolCounts, topN).map(([name, count]) => ({ name, count })),
    kindCounts,
    totalTerms,
    distinctTerms: termCounts.size,
    totalEvents,
    userMessages,
    assistantMessages,
    authoredChars,
  };
}

/**
 * Top-N entries of a count map, sorted count-desc then key-asc so the list is
 * deterministic when counts tie (they tie constantly at the tail).
 */
export function topEntries(counts: ReadonlyMap<string, number>, n: number): Array<[string, number]> {
  if (n <= 0) return [];
  const entries = [...counts.entries()].filter(([, count]) => count > 0);
  entries.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return entries.slice(0, n);
}

/** Number of tokens in one text (used for message-length stats). */
export function termCountOf(text: string): number {
  return tokenize(text).length;
}
