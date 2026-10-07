/**
 * Utilities shared by the builtin adapters. Deliberately tiny: file walking,
 * JSON guards, timestamp conversion, and the Event constructor every
 * normalize.ts funnels through so id/rawRef/meta semantics stay identical
 * across sources.
 */

import { readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  makeEventId,
  truncateText,
  type Event,
  type EventKind,
  type EventRefs,
  type EventRole,
  type EventTool,
} from '../core/event.ts';
import type { RawEvent } from '../core/privacy.ts';
import { computeRawRef } from '../blob/store.ts';

/** Recursively list files under `rootDir` whose basename matches, sorted. */
export function listFilesRecursive(rootDir: string, match: (basename: string) => boolean): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    // Structural type instead of ReturnType<typeof readdirSync>: the merged
    // @types/node + bun-types declarations disagree on Dirent's name type.
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // missing or unreadable directory — no data, not an error
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && match(entry.name)) found.push(path);
    }
  };
  walk(rootDir);
  return found.sort();
}

/** First 8 hex chars of sha256 — deterministic file-scope discriminator. */
export function shortHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 8);
}

/** JSON.parse that never throws; returns undefined for non-strings/empties. */
export function parseJsonSafe(text: unknown): unknown {
  if (typeof text !== 'string' || text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Normalize a source timestamp to epoch ms. Numbers below 1e12 are unix
 * seconds (Hermes REAL columns); strings are parsed as ISO-8601 (Claude/Codex).
 */
export function toEpochMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === 'string' && value.length > 0) {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? undefined : ms;
  }
  return undefined;
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}

/**
 * Join the `text` fields of a content block array (`input_text`,
 * `output_text`, `text` items all carry a string `text` key) and count the
 * blocks that carry no text (images, etc.) so they can be flagged in meta.
 */
export function collectText(blocks: unknown): { text: string; nonTextBlocks: number } {
  let text = '';
  let nonTextBlocks = 0;
  if (Array.isArray(blocks)) {
    for (const block of blocks) {
      if (block !== null && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string') {
        const part = (block as { text: string }).text;
        if (part.length > 0) text += text.length > 0 ? `\n${part}` : part;
      } else {
        nonTextBlocks++;
      }
    }
  }
  return { text, nonTextBlocks };
}

/** Copy the listed keys (when present) from a source row into meta. */
export function pickMeta(row: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  for (const key of keys) {
    if (row[key] !== undefined) meta[key] = row[key];
  }
  return meta;
}

export interface EventDraft {
  source: string;
  sessionId: string;
  ordinal: number;
  ts: number;
  role: EventRole;
  kind: EventKind;
  text?: string;
  tool?: EventTool;
  refs?: EventRefs;
  meta?: Record<string, unknown>;
  /** The raw envelope this event was built from — becomes the blob rawRef. */
  rawPayload: unknown;
}

/** Single Event constructor so id/rawRef/text-truncation rules stay uniform. */
export function buildEvent(draft: EventDraft): Event {
  const event: Event = {
    id: makeEventId(draft.source, draft.sessionId, draft.ordinal),
    source: draft.source,
    sessionId: draft.sessionId,
    ordinal: draft.ordinal,
    ts: draft.ts,
    role: draft.role,
    kind: draft.kind,
    meta: draft.meta ?? {},
    rawRef: computeRawRef(draft.rawPayload),
  };
  if (typeof draft.text === 'string' && draft.text.length > 0) event.text = truncateText(draft.text);
  if (draft.tool !== undefined) event.tool = draft.tool;
  if (draft.refs !== undefined) event.refs = draft.refs;
  return event;
}

/** Test/pipeline helper: drain an adapter's read+normalize into Events. */
export async function collectEvents(
  read: () => AsyncIterable<RawEvent>,
  normalize: (raw: RawEvent) => Event | null,
): Promise<Event[]> {
  const events: Event[] = [];
  for await (const raw of read()) {
    const event = normalize(raw);
    if (event !== null) events.push(event);
  }
  return events;
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
