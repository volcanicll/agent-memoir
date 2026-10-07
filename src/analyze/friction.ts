/**
 * Friction — what keeps happening that should not.
 *
 * This is the most sensitive output in the project: it is derived from tool
 * arguments (commands, paths, patches) and it is the output most tempting to
 * illustrate with a real example. It never is. Findings carry counts,
 * identifiers and timestamps; the free text of a signature stays in the local
 * finding object, and the shareable report (src/analyze/report.ts) admits
 * nothing from here except counts and category names. The rendered portrait
 * shows tool names, counts and redacted path labels — identifiers and paths,
 * never a command line or a sentence.
 *
 * Call/result pairing. The failure flag lives on `tool_result` events but the
 * tool name and args live on the matching `tool_call`, so an unpaired
 * `ok:false` would collapse every failure of a source into "the result
 * channel said no". All three adapters carry a join key, so pairing is exact,
 * not heuristic: Hermes puts `meta.toolCallId` on both sides, Codex
 * `meta.callId`, and Claude Code the result's `meta.parentUuid` pointing at
 * the call's `meta.uuid`. Measured on this corpus: 21,778 of 21,781 resolved
 * results pair; the 3 that do not are reported under the result's own name
 * when it has one, and dropped when it is empty or 'unknown' (an adapter
 * artifact, not a tool).
 *
 * Thresholds — each is a constant with its measured justification:
 *
 *   - REPEATED_FAILURE_MIN = 3. The signature distribution on this corpus is
 *     991 fail once, 34 twice, and 7 three or more times. Two is a retry — a
 *     person re-runs a command after fixing something. Three identical
 *     failures is a wall.
 *   - LOOP_MIN_PAIRS = 50. Runs of tool_call events with no authored turn:
 *     median 9 pairs, and 50 lands in the top ~9% of all 1,661 runs. Below
 *     that an "agent grinding" claim would fire on ordinary autonomous work.
 *   - REWRITE: the same path written twice or more in one session with at
 *     least two distinct contents. A single write cannot be a rewrite, and
 *     identical content is a no-op, so both conditions are forced. This is a
 *     heuristic over SUMMARIZED tool arguments — `argsSummary` is the
 *     adapter's JSON summary, possibly truncated — not a git-level diff; the
 *     finding says `versions` and `exactRevert` (a later write reproducing an
 *     earlier content verbatim) so the reader can tell how strong it is.
 *   - ABANDONED: the literal rule, no pairing: the session's last event is a
 *     `tool_result` with `ok:false`, or a `tool_call` that never received a
 *     result. Nothing is inferred about intent.
 */

import { matchesClassFilter, type ClassFilter } from './classify.ts';
import { redactHome } from './redact.ts';
import type { Session } from './session.ts';

export type FrictionCategory = 'repeated_failure' | 'long_loop' | 'reverted_work' | 'abandoned_session';

/** Justification above: 3 identical failures is a wall, 2 is a retry. */
export const REPEATED_FAILURE_MIN = 3;

/** Justification above: top ~9% of runs on this corpus. */
export const LOOP_MIN_PAIRS = 50;

/** Tools whose call rewrites a whole file/region (see the REWRITE note). */
export const REWRITE_TOOLS: ReadonlySet<string> = new Set(['write_file', 'patch', 'apply_patch', 'Write']);

export interface FrictionFinding {
  readonly category: FrictionCategory;
  /** Local-only grouping key (may contain paths, commands — never exported). */
  readonly signature: string;
  /** Display label: tool name, redacted path, or event kind. */
  readonly label: string;
  /** Occurrences inside the finding (failures, pairs, writes, or 1). */
  readonly count: number;
  readonly sessionCount: number;
  /** Session keys `${source}:${sessionId}` — LOCAL ONLY, never rendered. */
  readonly sessions: readonly string[];
  readonly firstTs: number;
  readonly lastTs: number;
  /** Category-specific numbers, flat primitives. */
  readonly detail: Readonly<Record<string, number | string | boolean>>;
}

export interface Friction {
  readonly cls: ClassFilter;
  readonly repeatedFailures: readonly FrictionFinding[];
  readonly longLoops: readonly FrictionFinding[];
  readonly revertedWork: readonly FrictionFinding[];
  readonly abandonedSessions: readonly FrictionFinding[];
  readonly totals: {
    readonly repeatedFailureSignatures: number;
    readonly repeatedFailureOccurrences: number;
    readonly longLoopSessions: number;
    readonly longLoopMaxPairs: number;
    readonly longLoopPairs: number;
    readonly rewrites: number;
    readonly rewriteSessions: number;
    readonly abandonedSessions: number;
  };
}

export interface FrictionOptions {
  /** Cap on session keys carried per finding (counts stay exact). */
  readonly maxSessions?: number;
  /** Cap on findings carried per category. */
  readonly limit?: number;
}

