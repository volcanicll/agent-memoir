/**
 * Phase 1 verification gate — `bun run verify:portrait`.
 *
 * Proves, against a FIXED synthetic fixture (never this machine's data, so
 * the run is reproducible), that:
 *
 *   1. the fixture ingests into MemoirStore losslessly and idempotently,
 *   2. the session classifier splits it exactly as the fixture's arithmetic
 *      says: cron is automation, telegram is interactive, and 6 automation
 *      events never appear in an interactive series,
 *   3. the rhythm series contain the zero days — the quiet days 3 and 7 —
 *      and the streak/gap math returns hand-computed values (3/1 interactive,
 *      10/0 all),
 *   4. a project folds three cwds into one root, with home redacted,
 *   5. drift reports the planted move: halves of exactly 242 events, project
 *      shares swinging ±59.5pp, tools ±50pp, a term arriving and one leaving,
 *   6. the rendered site's three files are written and non-trivial,
 *   7. the page is not blank: headless Chrome's PNG is substantially larger
 *      than a blank page's, AND `--dump-dom` shows the section markers and
 *      real numbers, and no home path or session id,
 *   8. `cli export` emits an Insight that passes assertExportable() and
 *      contains no path, no session id, no conversation text.
 *
 * A green run means the gate passed, not merely that the script ran: every
 * check exits non-zero with a printed reason on failure.
 *
 * Chrome notes (macOS): the binary at /Applications/Google Chrome.app prints
 * "CVDisplayLinkCreateWithCGDisplay failed" and "Trying to load the allocator
 * multiple times" to stderr. Both are harmless; the PNG/DOM are still
 * produced. This gate therefore judges Chrome by its OUTPUT, never by its
 * exit code or stderr.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeAll } from '../src/analyze/index.ts';
import { HOME_REDACTION } from '../src/analyze/redact.ts';
import { streakAndGap } from '../src/analyze/rhythm.ts';
import { validateEvent } from '../src/core/event.ts';
import { assertExportable, PrivacyViolationError } from '../src/core/privacy.ts';
import { renderPortrait } from '../src/render/portrait.ts';
import { MemoirStore } from '../src/store/sqlite.ts';
import { buildPortraitFixture, EXPECTED, PROJECT_A_REDACTED, SESSION_ID_MARKER } from './fixtures/portrait-fixture.ts';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const VIEWPORT = '1200,1800';

/**
 * Minimum byte size for the rendered screenshot.
 *
 * A blank 1200x1800 page is a single flat fill, which PNG compresses to a few
 * KB. The portrait cannot: it contains thousands of antialiased SVG marks and
 * a full page of shaped text, all of which cost bytes. 20 KB is an order of
 * magnitude above a blank page and an order of magnitude below the measured
 * portrait (~320 KB on real data), so it cannot pass a blank render and
 * cannot fail a real one. The gate ALSO compares against a blank page rendered
 * in the same run, which is the real test; the constant is the floor.
 */
const MIN_PNG_BYTES = 20_000;
/** Same reasoning for the generated files: a stub page cannot reach these. */
const MIN_HTML_BYTES = 8_000;
const MIN_CSS_BYTES = 4_000;
const MIN_JS_BYTES = 1_500;

class GateFailure extends Error {}

function fail(message: string): never {
  throw new GateFailure(message);
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertClose(actual: number, expected: number, tolerance: number, label: string): void {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > tolerance) {
    fail(`${label}: expected ${expected} ± ${tolerance}, got ${actual}`);
  }
}

function assertDeepEqual(actual: readonly number[], expected: readonly number[], label: string): void {
  if (actual.length !== expected.length) {
    fail(`${label}: length ${actual.length}, expected ${expected.length} (${JSON.stringify(actual)})`);
  }
  for (let i = 0; i < expected.length; i++) {
    if (actual[i] !== expected[i]) {
      fail(`${label}: index ${i} is ${actual[i]}, expected ${expected[i]} (got ${JSON.stringify(actual)})`);
    }
  }
}

function human(n: number): string {
  return n.toLocaleString('en-US');
}

// ------------------------------------------------------------- chrome helpers

function runChrome(args: readonly string[]): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(CHROME, ['--headless', '--disable-gpu', '--hide-scrollbars', ...args], {
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 256 * 1024 * 1024,
  });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
}

