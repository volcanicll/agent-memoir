/**
 * The search query language — small, hand-written, and deliberately honest.
 *
 * Why not SQL passthrough: this store holds a person's whole working history,
 * and the query string is typed by a human at a prompt. A passthrough would
 * turn a typo into an empty result set, and an injection into a way to read
 * columns the caller has no business seeing. The grammar here is closed:
 * seven filter keys, quoted phrases, and free text — nothing else reaches SQL.
 *
 * The rules, in full:
 *
 *   - `key:value` is a filter when the part before ':' looks like an
 *     identifier. An UNKNOWN key is a hard error, never a silent free-text
 *     term: `sorce:hermes` returning unfiltered results is the single most
 *     dishonest thing a search box can do, because the user cannot tell it
 *     happened. The error names the typo and suggests the intended key.
 *   - Repeated filters of the same key are OR-ed (`source:hermes
 *     source:codex`); different keys are AND-ed. A key's value may itself be
 *     quoted when it contains spaces: `project:"~/work/proj a"`.
 *   - `"quoted phrase"` is an exact substring, not a token query. It is
 *     enforced with a LIKE on the raw columns, so it finds text the
 *     tokenizer would have split (see search/index.ts for why both paths
 *     exist).
 *   - Free text is segmented by the CJK-aware tokenizer; every surviving
 *     term must match (AND). `数据管线` therefore becomes the bigram
 *     conjunction 数据 AND 据管 AND 管线, which is the standard
 *     dictionary-free reading of an unsegmented language.
 *   - A free-text word the tokenizer discards entirely (a stop word, a single
 *     Latin character, a pure number) is REPORTED in `droppedTerms` rather
 *     than dropped quietly; if nothing survives, the caller must say so
 *     instead of running a filter-only query the user did not ask for.
 *   - `after:`/`before:` are local calendar days, half-open: `after:D` is
 *     ts >= 00:00 local on D, `before:D` is ts < 00:00 local on D. Everything
 *     else in this project reads the clock in local time (see analyze/time.ts).
 */

import { type ClassFilter, type SessionClass, SESSION_CLASSES } from '../analyze/classify.ts';
import { tokenize } from '../analyze/tokenize.ts';
import type { EventKind } from '../core/event.ts';

/** The closed set of filter keys. Anything else with a colon is an error. */
export const SEARCH_KEYS = ['source', 'class', 'project', 'tool', 'kind', 'after', 'before'] as const;
export type SearchKey = (typeof SEARCH_KEYS)[number];

const SEARCH_KEY_SET: ReadonlySet<string> = new Set<string>(SEARCH_KEYS);

/** The kinds an Event may have — `kind:` accepts exactly these. */
const EVENT_KINDS: readonly EventKind[] = [
  'message',
  'tool_call',
  'tool_result',
  'reasoning',
  'session_start',
  'session_end',
];

const KEYS_WITH_SUGGESTION = [...SEARCH_KEYS];

export class QueryError extends Error {
  /** 0-based offset into the raw query where the problem starts. */
  readonly position: number;

  constructor(message: string, position: number) {
    super(message);
    this.name = 'QueryError';
    this.position = position;
  }
}

export interface ParsedQuery {
  readonly raw: string;
  /** Free-text terms, already tokenized; all of them must match. */
  readonly terms: readonly string[];
  /** Free-text words the tokenizer discarded, in input order. */
  readonly droppedTerms: readonly string[];
  /** Exact-substring phrases (kept case-sensitive in the raw form). */
  readonly phrases: readonly string[];
  /** OR-ed within the key. */
  readonly sources: readonly string[];
  readonly classes: readonly SessionClass[];
  readonly projects: readonly string[];
  readonly tools: readonly string[];
  readonly kinds: readonly EventKind[];
  /** Inclusive lower bound, epoch ms — local midnight of `after:`. */
  readonly after: number | null;
  /** Exclusive upper bound, epoch ms — local midnight of `before:`. */
  readonly before: number | null;
  /** True when free text was present, even if it tokenized to nothing. */
  readonly hasFreeText: boolean;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** Levenshtein distance, capped at 3 — only used to suggest a known key. */
function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 3) return 4;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min((current[j - 1] ?? 0) + 1, (previous[j] ?? 0) + 1, (previous[j - 1] ?? 0) + cost);
    }
    previous = current;
  }
  return previous[b.length] ?? 4;
}