const FRICTION_DEFAULTS = { maxSessions: 12, limit: 50 } as const;

/** Whitespace-collapsed args, the form a repeated call is compared in. */
function normalizeArgs(args: string | undefined): string {
  return (args ?? '').replace(/\s+/g, ' ').trim();
}

function pairKey(event: { meta: Record<string, unknown>; kind: string }): string | null {
  const meta = event.meta;
  if (typeof meta.toolCallId === 'string' && meta.toolCallId.length > 0) return meta.toolCallId;
  if (typeof meta.callId === 'string' && meta.callId.length > 0) return meta.callId;
  return null;
}

function collapseTs(values: readonly number[]): { firstTs: number; lastTs: number } {
  let firstTs = Number.POSITIVE_INFINITY;
  let lastTs = 0;
  for (const ts of values) {
    if (ts < firstTs) firstTs = ts;
    if (ts > lastTs) lastTs = ts;
  }
  if (!Number.isFinite(firstTs)) return { firstTs: 0, lastTs: 0 };
  return { firstTs, lastTs };
}

// ------------------------------------------------------- repeated failures

interface SignatureGroup {
  tool: string;
  args: string;
  count: number;
  sessions: Map<string, number>;
  timestamps: number[];
}

function repeatedFailuresOf(sessions: readonly Session[], maxSessions: number, limit: number): FrictionFinding[] {
  const groups = new Map<string, SignatureGroup>();
  for (const session of sessions) {
    const callsByKey = new Map<string, { name: string; args: string }>();
    for (const event of session.events) {
      if (event.kind !== 'tool_call' || event.tool === undefined) continue;
      const key = pairKey(event);
      if (key !== null) callsByKey.set(key, { name: event.tool.name, args: normalizeArgs(event.tool.argsSummary) });
    }
    for (const event of session.events) {
      if (event.tool?.ok !== false) continue;
      const key = pairKey(event);
      const call = key === null ? undefined : callsByKey.get(key);
      const name = call?.name ?? event.tool.name;
      const args = call?.args ?? '';
      // An empty or 'unknown' name is the adapter's placeholder, not a tool;
      // counting it would produce one giant fake pattern per source.
      if (name.length === 0 || name === 'unknown') continue;
      const signature = `${name}\u0000${args}`;
      const group: SignatureGroup =
        groups.get(signature) ?? { tool: name, args, count: 0, sessions: new Map(), timestamps: [] };
      group.count += 1;
      group.sessions.set(session.key, (group.sessions.get(session.key) ?? 0) + 1);
      group.timestamps.push(event.ts);
      groups.set(signature, group);
    }
  }

  return [...groups.values()]
    .filter((group) => group.count >= REPEATED_FAILURE_MIN)
    .map((group): FrictionFinding => {
      const { firstTs, lastTs } = collapseTs(group.timestamps);
      const sessionKeys = [...group.sessions.keys()].sort();
      const displayArgs = group.args.length > 240 ? `${group.args.slice(0, 240)}…` : group.args;
      return {
        category: 'repeated_failure',
        signature: `${group.tool} ${group.args}`,
        label: group.tool,
        count: group.count,
        sessionCount: group.sessions.size,
        sessions: sessionKeys.slice(0, maxSessions),
        firstTs,
        lastTs,
        detail: {
          tool: group.tool,
          /** Truncated copy for local display only. */
          args: displayArgs,
          occurrences: group.count,
          sessions: group.sessions.size,
        },
      };
    })
    .sort((a, b) => b.count - a.count || b.lastTs - a.lastTs || a.signature.localeCompare(b.signature))
    .slice(0, limit);
}

// ------------------------------------------------------------- long loops