function screenshot(url: string, outPath: string): void {
  runChrome([`--screenshot=${outPath}`, `--window-size=${VIEWPORT}`, '--virtual-time-budget=5000', url]);
  if (!existsSync(outPath)) {
    fail(`headless Chrome produced no screenshot at ${outPath} (is Chrome at "${CHROME}"?)`);
  }
}

function dumpDom(url: string): string {
  const { stdout, status } = runChrome(['--dump-dom', '--virtual-time-budget=5000', url]);
  if (stdout.length === 0) {
    fail(`headless Chrome --dump-dom returned nothing (exit ${String(status)}); cannot verify the DOM`);
  }
  return stdout;
}

// ---------------------------------------------------------------------- main

async function main(): Promise<void> {
  if (!existsSync(CHROME)) {
    fail(`headless Chrome not found at ${CHROME}; the render gate cannot run`);
  }

  // 1. Build the fixture and ingest it into a throwaway store.
  const { events, expected } = buildPortraitFixture();
  for (const event of events) {
    const result = validateEvent(event);
    if (!result.ok) {
      fail(`fixture produced an invalid Event ${event.id}: ${JSON.stringify(result.errors)}`);
    }
  }
  assertEqual(events.length, expected.totals.events, 'fixture event count');

  const tempDir = mkdtempSync(join(tmpdir(), 'agent-memoir-portrait-gate-'));
  const dbPath = join(tempDir, 'fixture.db');
  const store = new MemoirStore(dbPath);
  try {
    const first = store.appendMany(events);
    assertEqual(first.inserted, expected.totals.events, 'fixture insert count');
    const second = store.appendMany(events);
    assertEqual(second.inserted, 0, 'fixture re-insert must be a no-op');
    assertEqual(store.count(), expected.totals.events, 'fixture store count');

    // 2-5. Run the whole analysis and assert the hand-computed numbers.
    const portrait = analyzeAll(store);

    assertEqual(portrait.span.days, expected.spanDays, 'span days');
    assertEqual(portrait.totals.sessions, expected.totals.sessions, 'total sessions');
    assertEqual(portrait.totals.events, expected.totals.events, 'total events');
    assertEqual(portrait.totals.byClass.interactive.sessions, expected.interactive.sessions, 'interactive sessions');
    assertEqual(portrait.totals.byClass.interactive.events, expected.interactive.events, 'interactive events');
    assertEqual(portrait.totals.byClass.automation.sessions, expected.automation.sessions, 'automation sessions');
    assertEqual(portrait.totals.byClass.automation.events, expected.automation.events, 'automation events');
    assertEqual(portrait.totals.byClass.other.sessions, 0, 'other sessions');

    const interactive = portrait.views.interactive;
    const all = portrait.views.all;

    // The cron session must be absent from the interactive view: 6 events.
    assertEqual(
      all.events - interactive.events,
      expected.automation.events,
      'interactive view must exclude exactly the automation events',
    );

    assertDeepEqual(
      interactive.rhythm.daySeries.map((point) => point.count),
      expected.interactiveDayCounts,
      'interactive day series (zero days included)',
    );
    assertDeepEqual(
      all.rhythm.daySeries.map((point) => point.count),
      expected.allDayCounts,
      'all-session day series',
    );
    // The zero days are the point: interactive has them, "all" does not.
    if (!interactive.rhythm.daySeries.some((point) => point.count === 0)) {
      fail('interactive day series contains no zero days — cron traffic leaked into the view');
    }
    if (all.rhythm.daySeries.some((point) => point.count === 0)) {
      fail('all-session day series unexpectedly has a zero day; the fixture no longer contrasts the views');
    }

    assertEqual(interactive.rhythm.longestStreakDays, expected.interactiveStreak, 'interactive longest streak');
    assertEqual(interactive.rhythm.longestGapDays, expected.interactiveGap, 'interactive longest gap');
    assertEqual(interactive.rhythm.activeDays, expected.interactiveActiveDays, 'interactive active days');
    assertEqual(all.rhythm.longestStreakDays, expected.allStreak, 'all longest streak');
    assertEqual(all.rhythm.longestGapDays, expected.allGap, 'all longest gap');

    // Streak/gap edge cases, hand-checked, independent of the fixture.
    const singleDay = streakAndGap([5]);
    assertEqual(singleDay.streak, 1, 'single-day streak');
    assertEqual(singleDay.gap, 0, 'single-day gap');
    const allZero = streakAndGap([0, 0, 0]);
    assertEqual(allZero.streak, 0, 'all-zero streak');
    assertEqual(allZero.gap, 0, 'all-zero gap');

    // Projects: three cwds fold into one root, and the path is redacted.
    const projectA = interactive.projects.projects.find((project) => project.root === PROJECT_A_REDACTED);
    if (projectA === undefined) {
      fail(
        `project root ${PROJECT_A_REDACTED} not found; got ${JSON.stringify(interactive.projects.projects.map((p) => p.root))}`,
      );
    }
    assertEqual(projectA.sessions, expected.projectA.sessions, 'proj-a sessions');
    assertEqual(projectA.cwds, expected.projectA.cwds, 'proj-a folded cwds');
    assertEqual(projectA.events, expected.projectA.events, 'proj-a events');
    const projectB = interactive.projects.projects.find((project) => project.name === 'proj-b');
    if (projectB === undefined) fail('project proj-b not found');
    assertEqual(projectB.sessions, expected.projectB.sessions, 'proj-b sessions');
    assertEqual(projectB.events, expected.projectB.events, 'proj-b events');
    assertEqual(
      interactive.projects.unlocatedSessions,
      expected.unlocatedInteractiveSessions,
      'unlocated interactive sessions (telegram has no cwd)',
    );

    // Drift: the planted move, in both directions, on every series.
    const drift = interactive.drift;
    if (drift === null) fail('interactive drift is null; the fixture has enough events to compare');
    if (!drift.enoughData) fail(`interactive drift refused to report: ${drift.reason}`);
    assertEqual(drift.eventsBefore, expected.drift.eventsBefore, 'drift events before split');
    assertEqual(drift.eventsAfter, expected.drift.eventsAfter, 'drift events after split');

    const moveA = drift.projectMoves.find((move) => move.label.endsWith('proj-a'));
    if (moveA === undefined) fail('drift did not report the planted proj-a move');
    assertClose(moveA.deltaPp, expected.drift.projectADeltaPp, 0.1, 'proj-a drift delta');
    const moveB = drift.projectMoves.find((move) => move.label.endsWith('proj-b'));
    if (moveB === undefined) fail('drift did not report the planted proj-b move');
    assertClose(moveB.deltaPp, expected.drift.projectBDeltaPp, 0.1, 'proj-b drift delta');

    const bashMove = drift.toolMoves.find((move) => move.label === 'Bash');
    if (bashMove === undefined) fail('drift did not report the planted Bash move');
    assertClose(bashMove.deltaPp, expected.drift.bashDeltaPp, 0.1, 'Bash drift delta');
    const readMove = drift.toolMoves.find((move) => move.label === 'Read');
    if (readMove === undefined) fail('drift did not report the planted Read move');
    assertClose(readMove.deltaPp, expected.drift.readDeltaPp, 0.1, 'Read drift delta');

    const arrived = drift.risingTerms.find((move) => move.term === expected.newTerm);
    if (arrived === undefined || arrived.direction !== 'new') {
      fail(`drift did not report term "${expected.newTerm}" as new; got ${JSON.stringify(drift.risingTerms)}`);
    }
    const departed = drift.fallingTerms.find((move) => move.term === expected.goneTerm);
    if (departed === undefined || departed.direction !== 'gone') {
      fail(`drift did not report term "${expected.goneTerm}" as gone; got ${JSON.stringify(drift.fallingTerms)}`);
    }

    // Vocabulary: the top term is the fixture's most-repeated word.
    const top = interactive.vocabulary.topTerms[0];
    if (top === undefined || top.term !== expected.topTerm.term) {
      fail(`top term: expected "${expected.topTerm.term}", got ${JSON.stringify(top)}`);
    }
    assertEqual(top.count, expected.topTerm.count, 'top term count');

    // 6. Render the site and check the files are non-trivial.
    const outDir = join(tempDir, 'site');
    const files = await renderPortrait(portrait, outDir);
    const floors = [['index.html', MIN_HTML_BYTES], ['portrait.css', MIN_CSS_BYTES], ['portrait.js', MIN_JS_BYTES]] as const;
    for (const [name, floor] of floors) {
      const path = join(outDir, name);
      if (!existsSync(path)) fail(`renderPortrait did not write ${path} (returned ${JSON.stringify(files)})`);
      const size = statSync(path).size;
      if (size < floor) fail(`${name} is only ${size} bytes; a real page cannot be under ${floor}: ${path}`);
    }

    const indexHtml = readFileSync(join(outDir, 'index.html'), 'utf8');
    // 7. The page must be self-contained and privacy-clean before we render it.
    for (const needle of ['http://', 'https://', '<script src="http']) {
      if (indexHtml.includes(needle)) fail(`index.html references the network ("${needle}") — the site must open from file://`);
    }
    if (indexHtml.includes(HOME_REDACTION)) fail(`index.html contains the raw home prefix ${HOME_REDACTION}`);
    if (indexHtml.includes(SESSION_ID_MARKER)) fail('index.html contains a session id');
    if (new RegExp(`${FIXTURE_TEXT_GUARD}`).test(indexHtml)) fail('index.html contains conversation text');

    // Headless Chrome: a blank reference and the real page, same viewport.
    const blankPath = join(tempDir, 'blank.html');
    writeFileSync(blankPath, '<!doctype html><html><body style="background:#0a0c10;margin:0"></body></html>', 'utf8');
    const blankPng = join(tempDir, 'blank.png');
    screenshot(`file://${blankPath}`, blankPng);
    const blankBytes = statSync(blankPng).size;

    const pageUrl = `file://${join(outDir, 'index.html')}`;
    const shotPath = join(outDir, 'gate-screenshot.png');
    screenshot(pageUrl, shotPath);
    const shotBytes = statSync(shotPath).size;
    if (shotBytes < MIN_PNG_BYTES) {
      fail(
        `screenshot is only ${shotBytes} bytes (< ${MIN_PNG_BYTES}); a blank page measures ${blankBytes} bytes, ` +
          `so this looks like an empty render`,
      );
    }
    if (shotBytes < blankBytes * 3) {
      fail(
        `screenshot (${shotBytes} bytes) is not substantially larger than the blank reference (${blankBytes} bytes); ` +
          `the page may be rendering empty`,
      );
    }

    const dom = dumpDom(pageUrl);
    const markers = [
      'data-section="controls"',
      'data-section="ledger"',
      'data-section="hero"',
      'data-section="rhythm"',
      'data-section="vocabulary"',
      'data-section="projects"',
      'data-section="drift"',
    ];
    for (const marker of markers) {
      if (!dom.includes(marker)) fail(`serialized DOM is missing the ${marker} section`);
    }
    // Real numbers, not just structure: the fixture's interactive totals and
    // the drift halves must be present as rendered text.
    const numbers = [
      human(expected.interactive.events), // 484 — hero caption "484 events"
      human(expected.drift.eventsBefore), // 242 — drift head "242 events before"
      human(expected.projectA.events), // 240 — project rows
      PROJECT_A_REDACTED, // the redacted project root must be visible
    ];
    for (const needle of numbers) {
      if (!dom.includes(needle)) fail(`serialized DOM does not contain the expected value "${needle}"`);
    }
    if (!dom.includes('events recorded in that hour')) {
      fail('serialized DOM is missing the hero figure note; the hero did not render');
    }
    if (dom.includes(HOME_REDACTION)) fail(`the rendered DOM leaks the home prefix ${HOME_REDACTION}`);
    if (dom.includes(SESSION_ID_MARKER)) fail('the rendered DOM leaks a session id');
    if (!/<rect[^>]+fill="hsl\(/.test(dom)) fail('the hero SVG has no data-driven marks (no hsl-filled rects in the DOM)');

    // 8. The one export path: aggregates only, accepted by the privacy guard.
    const exportRun = spawnSync('bun', ['run', join(import.meta.dir, '..', 'src', 'cli', 'index.ts'), 'export', '--db', dbPath], {
      encoding: 'utf8',
      timeout: 120_000,
    });
    if (exportRun.status !== 0) {
      fail(`cli export failed (exit ${String(exportRun.status)}): ${exportRun.stderr || exportRun.stdout}`);
    }
    let insight: unknown;
    try {
      insight = JSON.parse(exportRun.stdout);
    } catch (err) {
      fail(`cli export did not print JSON: ${String(err)}`);
    }
    try {
      assertExportable(insight);
    } catch (err) {
      if (err instanceof PrivacyViolationError) fail(`cli export emitted something assertExportable() rejects: ${err.message}`);
      throw err;
    }
    const exportText = exportRun.stdout;
    if (exportText.includes(HOME_REDACTION)) fail('cli export leaked the home prefix');
    if (exportText.includes(SESSION_ID_MARKER)) fail('cli export leaked a session id');
    // Every value must be a primitive — a nested object or array would mean
    // structure (and likely content) is crossing the boundary.
    const exportedData = (insight as { data: Record<string, unknown> }).data;
    for (const [key, value] of Object.entries(exportedData)) {
      const type = typeof value;
      if (value !== null && type !== 'string' && type !== 'number' && type !== 'boolean') {
        fail(`cli export data.${key} is a ${type}; Insight.data must be flat primitives`);
      }
    }
    if (Object.keys(exportedData).length === 0) fail('cli export produced an empty Insight.data');
    // The detailed series must declare their scope: exporting the machine's
    // schedule as though it were the person's is this phase's cardinal sin.
    if (exportedData.detail_scope !== 'interactive') {
      fail(`export detail_scope must be 'interactive', got ${JSON.stringify(exportedData.detail_scope)}`);
    }
    if (exportedData.events_interactive !== expected.interactive.events) {
      fail(
        `export events_interactive: expected ${expected.interactive.events}, got ${String(exportedData.events_interactive)}`,
      );
    }
    if (exportedData['events.automation'] !== expected.automation.events) {
      fail(
        `export events.automation: expected ${expected.automation.events}, got ${String(exportedData['events.automation'])}`,
      );
    }
    for (const word of [expected.newTerm, expected.goneTerm]) {
      if (exportText.includes(word)) fail(`cli export leaked conversation vocabulary ("${word}")`);
    }

    const summary = [
      `fixture: ${human(expected.totals.events)} events · ${human(expected.totals.sessions)} sessions · ${expected.spanDays} days`,
      `class split: interactive ${human(expected.interactive.sessions)}/${human(expected.interactive.events)} · automation ${human(expected.automation.sessions)}/${human(expected.automation.events)} · other 0`,
      `day series (interactive): [${expected.interactiveDayCounts.join(', ')}] — zeros on days 3 and 7`,
      `streak/gap: interactive ${expected.interactiveStreak}/${expected.interactiveGap} · all ${expected.allStreak}/${expected.allGap}`,
      `projects: proj-a ${expected.projectA.sessions} sessions / ${expected.projectA.cwds} cwds / ${human(expected.projectA.events)} events (redacted to ${PROJECT_A_REDACTED})`,
      `drift: ${expected.drift.eventsBefore}/${expected.drift.eventsAfter} events, proj-a ${expected.drift.projectADeltaPp.toFixed(1)}pp, Read ${expected.drift.readDeltaPp.toFixed(1)}pp, "${expected.goneTerm}" gone, "${expected.newTerm}" new`,
      `render: index.html ${statSync(join(outDir, 'index.html')).size} B · css ${statSync(join(outDir, 'portrait.css')).size} B · js ${statSync(join(outDir, 'portrait.js')).size} B`,
      `chrome: screenshot ${shotBytes} B vs blank ${blankBytes} B (${(shotBytes / blankBytes).toFixed(1)}×) · DOM ${dom.length} chars, all 7 section markers and ${numbers.length} expected values present`,
      `export: Insight accepted by assertExportable(); no paths, no session ids, no conversation words`,
    ];
    console.log(summary.join('\n'));
  } finally {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * Conversation text that must never reach the rendered site. Extending the
 * needle with a wildcard would be better, but the tokenizer would split the
 * sentence into terms and some of those legitimately appear as vocabulary —
 * so the gate checks for this exact authored phrase, not its words.
 */
const FIXTURE_TEXT_GUARD = '把监控指标补齐';

try {
  await main();
  console.log('\nPASS — portrait gate: fixture analysis, render, DOM, screenshot, and export all verified.');
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
