/**
 * Agent Memoir CLI — the only entry point a person is expected to run.
 *
 *   sync      read every detected adapter into the local store (idempotent)
 *   stats     print an analysis summary for one session class
 *   portrait  write the static portrait site
 *   export    print a single Insight JSON document (the ONLY export path)
 *   init      show detected sources and where they live
 *
 * Zero runtime dependencies: argument parsing is a hand-written loop because
 * the surface is five commands and a handful of flags, and because adding a
 * parser would break the repo's dependency-free promise.
 *
 * Privacy: everything that leaves the terminal is an Insight and goes through
 * assertExportable(); nothing that leaves carries paths, session ids or text.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { analyzeAll, loadSessions, type Portrait } from '../analyze/index.ts';
import { CLASS_FILTERS, type ClassFilter } from '../analyze/classify.ts';
import { assertExportable, type Insight } from '../core/privacy.ts';
import { defaultRegistry } from '../core/registry.ts';
import { renderPortrait } from '../render/portrait.ts';
import { MemoirStore } from '../store/sqlite.ts';

const DEFAULT_DB = join(homedir(), '.agent-memoir', 'events.db');
const SYNC_BATCH = 2000;

interface ParsedArgs {
  command: string | undefined;
  flags: Map<string, string>;
  rest: string[];
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags = new Map<string, string>();
  const rest: string[] = [];
  let command: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      const eq = body.indexOf('=');
      if (eq >= 0) {
        flags.set(body.slice(0, eq), body.slice(eq + 1));
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags.set(body, next);
          i++;
        } else {
          flags.set(body, 'true');
        }
      }
    } else if (command === undefined) {
      command = arg;
    } else {
      rest.push(arg);
    }
  }
  return { command, flags, rest };
}

function dbPathOf(args: ParsedArgs): string {
  return resolve(args.flags.get('db') ?? DEFAULT_DB);
}

function classOf(args: ParsedArgs): ClassFilter {
  const value = args.flags.get('class') ?? 'interactive';
  if (!(CLASS_FILTERS as readonly string[]).includes(value)) {
    throw new Error(`--class must be one of ${CLASS_FILTERS.join('|')} (got "${value}")`);
  }
  return value as ClassFilter;
}

function int(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

function heading(text: string): void {
  console.log(`\n${text}`);
  console.log('─'.repeat(Math.min(text.length + 8, 78)));
}

// ------------------------------------------------------------------- init

async function cmdInit(): Promise<number> {
  const registry = defaultRegistry();
  console.log('agent-memoir · detected sources\n');
  let detected = 0;
  for (const adapter of registry.list()) {
    const present = await adapter.detect();
    if (present) detected++;
    console.log(`${present ? '●' : '○'} ${adapter.id}${present ? '' : '  (not present)'}`);
    for (const path of adapter.sourcePaths()) {
      const exists = existsSync(path);
      console.log(`    ${exists ? '' : '(missing) '}${path}`);
    }
  }
  const entry = registry
    .listEntries()
    .filter((item) => !registry.get(item.id));
  if (entry.length > 0) {
    console.log(`\nregistry also declares: ${entry.map((item) => item.id).join(', ')} (no builtin loader)`);
  }
  console.log(`\n${detected} source(s) detected. default db: ${DEFAULT_DB}`);
  return 0;
}

// ------------------------------------------------------------------- sync

async function cmdSync(args: ParsedArgs): Promise<number> {
  const dbPath = dbPathOf(args);
  const store = new MemoirStore(dbPath);
  try {
    const before = store.count();
    console.log(`syncing into ${dbPath}\n`);
    let totalInserted = 0;
    let totalIgnored = 0;
    for (const adapter of defaultRegistry().list()) {
      if (!(await adapter.detect())) {
        console.log(`${adapter.id.padEnd(14)} not detected — skipped`);
        continue;
      }
      let inserted = 0;
      let ignored = 0;
      let batch: import('../core/event.ts').Event[] = [];
      const flush = (): void => {
        if (batch.length === 0) return;
        const stats = store.appendMany(batch);
        inserted += stats.inserted;
        ignored += stats.ignored;
        batch = [];
      };
      for await (const raw of adapter.read()) {
        const event = adapter.normalize(raw);
        if (event === null) continue;
        batch.push(event);
        if (batch.length >= SYNC_BATCH) flush();
      }
      flush();
      totalInserted += inserted;
      totalIgnored += ignored;
      console.log(
        `${adapter.id.padEnd(14)} inserted ${int(inserted).padStart(9)} · ignored ${int(ignored).padStart(9)}`,
      );
    }
    const after = store.count();
    console.log(
      `\ntotal: ${int(after)} events in store (was ${int(before)}) · inserted ${int(totalInserted)} · ignored ${int(totalIgnored)}`,
    );
    if (totalInserted === 0 && totalIgnored > 0) {
      console.log('idempotent: every record was already stored.');
    }
    return 0;
  } finally {
    store.close();
  }
}

// ------------------------------------------------------------------ stats

function classLine(portrait: Portrait): string {
  const { byClass } = portrait.totals;
  return `interactive ${int(byClass.interactive.sessions)} ses / ${int(byClass.interactive.events)} ev · automation ${int(byClass.automation.sessions)} ses / ${int(byClass.automation.events)} ev · other ${int(byClass.other.sessions)} ses / ${int(byClass.other.events)} ev`;
}

function cmdStats(args: ParsedArgs): number {
  const dbPath = dbPathOf(args);
  if (!existsSync(dbPath)) {
    console.error(`no store at ${dbPath} — run \`bun run cli -- sync\` first`);
    return 1;
  }
  const store = new MemoirStore(dbPath);
  try {
    const cls = classOf(args);
    const portrait = analyzeAll(store);
    const view = portrait.views[cls];
    const rhythm = view.rhythm;

    console.log(`agent-memoir · stats (${cls})`);
    console.log(`store: ${dbPath}`);
    heading('span');
    console.log(
      `${new Date(portrait.span.startTs).toISOString().slice(0, 10)} → ${new Date(portrait.span.endTs).toISOString().slice(0, 10)} · ${int(portrait.span.days)} days · ${int(rhythm.activeDays)} active`,
    );
    heading('sessions by class (all data)');
    console.log(classLine(portrait));
    const labels = portrait.labels.map((label) => `${label.label} ${int(label.sessions)}`).join(' · ');
    console.log(`origins: ${labels}`);
    heading(`view: ${cls}`);
    console.log(`sessions ${int(view.sessions)} · events ${int(view.events)}`);
    if (view.sessions === 0) {
      console.log('no sessions in this class.');
      return 0;
    }
    console.log(
      `rhythm: peak ${rhythm.peakHour === null ? '—' : `${rhythm.peakHour.hour}:00`} · streak ${int(rhythm.longestStreakDays)}d · longest gap ${int(rhythm.longestGapDays)}d · busiest ${rhythm.busiestDay?.day ?? '—'}`,
    );
    if (view.drift !== null) {
      console.log(`drift: ${view.drift.reason}`);
      for (const move of view.drift.projectMoves.slice(0, 5)) {
        console.log(`  project ${move.label} ${(move.before * 100).toFixed(1)}% → ${(move.after * 100).toFixed(1)}% (${move.deltaPp > 0 ? '+' : ''}${move.deltaPp.toFixed(1)}pp)`);
      }
      for (const move of view.drift.toolMoves.slice(0, 5)) {
        console.log(`  tool ${move.label} ${(move.before * 100).toFixed(1)}% → ${(move.after * 100).toFixed(1)}% (${move.deltaPp > 0 ? '+' : ''}${move.deltaPp.toFixed(1)}pp)`);
      }
      const rising = view.drift.risingTerms.slice(0, 5).map((move) => move.term);
      const falling = view.drift.fallingTerms.slice(0, 5).map((move) => move.term);
      if (rising.length > 0) console.log(`  terms rising: ${rising.join(', ')}`);
      if (falling.length > 0) console.log(`  terms falling: ${falling.join(', ')}`);
    }
    heading('top terms');
    console.log(view.vocabulary.topTerms.slice(0, 20).map((term) => `${term.term}(${int(term.count)})`).join('  '));
    heading('top tools');
    console.log(view.vocabulary.topTools.slice(0, 10).map((tool) => `${tool.name}(${int(tool.count)})`).join('  '));
    heading('top projects');
    for (const project of view.projects.projects.slice(0, 10)) {
      console.log(
        `${project.root}  ${int(project.sessions)} ses · ${int(project.events)} ev · ${new Date(project.firstTs).toISOString().slice(0, 10)} → ${new Date(project.lastTs).toISOString().slice(0, 10)}`,
      );
    }
    return 0;
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------- portrait

async function cmdPortrait(args: ParsedArgs): Promise<number> {
  const dbPath = dbPathOf(args);
  const out = args.flags.get('out');
  if (out === undefined || out === 'true') {
    console.error('portrait needs --out <dir>');
    return 1;
  }
  if (!existsSync(dbPath)) {
    console.error(`no store at ${dbPath} — run \`bun run cli -- sync\` first`);
    return 1;
  }
  const store = new MemoirStore(dbPath);
  try {
    const portrait = analyzeAll(store);
    const files = await renderPortrait(portrait, resolve(out));
    console.log(`portrait written to ${resolve(out)}`);
    for (const file of files) console.log(`  ${file}`);
    console.log(
      `\n${int(portrait.totals.events)} events · ${int(portrait.totals.sessions)} sessions · default view: interactive (${int(portrait.views.interactive.sessions)} sessions)`,
    );
    return 0;
  } finally {
    store.close();
  }
}

// ------------------------------------------------------------------ export

/**
 * The one export path. The Insight carries aggregates only — and deliberately
 * NOT the vocabulary's top terms, because individual words are fragments of
 * the user's text even when they are counted rather than quoted. Tool names
 * are included: they are identifiers from a fixed vocabulary, not writing.
 *
 * The detailed series (hours, kinds, tools) are scoped to the interactive
 * class — exporting the machine's schedule as if it were the person's is the
 * exact failure this phase exists to prevent — and `detail_scope` states that
 * in the payload so a downstream reader cannot mistake the scope.
 *
 * Insight.data is flat primitives by contract, so the nested structure is
 * flattened with dotted keys.
 */
