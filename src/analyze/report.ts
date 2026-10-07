/**
 * The shareable report — one markdown file a person could send to someone else.
 *
 * This is the strictest output boundary in the project, stricter than the
 * Phase 1 `export` Insight and stricter than the rendered portrait, because it
 * is the only artifact whose whole purpose is to leave this machine.
 *
 * The rule that makes it safe is structural, not editorial: the report is
 * ASSEMBLED FROM Insight objects and nothing else. Every block is first built
 * as an `Insight` (flat primitives, dotted keys), run through
 * `assertExportable()`, and only then formatted into markdown. A value that is
 * not in an Insight cannot appear in the file, so "one illustrative example
 * sentence would make this readable" is not a temptation the code can act on —
 * there is no code path from conversation text to this file.
 *
 * Consequences worth stating plainly:
 *
 *   - Friction appears as counts and category names only. `friction.ts`
 *     findings carry signatures, args and session keys for LOCAL display; none
 *     of that is copied here. The reader learns that 6 failure signatures
 *     recurred 22 times and that 50 sessions ground through 50+ tool pairs —
 *     not which command, not which path, not which session.
 *   - Project counts are reported per source; project NAMES never are. A
 *     redacted `~/work/client-x` is still a client's name, and the report's
 *     job is to be forwardable.
 *   - Tool names are included. They are identifiers from a closed vocabulary
 *     (the adapters' own tool registries), not writing, and the existing
 *     `export` command already treats them as safe.
 *   - The final string passes `assertNoIdentifiers()`, which rejects home
 *     paths, session-id-shaped tokens and uuids. `renderReport` throws rather
 *     than writing a file that fails that check.
 */

import { assertExportable, type Insight } from '../core/privacy.ts';
import type { Portrait } from './index.ts';
import { contrasts, type Comparison, type SourceComparison, type Contrast } from './compare.ts';
import type { Friction } from './friction.ts';
import { assertNoIdentifiers } from './redact.ts';

type Flat = Record<string, number | string | boolean | null>;

