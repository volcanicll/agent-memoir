/**
 * Fixture-based tests for the two paths the real-data gate cannot reach.
 *
 * `bun run verify` proves the adapters against this machine's actual histories,
 * but two guarantees can never be exercised that way:
 *
 *   1. `detect()` must be false for a source that is absent — the real source
 *      directories all exist here, so the gate only ever sees `true`. A
 *      regression that hard-codes `return true` would pass the gate.
 *   2. Ordinal stability under re-read: the gate feeds one snapshot and checks
 *      monotonicity within it. It cannot show that reading the *same* file
 *      twice yields the *same* ids, which is what incremental sync depends on
 *      (`INSERT OR IGNORE` is only safe if ids are reproducible).
 *
 * Both are covered here with synthetic fixtures written to a temp dir — no
 * real source directory is touched. Exits non-zero on failure.
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCodeAdapter } from '../src/adapters/claude-code/index.ts';
import { CodexAdapter } from '../src/adapters/codex/index.ts';
import { HermesAdapter } from '../src/adapters/hermes/index.ts';
import { validateEvent, type Event } from '../src/core/event.ts';
import type { Adapter } from '../src/core/adapter.ts';
import type { RawEvent } from '../src/core/privacy.ts';

class TestFailure extends Error {}

function check(condition: boolean, message: string): void {
  if (!condition) throw new TestFailure(message);
}

/** Drain an adapter into Events, keeping the raw records alongside. */
async function drain(adapter: Adapter): Promise<{ raws: RawEvent[]; events: Event[] }> {
  const raws: RawEvent[] = [];
  const events: Event[] = [];
  for await (const raw of adapter.read()) {
    raws.push(raw);
    const event = adapter.normalize(raw);
    if (event !== null) {
      const result = validateEvent(event);
      check(result.ok, `${adapter.id}: fixture event failed validateEvent(): ${JSON.stringify(result.errors)}`);
      events.push(event);
    }
  }
  return { raws, events };
}

/** A Claude JSONL fixture: one user turn, one assistant turn with a tool call. */
const CLAUDE_LINES = [
  {
    parentUuid: null,
    isSidechain: false,
    promptId: 'p-1',
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: 'hello fixture' }] },
    uuid: 'u-1',
    timestamp: '2026-09-01T10:00:00.000Z',
    cwd: '/tmp/fixture',
    sessionId: 'sess-fixture',
    version: '2.1.0',
    gitBranch: 'main',
  },
  {
    parentUuid: 'u-1',
    isSidechain: false,
    type: 'assistant',
    message: {
      content: [
        { type: 'thinking', thinking: 'pondering', signature: '' },
        { type: 'tool_use', id: 'call-1', name: 'Read', input: { path: '/tmp/x' } },
      ],
      id: 'msg-1',
      model: 'test-model',
      role: 'assistant',
      stop_reason: 'tool_use',
    },
    uuid: 'a-1',
    timestamp: '2026-09-01T10:00:01.000Z',
    cwd: '/tmp/fixture',
    sessionId: 'sess-fixture',
    version: '2.1.0',
    gitBranch: 'main',
  },
  {
    parentUuid: 'a-1',
    isSidechain: false,
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'file body' }],
    },
    uuid: 'u-2',
    timestamp: '2026-09-01T10:00:02.000Z',
    cwd: '/tmp/fixture',
    sessionId: 'sess-fixture',
    version: '2.1.0',
    gitBranch: 'main',
  },
  // telemetry row: must survive as a raw record and normalize to null
  { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-09-01T10:00:03.000Z', sessionId: 'sess-fixture' },
];