function buildInsight(portrait: Portrait): Insight {
  const view = portrait.views.interactive;
  const data: Record<string, number | string | boolean | null> = {
    days_spanned: portrait.span.days,
    events_total: portrait.totals.events,
    sessions_total: portrait.totals.sessions,
    detail_scope: 'interactive',
    events_interactive: view.events,
    sessions_interactive: view.sessions,
  };
  for (const cls of ['interactive', 'automation', 'other'] as const) {
    data[`sessions.${cls}`] = portrait.totals.byClass[cls].sessions;
    data[`events.${cls}`] = portrait.totals.byClass[cls].events;
  }
  for (const source of portrait.sources) {
    data[`source_sessions.${source.source}`] = source.sessions;
    data[`source_events.${source.source}`] = source.events;
  }
  for (let hour = 0; hour < 24; hour++) {
    data[`hour.${hour}`] = view.rhythm.hourOfDay[hour] ?? 0;
  }
  for (const [kind, count] of Object.entries(view.vocabulary.kindCounts)) {
    data[`kind.${kind}`] = count ?? 0;
  }
  view.vocabulary.topTools.slice(0, 10).forEach((tool, index) => {
    data[`tool_${index}_name`] = tool.name;
    data[`tool_${index}_count`] = tool.count;
  });
  data.active_days_interactive = view.rhythm.activeDays;
  data.longest_streak_days_interactive = view.rhythm.longestStreakDays;
  data.longest_gap_days_interactive = view.rhythm.longestGapDays;
  data.peak_hour_interactive = view.rhythm.peakHour?.hour ?? null;
  data.projects_count_interactive = view.projects.projects.filter((project) => !project.unlocated).length;
  const { byClass } = portrait.totals;
  const automationShare = portrait.totals.sessions === 0 ? 0 : byClass.automation.sessions / portrait.totals.sessions;
  return {
    kind: 'insight',
    summary:
      `Local agent work over ${portrait.span.days} days from ${portrait.sources.length} sources: ` +
      `${view.sessions} human-driven sessions (${view.events} events) alongside ` +
      `${byClass.automation.sessions} automation sessions (${byClass.automation.events} events); ` +
      `${Math.round(automationShare * 100)}% of sessions were machine-driven. ` +
      `Detailed series cover the interactive class only (detail_scope).`,
    data,
  };
}

