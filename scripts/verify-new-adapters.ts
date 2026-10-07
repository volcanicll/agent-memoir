/**
 * Real-data gate for the opencode / pi / gemini / grok adapters.
 *
 * Mirrors verify-adapters.ts, but for the four sources added after Phase 2.
 * A source that is absent on this machine is skipped (detect() false), so the
 * gate also proves the detect() semantics on this very machine. Exits
 * non-zero on failure.
 */

import { OpencodeAdapter } from '../src/adapters/opencode/index.ts';
import { PiAdapter } from '../src/adapters/pi/index.ts';
import { GeminiAdapter } from '../src/adapters/gemini/index.ts';
import { GrokAdapter } from '../src/adapters/grok/index.ts';
import { validateEvent, type Event } from '../src/core/event.ts';
import type { Adapter } from '../src/core/adapter.ts';

class TestFailure extends Error {}

function check(condition: boolean, message: string): void {
  if (!condition) throw new TestFailure(message);
}

async function drain(adapter: Adapter): Promise<{ raws: number; events: Event[] }> {
  let raws = 0;
  const events: Event[] = [];
  for await (const raw of adapter.read()) {
    raws++;
    const event = adapter.normalize(raw);
    if (event !== null) {
      const result = validateEvent(event);
      check(result.ok, `${adapter.id}: event failed validateEvent(): ${JSON.stringify(result.errors)}`);
      events.push(event);
    }
  }
  return { raws, events };
}

const ADAPTERS: Adapter[] = [new OpencodeAdapter(), new PiAdapter(), new GeminiAdapter(), new GrokAdapter()];

for (const adapter of ADAPTERS) {
  const detected = await adapter.detect();
  if (!detected) {
    console.log(`${adapter.id}: not detected on this machine — skipped`);
    continue;
  }
  const { raws, events } = await drain(adapter);
  const sessions = new Set(events.map((event) => event.sessionId)).size;
  check(sessions > 0, `${adapter.id}: no sessions found despite detect() true`);

  // Sources that never persist a session-start marker (OpenCode has no such
  // row; its sessions exist purely as message groups) still must group.
  if (adapter.id !== 'opencode') {
    const kinds = new Set(events.map((event) => event.kind));
    check(kinds.has('session_start'), `${adapter.id}: no session_start among kinds`);
  }

  // Ordinal stability + monotonicity per session, as the incremental-dedup
  // contract requires.
  const bySession = new Map<string, Event[]>();
  for (const event of events) {
    const list = bySession.get(event.sessionId) ?? [];
    list.push(event);
    bySession.set(event.sessionId, list);
  }
  for (const [sessionId, list] of bySession) {
    for (let i = 1; i < list.length; i++) {
      check(list[i]!.ordinal > list[i - 1]!.ordinal, `${adapter.id}: non-monotonic ordinal in ${sessionId}`);
    }
  }
  const second = await drain(adapter);
  check(
    events.map((e) => e.id).join() === second.events.map((e) => e.id).join(),
    `${adapter.id}: ids not stable across re-reads`,
  );
  console.log(`${adapter.id}: ${raws} raws -> ${events.length} events across ${sessions} sessions`);
}
