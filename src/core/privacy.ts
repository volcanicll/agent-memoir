/**
 * Privacy tiers — a hard boundary enforced in the type system and at runtime.
 *
 *   RawEvent  — adapter-internal original record. Local only. Never leaves a
 *               source directory's read path.
 *   Event     — normalized, still local (contains conversation text).
 *   Insight   — the ONLY shape allowed to be serialized off this machine.
 *
 * Phase 0 ships the tier types plus an `assertExportable()` runtime guard;
 * the analytics layers that produce Insights come later and must pass
 * everything they emit through this guard.
 */

import type { Event } from './event.ts';

/** Adapter-internal original record. Local only — never exportable. */
export interface RawEvent {
  /** Adapter id that produced this record ('hermes', 'claude-code', ...). */
  source: string;
  /** The opaque original record as read from the source (row / JSON line / ...). */
  payload: unknown;
  /** Where it came from, for debugging and the blob store. */
  originPath?: string;
}

/**
 * Aggregated, content-free output. Only JSON-safe primitives, no conversation
 * text, no absolute paths. This is the single exportable shape.
 */
export interface Insight {
  readonly kind: 'insight';
  /** What this insight claims, in aggregate terms. */
  readonly summary: string;
  /** Aggregates only — counts, durations, distributions. No raw content. */
  readonly data: Record<string, number | string | boolean | null>;
}

export class PrivacyViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrivacyViolationError';
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Runtime guard: throws unless `value` is exactly an Insight.
 * Anything else — Event, RawEvent, plain objects — is a privacy violation
 * trying to cross the export boundary.
 */
export function assertExportable(value: unknown): asserts value is Insight {
  if (!isPlainObject(value)) {
    throw new PrivacyViolationError('export rejected: value is not an object');
  }
  const v = value as Record<string, unknown>;
  if (v.kind !== 'insight') {
    throw new PrivacyViolationError(
      `export rejected: expected Insight (kind="insight"), got kind=${JSON.stringify(v.kind)}`,
    );
  }
  if (typeof v.summary !== 'string' || v.summary.length === 0) {
    throw new PrivacyViolationError('export rejected: Insight.summary must be a non-empty string');
  }
  if (!isPlainObject(v.data)) {
    throw new PrivacyViolationError('export rejected: Insight.data must be an object');
  }
  for (const [k, x] of Object.entries(v.data)) {
    const t = typeof x;
    if (t !== 'number' && t !== 'string' && t !== 'boolean' && x !== null) {
      throw new PrivacyViolationError(
        `export rejected: Insight.data.${k} has non-primitive value of type ${t}`,
      );
    }
  }
}
