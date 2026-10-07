/**
 * Adapter contract — the ONLY place where per-source code exists.
 *
 * Adding a new agent = implementing this interface + registering it in
 * registry.json. Nothing in normalize/store/analyze knows about sources.
 */

import type { Event, EventSource } from './event.ts';
import type { RawEvent } from './privacy.ts';

export interface Adapter {
  /** Same id used in Event.source and in registry.json. */
  readonly id: EventSource;
  /** True if this machine has data for this source. Must be read-only. */
  detect(): Promise<boolean>;
  /** Stream raw records off disk/db. Read-only, lazily evaluated. */
  read(): AsyncIterable<RawEvent>;
  /** Original record → unified Event. Return null for records that don't map. */
  normalize(raw: RawEvent): Event | null;
  /** Source locations on this machine, for debugging and `init` output. */
  sourcePaths(): string[];
}