/** A Codex rollout fixture: session_meta + a user turn + a tool call/output pair. */
const CODEX_LINES = [
  {
    timestamp: '2026-09-01T11:00:00.000Z',
    ordinal: 0,
    type: 'session_meta',
    payload: {
      session_id: 'sess-codex-fixture',
      id: 'sess-codex-fixture',
      timestamp: '2026-09-01T11:00:00.000Z',
      cwd: '/tmp/fixture',
      originator: 'codex_cli_rs',
      cli_version: '0.80.0',
      source: 'cli',
      model_provider: 'custom',
    },
  },
  {
    timestamp: '2026-09-01T11:00:01.000Z',
    ordinal: 1,
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'codex fixture prompt' }] },
  },
  {
    timestamp: '2026-09-01T11:00:02.000Z',
    ordinal: 2,
    type: 'turn_context',
    payload: { cwd: '/tmp/fixture', model: 'gpt-5.2', effort: 'high' },
  },
  {
    timestamp: '2026-09-01T11:00:03.000Z',
    ordinal: 3,
    type: 'response_item',
    payload: { type: 'function_call', name: 'shell_command', arguments: '{"command":"ls"}', call_id: 'call-9' },
  },
  {
    timestamp: '2026-09-01T11:00:04.000Z',
    ordinal: 4,
    type: 'response_item',
    payload: { type: 'function_call_output', call_id: 'call-9', output: 'Exit code: 0\nOutput:\nLICENSE' },
  },
  // telemetry: raw survives, normalize -> null
  {
    timestamp: '2026-09-01T11:00:05.000Z',
    ordinal: 5,
    type: 'event_msg',
    payload: { type: 'token_count', info: null },
  },
];

function writeJsonl(path: string, lines: readonly unknown[]): void {
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8');
}

async function testDetectOnAbsentSource(root: string): Promise<string[]> {
  const notes: string[] = [];
  const missing = join(root, 'definitely-not-here');

  const claude = new ClaudeCodeAdapter(missing);
  check((await claude.detect()) === false, 'ClaudeCodeAdapter.detect() must be false for an absent root');
  const claudeDrained = await drain(claude);
  check(
    claudeDrained.raws.length === 0 && claudeDrained.events.length === 0,
    `ClaudeCodeAdapter.read() on an absent root must yield nothing, got ${claudeDrained.raws.length} raw records`,
  );
  notes.push('claude-code: absent root → detect() false, read() empty');

  const codex = new CodexAdapter(missing);
  check((await codex.detect()) === false, 'CodexAdapter.detect() must be false for an absent root');
  const codexDrained = await drain(codex);
  check(
    codexDrained.raws.length === 0 && codexDrained.events.length === 0,
    `CodexAdapter.read() on an absent root must yield nothing, got ${codexDrained.raws.length} raw records`,
  );
  notes.push('codex: absent root → detect() false, read() empty');

  const hermes = new HermesAdapter(join(missing, 'state.db'));
  check((await hermes.detect()) === false, 'HermesAdapter.detect() must be false for an absent db path');
  const hermesDrained = await drain(hermes);
  check(
    hermesDrained.raws.length === 0,
    `HermesAdapter.read() on an absent db must yield nothing, got ${hermesDrained.raws.length} raw records`,
  );
  notes.push('hermes: absent db → detect() false, read() empty');

  return notes;
}