function cmdExport(args: ParsedArgs): number {
  const dbPath = dbPathOf(args);
  if (!existsSync(dbPath)) {
    console.error(`no store at ${dbPath} — run \`bun run cli -- sync\` first`);
    return 1;
  }
  const store = new MemoirStore(dbPath);
  try {
    const portrait = analyzeAll(store);
    const insight = buildInsight(portrait);
    assertExportable(insight); // throws rather than emitting anything unsafe
    console.log(JSON.stringify(insight, null, 2));
    return 0;
  } finally {
    store.close();
  }
}

// -------------------------------------------------------------------- main

const USAGE = `agent-memoir · local agent memoir

usage: bun run cli -- <command> [options]

  init                       detect sources and print their paths
  sync   [--db <path>]       ingest every detected source into the store
  stats  [--db <path>] [--class interactive|automation|other|all]
                             analysis summary to stdout
  portrait --out <dir> [--db <path>]
                             write the static portrait site
  export [--db <path>]       print one Insight JSON document (aggregates only)

default db: ${DEFAULT_DB}`;

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  switch (args.command) {
    case 'init':
      return cmdInit();
    case 'sync':
      return cmdSync(args);
    case 'stats':
      return cmdStats(args);
    case 'portrait':
      return cmdPortrait(args);
    case 'export':
      return cmdExport(args);
    case undefined:
    case 'help':
      console.log(USAGE);
      return args.command === undefined ? 1 : 0;
    default:
      console.error(`unknown command: ${args.command}\n`);
      console.error(USAGE);
      return 1;
  }
}

try {
  process.exit(await main());
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