function insight(section: string, summary: string, data: Flat): Insight {
  const value: Insight = { kind: 'insight', summary, data: { section, ...data } };
  // The guard runs at construction, not at write time: an Insight that cannot
  // be exported must fail here, where the offending field is one frame away.
  assertExportable(value);
  return value;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function int(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/**
 * The full set of Insights the report is allowed to be made of. Pure: takes
 * the already-computed analysis, reads no store, so the fixture gate can run
 * it without a database.
 */
export function buildReportInsights(
  portrait: Portrait,
  comparison: Comparison,
  friction: Friction,
): Insight[] {
  const insights: Insight[] = [];
  const { byClass } = portrait.totals;
  const day = (ts: number): string => new Date(ts).toISOString().slice(0, 10);

  insights.push(
    insight('span', `The corpus covers ${portrait.span.days} local days.`, {
      days: portrait.span.days,
      start_day: day(portrait.span.startTs),
      end_day: day(portrait.span.endTs),
      generated_day: day(portrait.generatedAt),
    }),
  );

  insights.push(
    insight(
      'totals',
      `${portrait.totals.events} events across ${portrait.totals.sessions} sessions; ` +
        `${byClass.automation.sessions} sessions were machine-driven.`,
      {
        events_total: portrait.totals.events,
        sessions_total: portrait.totals.sessions,
        sessions_interactive: byClass.interactive.sessions,
        sessions_automation: byClass.automation.sessions,
        sessions_other: byClass.other.sessions,
        events_interactive: byClass.interactive.events,
        events_automation: byClass.automation.events,
        events_other: byClass.other.events,
        scope: comparison.cls,
      },
    ),
  );

  for (const source of comparison.sources) {
    insights.push(sourceInsight(source));
  }

  const found = contrasts(comparison);
  for (let i = 0; i < found.length; i++) {
    insights.push(contrastInsight(found[i] as Contrast, i));
  }

  insights.push(frictionInsight(friction));
  return insights;
}

function sourceInsight(source: SourceComparison): Insight {
  const data: Flat = {
    source: source.source,
    sessions: source.sessions,
    events: source.events,
    median_session_minutes: source.medianSessionMinutes === null ? null : Number(source.medianSessionMinutes.toFixed(1)),
    events_per_session: source.eventsPerSession === null ? null : Number(source.eventsPerSession.toFixed(1)),
    reasoning_share: Number(source.reasoningShare.toFixed(4)),
    failure_rate: source.failureRate === null ? null : Number(source.failureRate.toFixed(4)),
    failure_count: source.failureCount,
    resolved_count: source.resolvedCount,
    tool_calls: source.toolCalls,
    projects_count: source.locatedProjects,
    unlocated_sessions: source.unlocatedSessions,
  };
  source.toolMix.forEach((tool, index) => {
    data[`tool_${index}_name`] = tool.name;
    data[`tool_${index}_share`] = Number(tool.share.toFixed(4));
  });
  let peakHour = -1;
  let peakCount = 0;
  for (let hour = 0; hour < source.hourHistogram.length; hour++) {
    const count = source.hourHistogram[hour] ?? 0;
    if (count > peakCount) {
      peakCount = count;
      peakHour = hour;
    }
  }
  data.peak_hour = peakHour < 0 ? null : peakHour;
  data.hours = source.hourHistogram.join(' ');
  const failureText = source.failureRate === null ? 'no resolved results' : pct(source.failureRate) + ' of resolved results failed';
  return insight(
    `source:${source.source}`,
    `${source.source}: ${int(source.sessions)} sessions, ${int(source.events)} events, ${failureText}.`,
    data,
  );
}

function contrastInsight(contrast: Contrast, index: number): Insight {
  // A contrast is included only if ALL of the numbers behind it are here:
  // both values, both sources, both labels and the unit. The statement is
  // carried as a string because it was computed, not written.
  return insight(`contrast_${index}`, contrast.statement, {
    key: contrast.key,
    source_a: contrast.sourceA,
    value_a: Number(contrast.valueA.toFixed(4)),
    label_a: contrast.labelA,
    source_b: contrast.sourceB,
    value_b: Number(contrast.valueB.toFixed(4)),
    label_b: contrast.labelB,
    unit: contrast.unit,
  });
}

/**
 * Friction, as counts and categories. The `signatures` field of a finding —
 * commands and paths — is never read here; only `totals` and category
 * cardinalities are.
 */
function frictionInsight(friction: Friction): Insight {
  return insight(
    'friction',
    `Friction in the ${friction.cls} scope: ${friction.totals.repeatedFailureSignatures} recurring failure patterns, ` +
      `${friction.totals.longLoopSessions} long tool loops, ${friction.totals.rewrites} rewritten files, ` +
      `${friction.totals.abandonedSessions} abandoned sessions.`,
    {
      scope: friction.cls,
      repeated_failure_patterns: friction.totals.repeatedFailureSignatures,
      repeated_failure_occurrences: friction.totals.repeatedFailureOccurrences,
      long_loops: friction.totals.longLoopSessions,
      longest_loop_pairs: friction.totals.longLoopMaxPairs,
      loop_pairs_total: friction.totals.longLoopPairs,
      rewrites: friction.totals.rewrites,
      rewrite_sessions: friction.totals.rewriteSessions,
      abandoned_sessions: friction.totals.abandonedSessions,
    },
  );
}

// ----------------------------------------------------------------- rendering

function cell(value: number | string | boolean | null | undefined, kind: 'text' | 'int' | 'pct' = 'text'): string {
  if (value === null || value === undefined) return '—';
  if (kind === 'int' && typeof value === 'number') return int(value);
  if (kind === 'pct' && typeof value === 'number') return pct(value);
  return String(value).replaceAll('|', '\\|');
}

function table(headers: readonly string[], rows: ReadonlyArray<readonly (number | string | boolean | null)[]>): string {
  const head = `| ${headers.join(' | ')} |`;
  const rule = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${row.map((value) => (value === null ? '—' : String(value))).join(' | ')} |`);
  return [head, rule, ...body].join('\n');
}

function dataOf(insight: Insight): Flat {
  return insight.data as Flat;
}

/**
 * Format the Insights into markdown. Only reads keys it knows; an unknown
 * section is rendered as a generic bullet list rather than dropped, so a
 * future block cannot silently vanish from the report.
 */
export function renderReport(insights: readonly Insight[], title = 'Agent Memoir — a working-life report'): string {
  const lines: string[] = [];
  const of = (section: string): Insight | undefined =>
    insights.find((item) => dataOf(item).section === section);
  const sources = insights
    .filter((item) => typeof dataOf(item).section === 'string' && String(dataOf(item).section).startsWith('source:'))
    .map(dataOf);

  lines.push(`# ${title}`, '');
  lines.push(
    'An aggregate report from local AI-agent coding history (Hermes, Claude Code, Codex), ' +
      'generated on this machine. It contains counts, ratios and tool identifiers only: ' +
      'no paths, no session identifiers, no conversation text, and no quotes from any session.',
    '',
  );

  const span = of('span');
  if (span !== undefined) {
    lines.push('## What this covers', '');
    const d = dataOf(span);
    lines.push(
      `${cell(d.days, 'int')} local days (${cell(d.start_day)} → ${cell(d.end_day)}), generated ${cell(d.generated_day)}.`,
      '',
    );
  }

  const totals = of('totals');
  if (totals !== undefined) {
    const d = dataOf(totals);
    lines.push('## The ledger', '');
    lines.push(
      `${cell(d.events_total, 'int')} events across ${cell(d.sessions_total, 'int')} sessions. ` +
        `${cell(d.sessions_automation, 'int')} of those sessions were machine-driven schedulers ` +
        `(${cell(d.events_automation, 'int')} events); the rest were human-driven or unclassified.`,
      '',
    );
    lines.push(
      table(
        ['class', 'sessions', 'events'],
        [
          ['human-driven', cell(d.sessions_interactive, 'int'), cell(d.events_interactive, 'int')],
          ['automation', cell(d.sessions_automation, 'int'), cell(d.events_automation, 'int')],
          ['other', cell(d.sessions_other, 'int'), cell(d.events_other, 'int')],
        ],
      ),
      '',
    );
  }

  if (sources.length > 0) {
    lines.push('## The agents, side by side', '');
    lines.push('The same measurements, computed identically for each source so the columns compare.', '');
    lines.push(
      table(
        ['source', 'sessions', 'events', 'median session', 'events / session', 'reasoning share', 'tool failure rate (resolved)'],
        sources.map((d) => [
          cell(d.source),
          cell(d.sessions, 'int'),
          cell(d.events, 'int'),
          d.median_session_minutes === null ? '—' : `${Number(d.median_session_minutes).toFixed(1)} min`,
          cell(d.events_per_session),
          cell(d.reasoning_share, 'pct'),
          d.failure_rate === null
            ? '—'
            : `${pct(Number(d.failure_rate))} (${cell(d.failure_count, 'int')}/${cell(d.resolved_count, 'int')})`,
        ]),
      ),
      '',
    );
    lines.push('Tool mix, most-used first, with each tool\u2019s share of that source\u2019s tool calls:', '');
    for (const d of sources) {
      const tools: string[] = [];
      for (let i = 0; i < 10; i++) {
        const name = d[`tool_${i}_name`];
        const share = d[`tool_${i}_share`];
        if (typeof name !== 'string') break;
        tools.push(`${name} ${pct(Number(share))}`);
      }
      const peak = d.peak_hour;
      const projects = Number(d.projects_count);
      lines.push(
        `- **${cell(d.source)}** — ${tools.join(', ')} · peak hour ${peak === null ? '—' : `${String(peak).padStart(2, '0')}:00`} local · ` +
          `${cell(d.tool_calls, 'int')} tool calls · ${cell(d.projects_count, 'int')} project${projects === 1 ? '' : 's'} · ` +
          `${cell(d.unlocated_sessions, 'int')} sessions with no recorded project`,
      );
    }
    lines.push('');
  }

  const found = insights.filter((item) => String(dataOf(item).section).startsWith('contrast_'));
  if (found.length > 0) {
    lines.push('## What actually differs', '');
    for (const item of found) {
      // The sentence is the Insight's summary — computed by contrasts(), never
      // written here — and the two numbers behind it are this block's data,
      // repeated after it so the reader can check the arithmetic.
      const d = dataOf(item);
      const show = (value: number | string | boolean | null | undefined, unit: string): string => {
        if (typeof value !== 'number') return cell(value);
        if (unit === 'share') return pct(value);
        if (unit === 'hour') return `${String(value).padStart(2, '0')}:00`;
        if (unit === 'minutes') return `${value.toFixed(0)} min`;
        return value.toFixed(1);
      };
      const unit = String(d.unit ?? '');
      lines.push(
        `- ${item.summary} *(${cell(d.source_a)} ${cell(d.label_a)} ${show(d.value_a, unit)} vs ` +
          `${cell(d.source_b)} ${cell(d.label_b)} ${show(d.value_b, unit)})*`,
      );
    }
    lines.push('');
  }

  const friction = of('friction');
  if (friction !== undefined) {
    const d = dataOf(friction);
    lines.push('## What kept not working', '');
    lines.push(
      'Reported as counts and categories only. Recurring failures are identical `tool + argument` ' +
        'signatures that returned failure at least three times; long loops are runs of 50 or more ' +
        'tool calls with no human turn between them; rewrites are files written more than once in a ' +
        'session with different content.',
      '',
    );
    lines.push(
      table(
        ['measure', 'count'],
        [
          ['recurring failure patterns', cell(d.repeated_failure_patterns, 'int')],
          ['failures inside those patterns', cell(d.repeated_failure_occurrences, 'int')],
          ['sessions with a long tool loop', cell(d.long_loops, 'int')],
          ['longest loop, in tool-call pairs', cell(d.longest_loop_pairs, 'int')],
          ['files rewritten within one session', cell(d.rewrites, 'int')],
          ['sessions containing a rewrite', cell(d.rewrite_sessions, 'int')],
          ['sessions ending mid-tool-call or on a failure', cell(d.abandoned_sessions, 'int')],
        ],
      ),
      '',
    );
  }

  const known = new Set(['span', 'totals', 'friction']);
  const extras = insights.filter((item) => {
    const section = String(dataOf(item).section);
    return !known.has(section) && !section.startsWith('source:') && !section.startsWith('contrast_');
  });
  if (extras.length > 0) {
    lines.push('## Additional aggregates', '');
    for (const extra of extras) {
      const d = dataOf(extra);
      lines.push(`### ${cell(d.section)}`, '', extra.summary, '');
      lines.push(
        table(
          ['key', 'value'],
          Object.entries(d)
            .filter(([key]) => key !== 'section')
            .map(([key, value]) => [key, value === null ? '—' : String(value)]),
        ),
        '',
      );
    }
  }

  lines.push('---', '');
  lines.push(
    'Generated by agent-memoir from local histories, read-only. Every figure above is an aggregate ' +
      'that passed the project\u2019s export guard; nothing in this file was copied from a conversation.',
    '',
  );
  return lines.join('\n');
}

/**
 * The whole path: build Insights, render markdown, and refuse to return a
 * string that fails the identifier check. Throws instead of writing — the
 * caller (CLI) never sees a leaky report.
 */
export function buildReport(
  portrait: Portrait,
  comparison: Comparison,
  friction: Friction,
  title?: string,
): { markdown: string; insights: readonly Insight[] } {
  const insights = buildReportInsights(portrait, comparison, friction);
  const markdown = renderReport(insights, title);
  assertNoIdentifiers(markdown, 'buildReport');
  return { markdown, insights };
}