function suggestKey(key: string): string {
  let best: string | null = null;
  let bestDistance = 3;
  for (const candidate of KEYS_WITH_SUGGESTION) {
    const distance = editDistance(key.toLowerCase(), candidate);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best === null ? '' : ` (did you mean "${best}:…"?)`;
}

/** Local midnight of a 'YYYY-MM-DD' string, or null when it is not a date. */
function localMidnight(text: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day, 0, 0, 0, 0);
  // Reject 2026-02-31 and friends: the constructor rolls them over silently.
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date.getTime();
}

interface Accumulator {
  terms: string[];
  droppedTerms: string[];
  phrases: string[];
  sources: string[];
  classes: SessionClass[];
  projects: string[];
  tools: string[];
  kinds: EventKind[];
  after: number | null;
  before: number | null;
  hasFreeText: boolean;
}

function applyFilter(acc: Accumulator, key: string, value: string, position: number): void {
  if (value.length === 0) {
    throw new QueryError(`empty value for "${key}:" — expected ${key}:<value>`, position);
  }
  switch (key) {
    case 'source':
      acc.sources.push(value.toLowerCase());
      return;
    case 'class': {
      const lower = value.toLowerCase();
      if (!(SESSION_CLASSES as readonly string[]).includes(lower)) {
        throw new QueryError(
          `unknown class "${value}" — expected one of ${SESSION_CLASSES.join('|')}`,
          position,
        );
      }
      acc.classes.push(lower as SessionClass);
      return;
    }
    case 'project':
      acc.projects.push(value);
      return;
    case 'tool':
      acc.tools.push(value);
      return;
    case 'kind': {
      if (!(EVENT_KINDS as readonly string[]).includes(value)) {
        throw new QueryError(`unknown kind "${value}" — expected one of ${EVENT_KINDS.join('|')}`, position);
      }
      acc.kinds.push(value as EventKind);
      return;
    }
    case 'after': {
      const ts = localMidnight(value);
      if (ts === null) throw new QueryError(`bad date "${value}" — expected after:YYYY-MM-DD`, position);
      acc.after = ts;
      return;
    }
    case 'before': {
      const ts = localMidnight(value);
      if (ts === null) throw new QueryError(`bad date "${value}" — expected before:YYYY-MM-DD`, position);
      acc.before = ts;
      return;
    }
    default:
      // Unreachable: applyFilter is only called after the key set check, but
      // an exhaustive default keeps the compiler and a future reader honest.
      throw new QueryError(`unknown filter "${key}"`, position);
  }
}

/**
 * True when the colon in `word` introduces a FILTER rather than being part of
 * a pasted URL. `http://example.com` must search for the URL, not fail with
 * "unknown filter http:" — a scheme is always followed by '//', and no filter
 * value ever starts that way.
 */
function looksLikeFilter(word: string, colon: number): boolean {
  if (colon <= 0) return false;
  if (!IDENTIFIER.test(word.slice(0, colon))) return false;
  return !word.startsWith('//', colon + 1);
}

function classifyWord(acc: Accumulator, word: string, position: number): void {
  const colon = word.indexOf(':');
  if (looksLikeFilter(word, colon)) {
    const key = word.slice(0, colon);
    if (!SEARCH_KEY_SET.has(key)) {
      throw new QueryError(`unknown filter "${key}:${word.slice(colon + 1)}"${suggestKey(key)}`, position);
    }
    applyFilter(acc, key, word.slice(colon + 1), position);
    return;
  }
  acc.hasFreeText = true;
  const words = tokenize(word);
  if (words.length === 0) {
    acc.droppedTerms.push(word);
    return;
  }
  for (const term of words) if (!acc.terms.includes(term)) acc.terms.push(term);
}

/**
 * Parse a query string. Throws QueryError with the offset of the problem so
 * the CLI can point at the offending word.
 */
