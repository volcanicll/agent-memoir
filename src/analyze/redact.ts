/**
 * Single-point home redaction — the one place the real username appears.
 *
 * Every displayed path in the analysis output, the rendered site, and the
 * Insight export must pass through `redactHome()`. Keeping the literal in
 * exactly one constant means auditing the privacy story is one grep: if
 * HOME_REDACTION is the only occurrence of the username in the tree, there is
 * exactly one thing that can leak it.
 *
 * Matching is boundary-aware: '/Users/volcanic' becomes '~' only when the
 * prefix is followed by '/' or end-of-string, so a sibling like
 * '/Users/volcanic2' is left alone rather than mangled into '~2'.
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
  return value.replace(new RegExp(`${escapeRegExp(prefix)}(?=/|$)`, 'g'), HOME_LABEL);
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
