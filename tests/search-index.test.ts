/**
 * Search-engine tests: the index/pairing behaviour that lives below the query
 * parser — snippets for matches in non-text fields, index freshness, and the
 * phrase path that deliberately bypasses the token index.
 */

import { describe, expect, test } from 'bun:test';
import { buildSessions } from '../src/analyze/session.ts';
import type { Event } from '../src/core/event.ts';
import { ensureSearchIndex, snippet } from '../src/search/index.ts';
import { parseQuery } from '../src/search/query.ts';
import { MemoirStore } from '../src/store/sqlite.ts';
import { FIXTURE_TAG, SESSION_ID_MARKER, PROJECT_DIR } from '../scripts/fixtures/phase2-fixture.ts';

function storeOf(events: readonly Event[]): MemoirStore {
  const store = new MemoirStore(':memory:');
  store.appendMany(events);
  return store;
}

describe('snippet', () => {
  test('windows the text around the matched term', () => {
    const event: Event = {
      id: 'x:s:0',
      source: 'x',
      sessionId: 's',
      ordinal: 0,
      ts: 1,
      role: 'assistant',
      kind: 'message',
      text: `${'filler '.repeat(40)}the needle term appears here ${'tail '.repeat(40)}`,
      meta: {},
    };
    const found = snippet(event, parseQuery('needle'));
    expect(found.matched).toBe(true);
    expect(found.field).toBe('text');
    expect(found.text).toContain('needle');
    expect(found.text.length).toBeLessThan(event.text!.length);
  });

  test('falls through to tool args when the match is not in text', () => {
    const event: Event = {
      id: 'x:s:0',
      source: 'x',
      sessionId: 's',
      ordinal: 0,
      ts: 1,
      role: 'assistant',
      kind: 'tool_call',
      tool: { name: 'exec_command', argsSummary: '{"cmd":"rg --files | grep specialmarker"}' },
      meta: {},
    };
    const found = snippet(event, parseQuery('specialmarker'));
    expect(found.field).toBe('tool.args');
    expect(found.matched).toBe(true);
    expect(found.text).toContain('specialmarker');
  });

  test('falls through to meta when the match is only there', () => {
    const event: Event = {
      id: 'x:s:0',
      source: 'x',
      sessionId: 's',
      ordinal: 0,
      ts: 1,
      role: 'assistant',
      kind: 'message',
      meta: { note: 'metamarker inside meta' },
    };
    const found = snippet(event, parseQuery('metamarker'));
    expect(found.field).toBe('meta');
    expect(found.text).toContain('metamarker');
  });

  test('falls through to refs when only a path matches', () => {
    const event: Event = {
      id: 'x:s:0',
      source: 'x',
      sessionId: 's',
      ordinal: 0,
      ts: 1,
      role: 'assistant',
      kind: 'message',
      refs: { cwd: '/tmp/refmarker-project' },
      meta: {},
    };
    const found = snippet(event, parseQuery('refmarker'));
    expect(found.field).toBe('refs');
    expect(found.text).toContain('refmarker');
  });

  test('redacts the home prefix in what it returns', () => {
    const event: Event = {
      id: 'x:s:0',
      source: 'x',
      sessionId: 's',
      ordinal: 0,
      ts: 1,
      role: 'assistant',
      kind: 'tool_call',
      tool: { name: 'Read', argsSummary: '{"file_path":"/Users/volcanic/codespace/x/main.ts"}' },
      meta: {},
    };
    const found = snippet(event, parseQuery('main.ts'));
    expect(found.text).not.toContain('/Users/volcanic');
    expect(found.text).toContain('~/codespace/x/main.ts');
  });

  test('an unmatched event yields the head of its best field, flagged as unmatched', () => {
    const event: Event = {
      id: 'x:s:0',
      source: 'x',
      sessionId: 's',
      ordinal: 0,
      ts: 1,
      role: 'assistant',
      kind: 'tool_call',
      tool: { name: 'Read', argsSummary: '{"file_path":"/tmp/a.ts"}' },
      meta: {},
    };
    // A term that appears NOWHERE in this event, so no literal window exists
    // and the snippet must fall back to the head of a field.
    const found = snippet(event, parseQuery('sqlite'));
    expect(found.matched).toBe(false);
    expect(found.text.length).toBeGreaterThan(0);
  });
});

describe('ensureSearchIndex', () => {
  test('indexes every event once and is then reused', () => {
    const events = buildSessions;
    void events;
    const store = storeOf([
      { id: 'x:s:0', source: 'x', sessionId: 's', ordinal: 0, ts: 1, role: 'user', kind: 'message', text: 'hello world', meta: {} },
      { id: 'x:s:1', source: 'x', sessionId: 's', ordinal: 1, ts: 2, role: 'assistant', kind: 'message', text: 'goodbye', meta: {} },
    ]);
    try {
      const first = ensureSearchIndex(store);
      expect(first.indexed).toBe(2);
      const second = ensureSearchIndex(store);
      expect(second.reused).toBe(true);
      expect(second.indexed).toBe(0);
      // An incremental event is picked up without a rebuild.
      store.append({ id: 'x:s:2', source: 'x', sessionId: 's', ordinal: 2, ts: 3, role: 'user', kind: 'message', text: 'later', meta: {} });
      const third = ensureSearchIndex(store);
      expect(third.indexed).toBe(1);
      expect(third.reused).toBe(false);
    } finally {
      store.close();
    }
  });

  test('a schema-version change drops and rebuilds the index', () => {
    const store = storeOf([
      { id: 'x:s:0', source: 'x', sessionId: 's', ordinal: 0, ts: 1, role: 'user', kind: 'message', text: 'one', meta: {} },
    ]);
    try {
      ensureSearchIndex(store);
      store.db.query(`UPDATE search_state SET value = '0' WHERE key = 'schema_version'`).run();
      const rebuilt = ensureSearchIndex(store);
      expect(rebuilt.indexed).toBe(1);
    } finally {
      store.close();
    }
  });
});

describe('search over the fixture store', () => {
  test('phrase-only search finds an exact substring the tokenizer would split differently', async () => {
    const { buildPhase2Fixture } = await import('../scripts/fixtures/phase2-fixture.ts');
    const { search } = await import('../src/search/index.ts');
    const store = storeOf(buildPhase2Fixture().events);
    try {
      ensureSearchIndex(store);
      // "zephyrquux loop" spans a token boundary plus a space; the phrase path
      // checks raw substrings, so it must find it where the AND-of-terms path
      // alone could not promise word adjacency.
      const result = search(store, parseQuery('"zephyrquux loop"'), { skipIndexCheck: true });
      expect(result.hits.length).toBeGreaterThan(0);
      expect(result.hits[0]!.snippet).toContain('zephyrquux loop');
    } finally {
      store.close();
    }
  });

  test('search output never carries the raw home prefix in a snippet', async () => {
    const { buildPhase2Fixture, HOME_PREFIX } = await import('../scripts/fixtures/phase2-fixture.ts');
    const { search } = await import('../src/search/index.ts');
    const store = storeOf(buildPhase2Fixture().events);
    try {
      ensureSearchIndex(store);
      const result = search(store, parseQuery('fixture2'), { limit: 50, skipIndexCheck: true });
      expect(result.hits.length).toBeGreaterThan(0);
      for (const hit of result.hits) {
        expect(hit.snippet).not.toContain(HOME_PREFIX);
        expect(hit.event.id).toContain(SESSION_ID_MARKER); // local event ids are still exact
      }
      expect(PROJECT_DIR).toContain(HOME_PREFIX);
      expect(FIXTURE_TAG.length).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  });
});
