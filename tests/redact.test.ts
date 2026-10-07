/**
 * Redaction tests — the single place the privacy rules are enforced in code,
 * so its failure mode (letting a shape through that later lands in a report)
 * is the one bug this project cannot ship.
 */

import { describe, expect, test } from 'bun:test';
import {
  assertNoIdentifiers,
  assertRedacted,
  containsHomePrefix,
  containsLeak,
  HOME_LABEL,
  HOME_REDACTION,
  redactHome,
  SESSION_ID_PATTERN,
  usernameToken,
  UUID_PATTERN,
} from '../src/analyze/redact.ts';

describe('redactHome', () => {
  test('replaces the home prefix with ~ at a path boundary', () => {
    expect(redactHome(`${HOME_REDACTION}/codespace/x`)).toBe('~/codespace/x');
    expect(redactHome(`cd ${HOME_REDACTION} && ls`)).toBe('cd ~ && ls');
  });

  test('leaves a sibling directory alone', () => {
    expect(redactHome('/Users/volcanic2/x')).toBe('/Users/volcanic2/x');
  });

  test('is idempotent', () => {
    const once = redactHome(`${HOME_REDACTION}/a/b`);
    expect(redactHome(once)).toBe(once);
  });

  test('reports and throws on what it did not catch', () => {
    expect(containsHomePrefix(`${HOME_REDACTION}/x`)).toBe(true);
    expect(containsHomePrefix('~/x')).toBe(false);
    expect(() => assertRedacted(`${HOME_REDACTION}/x`, 'test')).toThrow();
    expect(() => assertRedacted('~/x', 'test')).not.toThrow();
  });

  test('usernameToken is the final path segment', () => {
    expect(usernameToken()).toBe(HOME_REDACTION.split('/').filter(Boolean).pop());
    expect(HOME_LABEL).toBe('~');
  });
});

describe('new Phase 2 identifier rules', () => {
  test('SESSION_ID_PATTERN catches the id shapes the adapters produce', () => {
    for (const value of ['sess_4ffd6703-43af', 'sess-abc123', 'sessidmarker', 'sessidmarker2-memoirfixture2']) {
      expect(SESSION_ID_PATTERN.test(value)).toBe(true);
    }
  });

  test('SESSION_ID_PATTERN does NOT reject the English word "session"', () => {
    // The report is about sessions; a rule that forbade the word itself would
    // make the report unable to describe its own subject.
    for (const value of ['sessions', 'session length', '513 sessions were human-driven']) {
      expect(SESSION_ID_PATTERN.test(value)).toBe(false);
    }
  });

  test('UUID_PATTERN matches a uuid and nothing shorter', () => {
    expect(UUID_PATTERN.test('b066ac1e-6593-4f0d-8b36-607dd6687e04')).toBe(true);
    expect(UUID_PATTERN.test('b066ac1e-6593')).toBe(false);
  });

  test('containsLeak combines every rule', () => {
    expect(containsLeak(`${HOME_REDACTION}/x`)).toBe(true);
    expect(containsLeak('sess_abc')).toBe(true);
    expect(containsLeak('b066ac1e-6593-4f0d-8b36-607dd6687e04')).toBe(true);
    expect(containsLeak('nothing to see, 513 sessions')).toBe(false);
  });

  test('assertNoIdentifiers throws on each leak shape with a reason', () => {
    expect(() => assertNoIdentifiers(`${HOME_REDACTION}/x`, 't')).toThrow(/home path/);
    expect(() => assertNoIdentifiers('id sess_deadbeef', 't')).toThrow(/session-id-shaped/);
    expect(() => assertNoIdentifiers('b066ac1e-6593-4f0d-8b36-607dd6687e04', 't')).toThrow(/uuid/);
    expect(() => assertNoIdentifiers('counts and ratios only', 't')).not.toThrow();
  });
});
