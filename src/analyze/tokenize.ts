/**
 * CJK-aware tokenizer + stop-word filtering.
 *
 * The user writes Chinese, so a whitespace split is not a tokenizer — it is a
 * bug that hides most of the corpus behind a few enormous "words". This
 * module segments text into two kinds of runs with one regex pass:
 *
 *   - CJK runs (Han / Kana / Hangul). No dictionary is available without a
 *     dependency, so a run of two or more characters is broken into
 *     overlapping BIGRAMS: 「数据管线」→ 数据 / 据管 / 管线. Bigram indexing is
 *     the standard dictionary-free approach for Chinese retrieval and needs
 *     no segmented corpus; its known cost (slightly noisier terms) is
 *     acceptable for a portrait. A run of exactly one character is kept as a
 *     unigram when it is not a stop character.
 *   - Latin/digit runs on word boundaries: identifiers like `tool_call` and
 *     dotted names like `v4.1` survive intact, are lowercased, and single
 *     characters and pure numbers are dropped as noise.
 *
 * Stop words are filtered after segmentation. Terms equal to the username
 * token are dropped outright — a path inside conversation text tokenizes into
 * its segments ('Users', 'codespace', …), and the username segment is the one
 * that would keep showing up in a word list for no analytical reason.
 */

import type { Event } from '../core/event.ts';
import { usernameToken } from './redact.ts';

