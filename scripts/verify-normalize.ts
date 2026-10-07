/**
 * Phase 0 verification gate — `bun run verify`.
 *
 * Proves, against this machine's real local histories, that:
 *   1. every source declared in registry.json is registered and detects data,
 *   2. every non-null Event all three adapters produce passes validateEvent(),
 *   3. ordinals are strictly increasing within each (source, sessionId),
 *   4. each source contributes non-empty text,
 *   5. MemoirStore ingest is lossless, idempotent, and source-summarizable,
 *   6. the privacy boundary accepts Insight and rejects Event / RawEvent.
 *
 * Non-zero exit and a printed reason on any failure: a green run means the
 * gate passed, not merely that the script ran. Read-only on source data — the
 * only write is the throwaway SQLite file under os.tmpdir(), removed on exit.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Adapter } from '../src/core/adapter.ts';
import { validateEvent, type Event, type ValidationIssue } from '../src/core/event.ts';
import { PrivacyViolationError, assertExportable, type Insight, type RawEvent } from '../src/core/privacy.ts';
import { defaultRegistry } from '../src/core/registry.ts';
import { MemoirStore } from '../src/store/sqlite.ts';

const REQUIRED_SOURCES = ['hermes', 'claude-code', 'codex'] as const;
const EPOCH_FLOOR = Date.UTC(2000, 0, 1);
const FUTURE_SLACK_MS = 86_400_000;

interface ValidationFailure {
  source: string;
  errors: ValidationIssue[];
  event: Event;
}

interface SourceReport {
  source: string;
  files: number;
  rows: number;
  events: Event[];
  nulls: number;
  failures: ValidationFailure[];
  firstRaw: RawEvent | undefined;
}

class GateFailure extends Error {}

function fail(message: string): never {
  throw new GateFailure(message);
}

function hasText(event: Event): boolean {
  return typeof event.text === 'string' && event.text.length > 0;
}

async function streamSource(adapter: Adapter): Promise<SourceReport> {
  const files = new Set<string>();
  const events: Event[] = [];
  const failures: ValidationFailure[] = [];
  let rows = 0;
  let nulls = 0;
  let firstRaw: RawEvent | undefined;

  for await (const raw of adapter.read()) {
    rows++;
    if (firstRaw === undefined) firstRaw = raw;
    if (raw.originPath !== undefined) files.add(raw.originPath);
    const event = adapter.normalize(raw);
    if (event === null) {
      nulls++;
      continue;
    }
    const result = validateEvent(event);
    if (!result.ok) failures.push({ source: adapter.id, errors: result.errors, event });
    events.push(event);
  }
  return { source: adapter.id, files: files.size, rows, events, nulls, failures, firstRaw };
}

/** Within one adapter, ordinals must be strictly increasing per sessionId. */
function assertOrdinalsMonotonic(report: SourceReport): void {
  const bySession = new Map<string, Event[]>();
  for (const event of report.events) {
    const list = bySession.get(event.sessionId);
    if (list === undefined) bySession.set(event.sessionId, [event]);
    else list.push(event);
  }
  for (const [sessionId, list] of bySession) {
    list.sort((a, b) => a.ordinal - b.ordinal);
    let previous: Event | undefined;
    for (const event of list) {
      if (previous !== undefined && event.ordinal <= previous.ordinal) {
        fail(
          `${report.source}: ordinal is not strictly increasing in session "${sessionId}": ` +
            `${previous.ordinal} (${previous.kind}) then ${event.ordinal} (${event.kind}) — duplicate or regressed ordinals break dedup`,
        );
      }
      previous = event;
    }
  }
}

function assertPrivacyRejects(value: unknown, label: string): void {
  try {
    assertExportable(value);
  } catch (err) {
    if (err instanceof PrivacyViolationError) return;
    fail(`assertExportable(${label}) threw ${String(err)} — expected PrivacyViolationError`);
  }
  fail(`privacy leak: assertExportable() accepted a ${label}`);
}

function minMaxTs(events: readonly Event[]): { min: number; max: number } | undefined {
  if (events.length === 0) return undefined;
  let min = Number.POSITIVE_INFINITY;
  let max = 0;
  for (const event of events) {
    if (event.ts < min) min = event.ts;
    if (event.ts > max) max = event.ts;
  }
  return { min, max };
}

function printSummary(reports: readonly SourceReport[]): void {
  const header = ['source', 'files', 'rows', 'events', 'nulls', 'min ts', 'max ts'];
  const rows = reports.map((report) => {
    const range = minMaxTs(report.events);
    return [
      report.source,
      String(report.files),
      String(report.rows),
      String(report.events.length),
      String(report.nulls),
      range === undefined ? '—' : new Date(range.min).toISOString(),
      range === undefined ? '—' : new Date(range.max).toISOString(),
    ];
  });
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => row[column]?.length ?? 0)),
  );
  const line = (cells: readonly string[]) =>
    cells.map((cell, column) => cell.padEnd(widths[column] ?? cell.length)).join('  ').trimEnd();

  console.log('');
  console.log(line(header));
  for (const row of rows) console.log(line(row));
}

