/**
 * Shared test fixtures. Event construction goes through one helper so tests
 * stay readable and every field default is explicit.
 */

import type { Event, EventKind, EventRole } from '../src/core/event.ts';

export interface EventOptions {
  source?: string;
  sessionId?: string;
  ordinal?: number;
  ts: number;
  role?: EventRole;
  kind?: EventKind;
  text?: string;
  tool?: { name: string; ok?: boolean };
  cwd?: string;
  model?: string;
  metaSource?: string;
}

let counter = 0;

export function makeEvent(options: EventOptions): Event {
  const source = options.source ?? 'hermes';
  const sessionId = options.sessionId ?? 'session-1';
  const ordinal = options.ordinal ?? counter++;
  const event: Event = {
    id: `${source}:${sessionId}:${ordinal}`,
    source,
    sessionId,
    ordinal,
    ts: options.ts,
    role: options.role ?? 'assistant',
    kind: options.kind ?? 'message',
    meta: options.metaSource === undefined ? {} : { source: options.metaSource },
  };
  if (options.text !== undefined) event.text = options.text;
  if (options.tool !== undefined) event.tool = options.tool;
  if (options.cwd !== undefined || options.model !== undefined) {
    event.refs = {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.model === undefined ? {} : { model: options.model }),
    };
  }
  return event;
}

export function resetOrdinals(): void {
  counter = 0;
}

/** Epoch ms for a local date + hour, with minutes/seconds zeroed. */
export function localTs(year: number, month1: number, day: number, hour = 12, minute = 0): number {
  return new Date(year, month1 - 1, day, hour, minute, 0, 0).getTime();
}