/** One regex pass over the text; alternation order matters (CJK first). */
const TOKEN_PATTERN =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[A-Za-z][A-Za-z0-9_]*(?:[.+#-][A-Za-z0-9_]+)*/gu;

const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** English function words — noise in any frequency list. */
const STOP_WORDS_EN: readonly string[] = [
  'a', 'about', 'after', 'again', 'against', 'all', 'also', 'am', 'an', 'and', 'any', 'are', 'as', 'at',
  'back', 'be', 'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but', 'by', 'can',
  'could', 'did', 'do', 'does', 'doing', 'done', 'down', 'during', 'each', 'even', 'ever', 'every',
  'few', 'for', 'from', 'further', 'get', 'go', 'going', 'got', 'had', 'has', 'have', 'having', 'he',
  'her', 'here', 'hers', 'him', 'his', 'how', 'if', 'in', 'into', 'is', 'it', 'its', 'just', 'know',
  'last', 'let', 'like', 'll', 'made', 'make', 'many', 'may', 'me', 'might', 'more', 'most', 'much',
  'must', 'my', 'need', 'new', 'no', 'not', 'now', 'of', 'off', 'on', 'once', 'one', 'only', 'or',
  'other', 'our', 'out', 'over', 'own', 'really', 're', 's', 'same', 'see', 'she', 'should', 'so',
  'some', 'still', 'such', 't', 'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these',
  'they', 'thing', 'things', 'this', 'those', 'through', 'to', 'too', 'under', 'until', 'up', 'us',
  'use', 'used', 'using', 've', 'very', 'want', 'was', 'we', 'well', 'were', 'what', 'when', 'where',
  'which', 'while', 'who', 'whom', 'why', 'will', 'with', 'within', 'without', 'would', 'yes', 'yet',
  'you', 'your', 'yours',
];

/** Chinese function characters — dropped as unigrams and as bigram parts. */
const STOP_CHARS_ZH: readonly string[] = [
  '的', '了', '是', '我', '你', '他', '她', '它', '们', '在', '有', '和', '与', '就', '都', '而', '及',
  '或', '个', '这', '那', '呢', '吗', '吧', '啊', '呀', '把', '被', '让', '给', '从', '到', '对', '能',
  '会', '要', '也', '还', '很', '太', '再', '又', '只', '才', '并', '但', '却', '若', '则', '于', '上',
  '下', '中', '内', '外', '前', '后', '里', '好', '不', '没', '无', '一', '二', '三', '四', '五', '六',
  '七', '八', '九', '十', '嘛', '哦', '嗯', '着', '过', '来', '去', '做', '说', '地', '得', '所', '以',
  '之', '其', '此', '且', '么', '什', '怎', '为', '可', '等', '该', '每', '各', '些', '如', '果', '因',
  '虽', '然', '者', '啦', '哈', '哇', '呗', '咯', '哎', '唉',
];

/** Chinese function words / bigrams that survive bigram segmentation. */
const STOP_WORDS_ZH: readonly string[] = [
  '我们', '你们', '他们', '她们', '这个', '那个', '这些', '那些', '什么', '怎么', '是否', '可以', '一个',
  '没有', '就是', '不是', '还是', '因为', '所以', '但是', '如果', '已经', '现在', '然后', '这样', '那样',
  '需要', '应该', '可能', '或者', '以及', '并且', '而且', '为了', '对于', '关于', '通过', '由于', '只是',
  '不过', '一些', '自己', '时候', '进行', '出现', '使用', '这里', '那里', '一样', '知道', '觉得', '希望',
  '帮我', '请你', '我的', '你的', '他的', '了一', '一下', '不能', '不会', '不要', '还有', '另外', '因此',
  '然而', '于是', '的话', '如何', '为什么',
];

const STOP_SET = new Set<string>([...STOP_WORDS_EN, ...STOP_WORDS_ZH, ...STOP_CHARS_ZH]);
const STOP_CHARS = new Set<string>(STOP_CHARS_ZH);

/** Public for tests and for anyone building a scope-aware word list later. */
export const STOP_WORDS: ReadonlySet<string> = STOP_SET;

function pushTerm(out: string[], term: string): void {
  if (term.length === 0 || STOP_SET.has(term)) return;
  out.push(term);
}

/** Segment one text into terms (unfiltered order preserved, duplicates kept). */
export function tokenize(text: string): string[] {
  const terms: string[] = [];
  const username = usernameToken().toLowerCase();
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    const raw = match[0];
    if (CJK_CHAR.test(raw)) {
      if (raw.length === 1) {
        pushTerm(terms, raw);
        continue;
      }
      for (let i = 0; i + 2 <= raw.length; i++) {
        const bigram = raw.slice(i, i + 2);
        const a = bigram[0];
        const b = bigram[1];
        // A bigram made of two function characters carries no meaning —
        // 「的话」「了的」— and both-char filtering cuts most of that noise.
        if (a !== undefined && b !== undefined && STOP_CHARS.has(a) && STOP_CHARS.has(b)) continue;
        pushTerm(terms, bigram);
      }
      continue;
    }
    const term = raw.toLowerCase();
    if (term.length < 2) continue;
    if (/^[0-9]+$/.test(term)) continue;
    if (username.length > 1 && term === username) continue;
    pushTerm(terms, term);
  }
  return terms;
}

/** Add the terms of `text` into `counts` (or a fresh map). */
export function countTerms(text: string, counts: Map<string, number> = new Map()): Map<string, number> {
  for (const term of tokenize(text)) counts.set(term, (counts.get(term) ?? 0) + 1);
  return counts;
}

/**
 * Terms an Event contributes to the vocabulary, memoized by object identity.
 *
 * Only authored conversation counts: user and assistant `message` events.
 * `tool_result` text is machine output (30 MB of it on this machine) and
 * `reasoning` is the model talking to itself — including either would make
 * the word list a summary of terminals and thinking traces rather than of the
 * work being done.
 */
const eventTermsCache = new WeakMap<Event, ReadonlyMap<string, number>>();

export function termsOfEvent(event: Event): ReadonlyMap<string, number> {
  const cached = eventTermsCache.get(event);
  if (cached !== undefined) return cached;
  const counts = new Map<string, number>();
  if ((event.role === 'user' || event.role === 'assistant') && event.kind === 'message' && event.text !== undefined) {
    countTerms(event.text, counts);
  }
  eventTermsCache.set(event, counts);
  return counts;
}
