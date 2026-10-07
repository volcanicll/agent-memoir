/**
 * Tokenizer tests — the CJK/A latin split is the part most likely to rot,
 * because its failure mode (a whitespace split over Chinese text) looks like
 * "fewer terms" rather than an error.
 */

import { describe, expect, test } from 'bun:test';
import { tokenize } from '../src/analyze/tokenize.ts';

describe('tokenize', () => {
  test('CJK runs become overlapping bigrams', () => {
    expect(tokenize('数据管线')).toEqual(['数据', '据管', '管线']);
  });

  test('a single CJK character survives as a unigram when meaningful', () => {
    // 猫 is not a stop character, so the one-character run is kept.
    expect(tokenize('猫')).toEqual(['猫']);
  });

  test('CJK punctuation and whitespace split runs', () => {
    expect(tokenize('部署，完成。')).toEqual(['部署', '完成']);
  });

  test('function characters are dropped as unigrams', () => {
    expect(tokenize('的')).toEqual([]);
  });

  test('a bigram made of two function characters is dropped', () => {
    expect(tokenize('的话')).toEqual([]);
  });

  test('a bigram pairing a function char with a content char is kept', () => {
    // 「数」content + 「据」content; assert a mixed case stays: 完成.
    expect(tokenize('已完成')).toEqual(['已完', '完成']);
    expect(tokenize('他的猫')).toContain('的猫');
  });

  test('Latin words split on word boundaries, lowercase, no single letters', () => {
    expect(tokenize('Deploy the SQLite Store')).toEqual(['deploy', 'sqlite', 'store']);
  });

  test('identifiers and dotted names survive as one term', () => {
    expect(tokenize('run tool_call via v4.1-flash')).toEqual(['run', 'tool_call', 'via', 'v4.1-flash']);
  });

  test('pure numbers are dropped', () => {
    expect(tokenize('123 456')).toEqual([]);
  });

  test('mixed CJK and Latin keeps both kinds of terms', () => {
    expect(tokenize('部署 deploy 完成')).toEqual(['部署', 'deploy', '完成']);
  });

  test('stop words and stop characters are filtered', () => {
    const terms = tokenize('the quick brown fox 的 的话');
    expect(terms).not.toContain('the');
    expect(terms).not.toContain('的话');
  });

  test('hiragana and katakana segment like Han', () => {
    expect(tokenize('テスト')).toEqual(['テス', 'スト']);
  });
});