export function parseQuery(input: string): ParsedQuery {
  const acc: Accumulator = {
    terms: [],
    droppedTerms: [],
    phrases: [],
    sources: [],
    classes: [],
    projects: [],
    tools: [],
    kinds: [],
    after: null,
    before: null,
    hasFreeText: false,
  };

  let i = 0;
  while (i < input.length) {
    const char = input[i] ?? '';
    if (/\s/.test(char)) {
      i++;
      continue;
    }
    const start = i;
    if (char === '"') {
      const end = input.indexOf('"', i + 1);
      if (end < 0) throw new QueryError('unterminated quote', start);
      const phrase = input.slice(i + 1, end);
      if (phrase.length === 0) throw new QueryError('empty quoted phrase', start);
      acc.phrases.push(phrase);
      i = end + 1;
      continue;
    }

    // A bare word, or key:value where value may be a quoted string.
    let end = i;
    while (end < input.length && !/\s/.test(input[end] ?? '')) end++;
    let word = input.slice(i, end);
    i = end;
    const colon = word.indexOf(':');
    if (looksLikeFilter(word, colon) && word[colon + 1] === '"') {
      const key = word.slice(0, colon);
      if (!SEARCH_KEY_SET.has(key)) {
        throw new QueryError(`unknown filter "${key}:…"${suggestKey(key)}`, start);
      }
      const quoteStart = start + colon + 1;
      const quoteEnd = input.indexOf('"', quoteStart + 1);
      if (quoteEnd < 0) throw new QueryError('unterminated quote', quoteStart);
      applyFilter(acc, key, input.slice(quoteStart + 1, quoteEnd), start);
      i = quoteEnd + 1;
      word = '';
    }
    if (word.length > 0) classifyWord(acc, word, start);
  }

  if (acc.after !== null && acc.before !== null && acc.after >= acc.before) {
    throw new QueryError(
      `empty time range: after:${new Date(acc.after).toISOString().slice(0, 10)} is not before before:${new Date(acc.before).toISOString().slice(0, 10)}`,
      0,
    );
  }

  return {
    raw: input,
    terms: acc.terms,
    droppedTerms: acc.droppedTerms,
    phrases: acc.phrases,
    sources: acc.sources,
    classes: acc.classes,
    projects: acc.projects,
    tools: acc.tools,
    kinds: acc.kinds,
    after: acc.after,
    before: acc.before,
    hasFreeText: acc.hasFreeText,
  };
}

/** True when the query has nothing to filter on at all. */
export function isEmptyQuery(query: ParsedQuery): boolean {
  return (
    query.terms.length === 0 &&
    query.phrases.length === 0 &&
    query.sources.length === 0 &&
    query.classes.length === 0 &&
    query.projects.length === 0 &&
    query.tools.length === 0 &&
    query.kinds.length === 0 &&
    query.after === null &&
    query.before === null
  );
}

function isoLocal(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number): string => (n < 10 ? `0${n}` : String(n));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * The line the CLI prints before its results. A mistyped query must be
 * visible, so this states what was actually understood — including the terms
 * the tokenizer threw away.
 */
export function describeQuery(query: ParsedQuery, classOption: ClassFilter | null = null): string {
  const parts: string[] = [];
  if (query.terms.length > 0) parts.push(`terms ${query.terms.join(' + ')}`);
  if (query.phrases.length > 0) parts.push(`phrase${query.phrases.length > 1 ? 's' : ''} ${query.phrases.map((p) => `"${p}"`).join(' + ')}`);
  if (query.sources.length > 0) parts.push(`source ${query.sources.join('|')}`);
  if (query.classes.length > 0) parts.push(`class ${query.classes.join('|')}`);
  if (query.projects.length > 0) parts.push(`project ${query.projects.join('|')}`);
  if (query.tools.length > 0) parts.push(`tool ${query.tools.join('|')}`);
  if (query.kinds.length > 0) parts.push(`kind ${query.kinds.join('|')}`);
  if (query.after !== null) parts.push(`after ${isoLocal(query.after)} 00:00 local`);
  if (query.before !== null) parts.push(`before ${isoLocal(query.before)} 00:00 local`);
  if (classOption !== null && classOption !== 'all' && query.classes.length === 0) {
    parts.push(`class ${classOption} (--class)`);
  }
  if (query.droppedTerms.length > 0) parts.push(`ignored ${query.droppedTerms.map((w) => `"${w}"`).join(' ')}`);
  const order = query.terms.length > 0 ? 'relevance' : 'recency';
  return parts.length === 0 ? `no filters · ordered by ${order}` : `${parts.join(' · ')} · ordered by ${order}`;
}