async function testOrdinalStability(root: string): Promise<string[]> {
  const notes: string[] = [];

  const claudeRoot = join(root, 'claude');
  mkdirSync(join(claudeRoot, 'proj-a'), { recursive: true });
  const claudeFile = join(claudeRoot, 'proj-a', 'session.jsonl');
  writeJsonl(claudeFile, CLAUDE_LINES);

  const claude = new ClaudeCodeAdapter(claudeRoot);
  check(await claude.detect(), 'ClaudeCodeAdapter must detect the fixture root');
  const firstRead = await drain(claude);
  const secondRead = await drain(claude);

  check(
    firstRead.events.length === secondRead.events.length,
    `claude-code: re-read changed the event count (${firstRead.events.length} then ${secondRead.events.length})`,
  );
  const firstIds = firstRead.events.map((event) => event.id);
  const secondIds = secondRead.events.map((event) => event.id);
  check(
    JSON.stringify(firstIds) === JSON.stringify(secondIds),
    'claude-code: event ids are not reproducible across two reads of the same file — ' +
      'incremental INSERT OR IGNORE would double-insert',
  );
  const firstOrdinals = firstRead.events.map((event) => event.ordinal);
  const secondOrdinals = secondRead.events.map((event) => event.ordinal);
  check(
    JSON.stringify(firstOrdinals) === JSON.stringify(secondOrdinals),
    'claude-code: ordinals are not reproducible across two reads of the same file',
  );
  check(firstRead.events.length > 0, 'claude-code: fixture produced no events');
  notes.push(`claude-code: ${firstRead.events.length} events, ids stable across re-read`);

  const codexRoot = join(root, 'codex');
  mkdirSync(join(codexRoot, '2026', '09', '01'), { recursive: true });
  writeJsonl(
    join(codexRoot, '2026', '09', '01', 'rollout-2026-09-01T11-00-00-sess-codex-fixture.jsonl'),
    CODEX_LINES,
  );

  const codex = new CodexAdapter(codexRoot);
  check(await codex.detect(), 'CodexAdapter must detect the fixture root');
  const codexFirst = await drain(codex);
  const codexSecond = await drain(codex);

  check(codexFirst.events.length > 0, 'codex: fixture produced no events');
  check(
    JSON.stringify(codexFirst.events.map((e) => e.id)) === JSON.stringify(codexSecond.events.map((e) => e.id)),
    'codex: event ids are not reproducible across two reads of the same file',
  );
  check(
    JSON.stringify(codexFirst.events.map((e) => e.ordinal)) ===
      JSON.stringify(codexSecond.events.map((e) => e.ordinal)),
    'codex: ordinals are not reproducible across two reads of the same file',
  );

  // The line's own `ordinal` field must drive the sequence, not line position:
  // the fixture's ordinals are 0,1,3,4,5 with 2 being telemetry, so the
  // surviving events must inherit 3 and 4 for the tool call/output.
  const toolCall = codexFirst.events.find((event) => event.kind === 'tool_call');
  const toolResult = codexFirst.events.find((event) => event.kind === 'tool_result');
  check(toolCall !== undefined, 'codex: fixture produced no tool_call event');
  check(toolResult !== undefined, 'codex: fixture produced no tool_result event');
  if (toolCall === undefined || toolResult === undefined) {
    throw new TestFailure('codex: fixture produced no tool_call/tool_result pair');
  }
  check(
    toolCall.ordinal < toolResult.ordinal,
    `codex: tool_call ordinal ${toolCall.ordinal} must precede tool_result ordinal ${toolResult.ordinal}`,
  );
  notes.push(`codex: ${codexFirst.events.length} events, ids stable across re-read`);

  return notes;
}

async function testTelemetryIsNotDropped(root: string): Promise<string[]> {
  const notes: string[] = [];
  const claudeRoot = join(root, 'claude-telemetry');
  mkdirSync(join(claudeRoot, 'p'), { recursive: true });
  writeJsonl(join(claudeRoot, 'p', 's.jsonl'), CLAUDE_LINES);

  const claude = new ClaudeCodeAdapter(claudeRoot);
  const drained = await drain(claude);
  const telemetry = drained.raws.filter((raw) => {
    const payload = raw.payload as { row?: { type?: unknown } } | undefined;
    return payload?.row?.type === 'queue-operation';
  });
  check(
    telemetry.length > 0,
    'claude-code: a telemetry row must still surface as a RawEvent (nothing may be dropped before normalize)',
  );
  notes.push('claude-code: telemetry rows survive as RawEvent and normalize to null');

  const codexRoot = join(root, 'codex-telemetry');
  mkdirSync(join(codexRoot, '2026', '09', '01'), { recursive: true });
  writeJsonl(join(codexRoot, '2026', '09', '01', 'rollout-x.jsonl'), CODEX_LINES);
  const codex = new CodexAdapter(codexRoot);
  const codexDrained = await drain(codex);
  check(
    codexDrained.raws.length === CODEX_LINES.length,
    `codex: read() must yield one RawEvent per line (${CODEX_LINES.length}), got ${codexDrained.raws.length}`,
  );
  check(
    codexDrained.events.length < codexDrained.raws.length,
    'codex: telemetry lines must normalize to null, so events < raw records',
  );
  notes.push(`codex: ${codexDrained.raws.length} lines → ${codexDrained.events.length} events (telemetry → null)`);

  return notes;
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'agent-memoir-fixtures-'));
  try {
    const notes: string[] = [];
    notes.push(...(await testDetectOnAbsentSource(root)));
    notes.push(...(await testOrdinalStability(root)));
    notes.push(...(await testTelemetryIsNotDropped(root)));
    console.log('fixture checks:');
    for (const note of notes) console.log(`  ✓ ${note}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

try {
  await main();
  console.log('\nPASS — fixture checks passed.');
  process.exit(0);
} catch (err) {
  if (err instanceof TestFailure) {
    console.error(`\nFAIL — ${err.message}`);
  } else {
    console.error('\nFAIL — unexpected error:');
    console.error(err);
  }
  process.exit(1);
}
