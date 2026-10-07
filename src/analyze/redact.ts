/**
 * Matching is boundary-aware: '/Users/volcanic' becomes '~' only when the
 * prefix is followed by '/' or by a character that cannot continue a path
 * segment, so a sibling like '/Users/volcanic2' or '/Users/volcanic-dev' is
 * left alone rather than mangled into '~2'.
 *
 * The "cannot continue a segment" set matters more than it looks. Phase 1 only
 * accepted '/' or end-of-string, which missed the most common shape of all —
 * a home path inside a shell command: `cd /Users/volcanic && ls`, or a JSON
 * argument `{"cwd":"/Users/volcanic"}`. Search snippets surface exactly those
 * strings (Phase 2), so the rule is now: the prefix is a complete path token
 * when what follows is not a path-segment character [A-Za-z0-9._-].
 */

import { homedir } from 'node:os';

/** The actual home prefix on this machine. The single audited constant. */
export const HOME_REDACTION = '/Users/volcanic';

/** What the home prefix is replaced with. */
export const HOME_LABEL = '~';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceBoundaryAware(value: string, prefix: string): string {
  if (prefix.length < 2 || !value.includes(prefix)) return value;
  // Replace when the prefix is followed by end-of-string or by any character
  // that cannot continue a path segment. '/' qualifies (it is not a segment
  // character), so the original 'prefix + /' rule is a subset of this one.
  const pattern = new RegExp(`${escapeRegExp(prefix)}(?=$|[^A-Za-z0-9._-])`, 'g');
  return value.replace(pattern, HOME_LABEL);
}

export function redactHome(value: string): string {
  let out = replaceBoundaryAware(value, HOME_REDACTION);
  // Defense in depth: if this ever runs with a different $HOME than the
  // constant above, redact that too rather than trusting the environment.
  const home = homedir();
  if (home !== HOME_REDACTION) out = replaceBoundaryAware(out, home);
  return out;
}

/** The username token (final path segment), e.g. 'volcanic'. */
export function usernameToken(): string {
  const parts = HOME_REDACTION.split('/').filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? '';
}

/** True when the string still contains an unredacted home prefix. */
export function containsHomePrefix(value: string): boolean {
  return value.includes(HOME_REDACTION) || (homedir() !== HOME_REDACTION && value.includes(homedir()));
}

/**
 * Last line of defense before anything is written out (HTML, CSS, JS): throws
 * if an absolute home path survived into the artifact.
 */
export function assertRedacted(value: string, context: string): void {
  if (containsHomePrefix(value)) {
    throw new Error(`${context}: unredacted home path reached the output boundary`);
  }
}

/**
 * Identifier shapes that must never appear in a shareable artifact.
 *
 * `SESSION_ID_PATTERN` is deliberately id-SHAPED, not the bare substring
 * 'sess': a report is full of the English word "sessions", and a check that
 * rejects that word would force the report to stop describing its own
 * subject. What it rejects is a session key in the forms the adapters
 * actually produce — `sess_…`, `sess-…`, `sessid…` — plus the `{source}:{id}`
 * pairing the CLI prints. `UUID_PATTERN` catches raw uuids (Claude Code's
 * session and event ids, Codex rollout ids) wherever they appear.
 *
 * A first line of defense is worth less than an exact one, so callers with
 * access to the real keys should ALSO assert none of them appear as
 * substrings (see scripts/verify-phase2.ts, which does exactly that).
 */
export const SESSION_ID_PATTERN = /\bsess[_-][A-Za-z0-9_-]+|\bsessid[A-Za-z0-9_-]*/i;

export const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

/** True when `value` carries a home path or an identifier-shaped token. */
export function containsLeak(value: string): boolean {
  return containsHomePrefix(value) || SESSION_ID_PATTERN.test(value) || UUID_PATTERN.test(value);
}

/**
 * Throws unless `value` is free of home paths and identifier-shaped tokens.
 * Used on every shareable artifact (the markdown report).
 */
export function assertNoIdentifiers(value: string, context: string): void {
  if (containsHomePrefix(value)) {
    throw new Error(`${context}: unredacted home path reached the output boundary`);
  }
  const session = SESSION_ID_PATTERN.exec(value);
  if (session !== null) {
    throw new Error(`${context}: session-id-shaped token "${session[0]}" reached the output boundary`);
  }
  const uuid = UUID_PATTERN.exec(value);
  if (uuid !== null) {
    throw new Error(`${context}: uuid-shaped token "${uuid[0]}" reached the output boundary`);
  }
}