function longLoopsOf(sessions: readonly Session[], maxSessions: number, limit: number): FrictionFinding[] {
  const findings: FrictionFinding[] = [];
  for (const session of sessions) {
    let pairs = 0;
    let startTs = 0;
    let endTs = 0;
    const tools = new Map<string, number>();
    const flush = (): void => {
      if (pairs < LOOP_MIN_PAIRS) {
        pairs = 0;
        tools.clear();
        return;
      }
      const top = [...tools.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
      findings.push({
        category: 'long_loop',
        signature: `${session.key}#loop@${startTs}`,
        label: `${pairs} tool pairs`,
        count: pairs,
        sessionCount: 1,
        sessions: [session.key].slice(0, maxSessions),
        firstTs: startTs,
        lastTs: endTs,
        detail: {
          pairs,
          topTool: top?.[0] ?? '',
          topToolPairs: top?.[1] ?? 0,
          source: session.source,
        },
      });
      pairs = 0;
      tools.clear();
    };
    for (const event of session.events) {
      if (event.kind === 'tool_call' || event.kind === 'tool_result') {
        if (pairs === 0) startTs = event.ts;
        endTs = event.ts;
        if (event.kind === 'tool_call') {
          pairs += 1;
          if (event.tool !== undefined && event.tool.name.length > 0) {
            tools.set(event.tool.name, (tools.get(event.tool.name) ?? 0) + 1);
          }
        }
        continue;
      }
      // Any authored turn ends the stretch: the question is how long the
      // agent worked WITHOUT the person saying anything.
      if (event.role === 'user') flush();
    }
    flush();
  }
  return findings.sort((a, b) => b.count - a.count || b.lastTs - a.lastTs).slice(0, limit);
}

// ----------------------------------------------------------- reverted work

export interface WriteTouch {
  readonly path: string;
  readonly content: string;
}

/**
 * Extract (path, content) pairs from the summarized arguments of a write-like
 * tool. Returns [] when the summary cannot be read — a finding is never
 * invented from a shape the parser does not understand.
 */
export function writeTouchesOf(toolName: string, argsSummary: string | undefined): WriteTouch[] {
  const args = argsSummary ?? '';
  if (args.length === 0) return [];

  if (toolName === 'apply_patch') {
    // Codex's patch is unified-diff text, not JSON. Section headers name the
    // files; the section body is the content the patch applies.
    const matches = [...args.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)];
    const touches: WriteTouch[] = [];
    for (let i = 0; i < matches.length; i++) {
      const match = matches[i];
      if (match === undefined) continue;
      const path = match[1]?.trim();
      if (path === undefined || path.length === 0) continue;
      const from = (match.index ?? 0) + match[0].length;
      const next = matches[i + 1];
      const to = next?.index ?? args.length;
      touches.push({ path, content: args.slice(from, to) });
    }
    return touches;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(args);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return [];
  const record = parsed as Record<string, unknown>;
  const path = typeof record.path === 'string' ? record.path : typeof record.file_path === 'string' ? record.file_path : undefined;
  if (path === undefined || path.length === 0) return [];
  // write_file carries `content`; hermes `patch` replaces with `new_string`;
  // Claude's Write uses `content`. `patch` in append mode has no new_string —
  // then there is nothing to compare and the touch is skipped.
  const content = typeof record.content === 'string' ? record.content : typeof record.new_string === 'string' ? record.new_string : undefined;
  if (content === undefined) return [];
  return [{ path, content }];
}

function revertedWorkOf(sessions: readonly Session[], maxSessions: number, limit: number): FrictionFinding[] {
  const findings: FrictionFinding[] = [];
  for (const session of sessions) {
    const byPath = new Map<string, { contents: string[]; timestamps: number[] }>();
    for (const event of session.events) {
      if (event.kind !== 'tool_call' || event.tool === undefined) continue;
      if (!REWRITE_TOOLS.has(event.tool.name)) continue;
      for (const touch of writeTouchesOf(event.tool.name, event.tool.argsSummary)) {
        const entry = byPath.get(touch.path) ?? { contents: [], timestamps: [] };
        entry.contents.push(touch.content);
        entry.timestamps.push(event.ts);
        byPath.set(touch.path, entry);
      }
    }
    for (const [path, entry] of byPath) {
      if (entry.contents.length < 2) continue;
      const versions = new Set(entry.contents);
      if (versions.size < 2) continue;
      // exactRevert: a later write reproduces an earlier content verbatim —
      // the strongest form of "this went in a circle".
      let exactRevert = false;
      for (let i = 0; i < entry.contents.length && !exactRevert; i++) {
        for (let j = i + 1; j < entry.contents.length; j++) {
          if (entry.contents[i] === entry.contents[j]) {
            exactRevert = true;
            break;
          }
        }
      }
      const { firstTs, lastTs } = collapseTs(entry.timestamps);
      findings.push({
        category: 'reverted_work',
        signature: path,
        label: redactHome(path),
        count: entry.contents.length,
        sessionCount: 1,
        sessions: [session.key].slice(0, maxSessions),
        firstTs,
        lastTs,
        detail: {
          writes: entry.contents.length,
          versions: versions.size,
          exactRevert,
          source: session.source,
        },
      });
    }
  }
  return findings
    .sort((a, b) => b.count - a.count || Number(b.detail.exactRevert) - Number(a.detail.exactRevert) || a.label.localeCompare(b.label))
    .slice(0, limit);
}

// ------------------------------------------------------ abandoned sessions

function abandonedSessionsOf(sessions: readonly Session[], maxSessions: number, limit: number): FrictionFinding[] {
  const findings: FrictionFinding[] = [];
  for (const session of sessions) {
    const last = session.events[session.events.length - 1];
    if (last === undefined) continue;
    const endedFailedResult = last.kind === 'tool_result' && last.tool?.ok === false;
    const endedMidCall = last.kind === 'tool_call';
    if (!endedFailedResult && !endedMidCall) continue;
    findings.push({
      category: 'abandoned_session',
      signature: `${session.key}#end`,
      label: endedMidCall ? 'ended mid-tool-call' : 'ended on failed tool result',
      count: 1,
      sessionCount: 1,
      sessions: [session.key].slice(0, maxSessions),
      firstTs: last.ts,
      lastTs: last.ts,
      detail: {
        endedMidCall,
        endedFailedResult,
        lastKind: last.kind,
        lastTool: last.tool?.name ?? '',
        source: session.source,
      },
    });
  }
  return findings.sort((a, b) => b.lastTs - a.lastTs).slice(0, limit);
}

/** Every friction family over one class scope. */
export function computeFriction(
  sessions: readonly Session[],
  filter: ClassFilter = 'all',
  options: FrictionOptions = {},
): Friction {
  const maxSessions = options.maxSessions ?? FRICTION_DEFAULTS.maxSessions;
  const limit = options.limit ?? FRICTION_DEFAULTS.limit;
  const selected = sessions.filter((session) => matchesClassFilter(session.cls, filter));

  const repeatedFailures = repeatedFailuresOf(selected, maxSessions, limit);
  const longLoops = longLoopsOf(selected, maxSessions, limit);
  const revertedWork = revertedWorkOf(selected, maxSessions, limit);
  const abandonedSessions = abandonedSessionsOf(selected, maxSessions, limit);

  return {
    cls: filter,
    repeatedFailures,
    longLoops,
    revertedWork,
    abandonedSessions,
    totals: {
      repeatedFailureSignatures: repeatedFailures.length,
      repeatedFailureOccurrences: repeatedFailures.reduce((total, finding) => total + finding.count, 0),
      longLoopSessions: longLoops.length,
      longLoopMaxPairs: longLoops.reduce((max, finding) => Math.max(max, finding.count), 0),
      longLoopPairs: longLoops.reduce((total, finding) => total + finding.count, 0),
      rewrites: revertedWork.length,
      rewriteSessions: new Set(revertedWork.flatMap((finding) => finding.sessions)).size,
      abandonedSessions: abandonedSessions.length,
    },
  };
}

// ------------------------------------------------- display-safe projection

/**
 * A friction finding stripped of everything local, for the rendered site.
 *
 * The Portrait is inlined into `portrait.js` and therefore reaches disk as a
 * file; it must carry display data only. `FrictionFinding` deliberately keeps
 * the signature (a command line or a path), the session keys and the raw
 * `detail.args` — the CLI needs them — which makes it unsafe to embed. Before
 * this split, the renderer's `assertRedacted` net caught the raw paths on
 * first render: proof that the net works, and that the field-level rule needs
 * to live in the type rather than in a reviewer's memory.
 */
export interface DisplayFinding {
  readonly category: FrictionCategory;
  /** Display label: tool name, redacted path, or event kind. */
  readonly label: string;
  readonly count: number;
  readonly sessionCount: number;
  readonly firstTs: number;
  readonly lastTs: number;
  /** Safe, category-specific numbers only. */
  readonly detail: Readonly<Record<string, number | boolean>>;
}

export interface DisplayFriction {
  readonly cls: ClassFilter;
  readonly repeatedFailures: readonly DisplayFinding[];
  readonly longLoops: readonly DisplayFinding[];
  readonly revertedWork: readonly DisplayFinding[];
  readonly abandonedSessions: readonly DisplayFinding[];
  readonly totals: Friction['totals'];
}

function displayOf(finding: FrictionFinding): DisplayFinding {
  const safe: Record<string, number | boolean> = {};
  for (const [key, value] of Object.entries(finding.detail)) {
    if (typeof value === 'number' || typeof value === 'boolean') safe[key] = value;
  }
  return {
    category: finding.category,
    label: finding.label,
    count: finding.count,
    sessionCount: finding.sessionCount,
    firstTs: finding.firstTs,
    lastTs: finding.lastTs,
    detail: safe,
  };
}

/**
 * The projection the Portrait (and therefore the rendered site) carries.
 * Nothing here can leak: labels are already redacted by the finders, detail is
 * numbers and booleans only, and signature/sessions/args are dropped outright.
 */
export function displayFriction(friction: Friction): DisplayFriction {
  return {
    cls: friction.cls,
    repeatedFailures: friction.repeatedFailures.map(displayOf),
    longLoops: friction.longLoops.map(displayOf),
    revertedWork: friction.revertedWork.map(displayOf),
    abandonedSessions: friction.abandonedSessions.map(displayOf),
    totals: friction.totals,
  };
}