async function main(): Promise<void> {
  const registry = defaultRegistry();
  for (const id of REQUIRED_SOURCES) {
    if (registry.get(id) === undefined) fail(`builtin adapter "${id}" is missing from the registry`);
  }

  // 2-4: stream every detected adapter, validate, check ordinals and text.
  const reports: SourceReport[] = [];
  let firstRaw: RawEvent | undefined;
  let firstEventWithText: Event | undefined;

  for (const adapter of registry.list()) {
    const required = (REQUIRED_SOURCES as readonly string[]).includes(adapter.id);
    if (!(await adapter.detect())) {
      if (required) fail(`builtin source "${adapter.id}" detects no data on this machine`);
      console.log(`skip: ${adapter.id} (no data detected)`);
      continue;
    }
    const report = await streamSource(adapter);
    if (report.failures.length > 0) {
      const shown = report.failures.slice(0, 5);
      const details = shown
        .map((failure) => JSON.stringify(failure, null, 2))
        .join('\n');
      const suffix =
        report.failures.length > shown.length ? `\n(${report.failures.length - shown.length} more not shown)` : '';
      fail(`${report.failures.length} event(s) from "${adapter.id}" failed validateEvent(); first ${shown.length}:\n${details}${suffix}`);
    }
    assertOrdinalsMonotonic(report);
    reports.push(report);
    if (firstRaw === undefined) firstRaw = report.firstRaw;
    if (firstEventWithText === undefined) firstEventWithText = report.events.find(hasText);
  }

  for (const id of REQUIRED_SOURCES) {
    const report = reports.find((candidate) => candidate.source === id);
    if (report === undefined) fail(`source "${id}" produced no report`);
    if (!report.events.some(hasText)) fail(`source "${id}" produced no event with non-empty text`);
  }

  const allEvents = reports.flatMap((report) => report.events);

  // 5: store ingest — lossless, idempotent, summarizable.
  const tempDir = mkdtempSync(join(tmpdir(), 'agent-memoir-verify-'));
  const store = new MemoirStore(join(tempDir, 'events.db'));
  try {
    const first = store.appendMany(allEvents);
    const count = store.count();
    if (first.inserted !== allEvents.length || count !== allEvents.length) {
      const counts = new Map<string, number>();
      for (const event of allEvents) counts.set(event.id, (counts.get(event.id) ?? 0) + 1);
      const duplicates = [...counts].filter(([, n]) => n > 1).slice(0, 10);
      fail(
        `store ingest lost events: fed ${allEvents.length}, inserted ${first.inserted}, count() ${count}\n` +
          `duplicate ids (first 10): ${JSON.stringify(duplicates)}\n${JSON.stringify(first)}`,
      );
    }

    const second = store.appendMany(allEvents);
    if (second.inserted !== 0 || second.ignored !== allEvents.length) {
      fail(
        `appendMany is not idempotent: expected inserted=0 ignored=${allEvents.length}, got ${JSON.stringify(second)}`,
      );
    }

    const summaries = store.sourceSummaries();
    for (const id of REQUIRED_SOURCES) {
      const row = summaries.find((summary) => summary.source === id);
      if (row === undefined) fail(`sourceSummaries() has no row for "${id}" — sources={${summaries.map((s) => s.source).join(', ')}}`);
      if (row.count <= 0) fail(`sourceSummaries()["${id}"].count must be > 0, got ${row.count}`);
      if (!Number.isFinite(row.minTs) || !Number.isFinite(row.maxTs)) {
        fail(`sourceSummaries()["${id}"] has non-finite ts range: ${JSON.stringify(row)}`);
      }
      if (row.minTs < EPOCH_FLOOR || row.maxTs < row.minTs || row.maxTs > Date.now() + FUTURE_SLACK_MS) {
        fail(
          `sourceSummaries()["${id}"] has an implausible ts range: ` +
            `${new Date(row.minTs).toISOString()} .. ${new Date(row.maxTs).toISOString()}`,
        );
      }
    }

    // 6: privacy boundary.
    const insight: Insight = {
      kind: 'insight',
      summary: 'phase 0 gate: builtin sources normalized into one Event stream',
      data: { sources: reports.length, events: allEvents.length },
    };
    assertExportable(insight); // must accept a real Insight
    if (firstEventWithText === undefined) fail('no event with text to test the privacy boundary with');
    assertPrivacyRejects(firstEventWithText, 'Event');
    if (firstRaw === undefined) fail('no raw record to test the privacy boundary with');
    assertPrivacyRejects(firstRaw, 'RawEvent');

    console.log(
      `privacy boundary: Insight accepted; Event and RawEvent rejected with PrivacyViolationError`,
    );
    console.log(`store: ${allEvents.length} events ingested, re-append inserted 0 (idempotent)`);
    printSummary(reports);
  } finally {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

try {
  await main();
  const total = 'PASS';
  console.log(`\n${total} — all ${REQUIRED_SOURCES.length} sources verified.`);
  process.exit(0);
} catch (err) {
  if (err instanceof GateFailure) {
    console.error(`\nFAIL — ${err.message}`);
  } else {
    console.error('\nFAIL — unexpected error while running the gate:');
    console.error(err);
  }
  process.exit(1);
}
