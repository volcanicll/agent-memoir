/**
 * Query-language tests — the parser is the boundary between a person's typing
 * and SQL, so its failure modes are the expensive ones: an unknown key that is
 * silently ignored, a filter that lands in the wrong field, a typo that looks
 * like a successful search.
 */

import { describe, expect, test } from 'bun:test';
import { describeQuery, isEmptyQuery, parseQuery, QueryError, SEARCH_KEYS } from '../src/search/query.ts';

function errorOf(input: string): QueryError {
  try {
    parseQuery(input);
  } catch (err) {
    if (err instanceof QueryError) return err;
    throw err;
  }
  throw new Error(`expected "${input}" to be rejected`);
}

describe('parseQuery', () => {
  test('an unknown key is an error, never a quiet free-text term', () => {
    const err = errorOf('sorce:hermes');
    expect(err.message).toContain('unknown filter');
    expect(err.message).toContain('source');
    expect(err.position).toBe(0);
  });

  test('an unknown key mid-query reports its real position', () => {
    const err = errorOf('apply_patch nope:1');
    expect(err.position).toBe('apply_patch '.length);
  });

  test('every supported key parses into its own field', () => {
    const query = parseQuery('source:hermes class:interactive project:~/a tool:Read kind:message after:2026-01-01 before:2026-02-01');
    expect(query.sources).toEqual(['hermes']);
    expect(query.classes).toEqual(['interactive']);
    expect(query.projects).toEqual(['~/a']);
    expect(query.tools).toEqual(['Read']);
    expect(query.kinds).toEqual(['message']);
    expect(query.after).not.toBeNull();
    expect(query.before).not.toBeNull();
    expect(query.terms).toEqual([]);
  });

  test('an empty value for any key is rejected', () => {
    for (const key of SEARCH_KEYS) {
      expect(() => parseQuery(`${key}:`)).toThrow(QueryError);
    }
  });

  test('bad class, kind and date values are rejected with the reason', () => {
    expect(errorOf('class:human').message).toContain('unknown class');
    expect(errorOf('kind:thought').message).toContain('unknown kind');
    expect(errorOf('after:2026-02-31').message).toContain('bad date');
    expect(errorOf('before:tuesday').message).toContain('bad date');
  });

  test('quotes hold a phrase, exactly', () => {
    const query = parseQuery('"npm run build" extra');
    expect(query.phrases).toEqual(['npm run build']);
    expect(query.terms).toEqual(['extra']);
  });

  test('a quoted value after a key stays one value', () => {
    const query = parseQuery('project:"~/work/proj a" tool:Read');
    expect(query.projects).toEqual(['~/work/proj a']);
    expect(query.tools).toEqual(['Read']);
  });

  test('an unterminated quote is an error, not a silent rest-of-string phrase', () => {
    expect(errorOf('"never closed').message).toContain('unterminated');
    expect(errorOf('project:"never closed').message).toContain('unterminated');
  });

  test('repeated filters accumulate (OR within a key)', () => {
    const query = parseQuery('source:hermes source:codex class:other class:automation');
    expect(query.sources).toEqual(['hermes', 'codex']);
    expect(query.classes).toEqual(['other', 'automation']);
  });

  test('free text is tokenized with the CJK-aware tokenizer', () => {
    expect(parseQuery('数据管线').terms).toEqual(['数据', '据管', '管线']);
    expect(parseQuery('Deploy SQLite').terms).toEqual(['deploy', 'sqlite']);
  });

  test('words the tokenizer discards are reported, not hidden', () => {
    const query = parseQuery('apply_patch the a 42');
    expect(query.terms).toEqual(['apply_patch']);
    expect(query.droppedTerms).toEqual(['the', 'a', '42']);
    expect(query.hasFreeText).toBe(true);
  });

  test('a pasted URL is free text, not an unknown filter', () => {
    const query = parseQuery('https://example.com/a');
    expect(query.terms).toContain('example.com');
    expect(query.phrases).toEqual([]);
  });

  test('a non-scheme colon word is still an unknown-filter error', () => {
    expect(errorOf('foo:bar').message).toContain('unknown filter');
  });

  test('an inverted date range is rejected rather than returning nothing', () => {
    const err = errorOf('after:2026-05-02 before:2026-05-01');
    expect(err.message).toContain('empty time range');
  });

  test('isEmptyQuery is true only when nothing at all was said', () => {
    expect(isEmptyQuery(parseQuery(''))).toBe(true);
    expect(isEmptyQuery(parseQuery('   '))).toBe(true);
    expect(isEmptyQuery(parseQuery('source:hermes'))).toBe(false);
    expect(isEmptyQuery(parseQuery('"phrase"'))).toBe(false);
  });

  test('local date bounds follow local midnight, half-open', () => {
    const query = parseQuery('after:2026-03-01 before:2026-03-02');
    expect(query.after).toBe(new Date(2026, 2, 1, 0, 0, 0, 0).getTime());
    expect(query.before).toBe(new Date(2026, 2, 2, 0, 0, 0, 0).getTime());
  });
});

describe('describeQuery', () => {
  test('states what was understood, including discarded words', () => {
    const described = describeQuery(parseQuery('apply_patch sorcex the'));
    expect(described).toContain('apply_patch');
    expect(described).toContain('the');
    expect(described).toContain('relevance');
  });

  test('falls back to recency order when there is no free text', () => {
    expect(describeQuery(parseQuery('kind:message'))).toContain('recency');
  });

  test('mentions a CLI class filter that is not in the query', () => {
    expect(describeQuery(parseQuery('apply_patch'), 'interactive')).toContain('interactive');
  });
});
