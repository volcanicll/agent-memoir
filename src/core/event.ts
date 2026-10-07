/**
 * Unified Event schema — the single normal form every adapter must produce.
 *
 * Design rules:
 * - `meta` is the escape hatch: source-specific fields land here verbatim,
 *   never dropped, never flattened into the common shape.
 * - `rawRef` points into the local blob store (sha256 of the full original
 *   record) so truncation of `text` never loses information.
 * - `id` is deterministic: the same source record always yields the same id,
 *   which is what incremental dedup relies on.
 * - `ordinal` is monotonically increasing within a session; sort by it, never
 *   by `ts` (same-millisecond collisions are common).
 */

export type EventSource = 'hermes' | 'claude-code' | 'codex' | 'opencode' | 'pi' | 'gemini' | 'grok' | (string & {});

export type EventRole = 'user' | 'assistant' | 'tool' | 'system';

export type EventKind =
  | 'message'
  | 'tool_call'
  | 'tool_result'
  | 'reasoning'
  | 'session_start'
  | 'session_end';

export interface EventTool {
  name: string;
  argsSummary?: string;
  ok?: boolean;
}

export interface EventRefs {
  files?: string[];
  urls?: string[];
  cwd?: string;
  model?: string;
}

export interface Event {
  /** Stable dedup key: `${source}:${sessionId}:${ordinal}` */
  id: string;
  source: EventSource;
  sessionId: string;
  /** Session-scoped monotonic counter, 0-based. Sort key — not `ts`. */
  ordinal: number;
  /** Epoch milliseconds (UTC). */
  ts: number;
  role: EventRole;
  kind: EventKind;
  /** Truncated to 4000 chars; full original lives in the blob store. */
  text?: string;
  /** sha256(full original record) → blob store. */
  rawRef?: string;
  tool?: EventTool;
  refs?: EventRefs;
  /** Escape hatch for source-specific fields — nothing may be dropped. */
  meta: Record<string, unknown>;
}

/** Hard cap for `text`; everything beyond it stays reachable via `rawRef`. */
export const TEXT_MAX_LENGTH = 4000;

export function truncateText(text: string): string {
  return text.length <= TEXT_MAX_LENGTH ? text : text.slice(0, TEXT_MAX_LENGTH);
}

export function makeEventId(source: string, sessionId: string, ordinal: number): string {
  return `${source}:${sessionId}:${ordinal}`;
}

const ROLES: readonly EventRole[] = ['user', 'assistant', 'tool', 'system'];
const KINDS: readonly EventKind[] = [
  'message',
  'tool_call',
  'tool_result',
  'reasoning',
  'session_start',
  'session_end',
];

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationIssue[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Handwritten structural validator for Event. Zero dependencies on purpose —
 * the schema is small and stable, and it must stay importable from anywhere
 * (including the store and verify layers) without pulling a validation lib.
 */
export function validateEvent(value: unknown): ValidationResult {
  const errors: ValidationIssue[] = [];
  const fail = (path: string, message: string) => errors.push({ path, message });

  if (!isPlainObject(value)) {
    return { ok: false, errors: [{ path: '$', message: 'expected an object' }] };
  }
  const e = value as Record<string, unknown>;

  if (typeof e.id !== 'string' || e.id.length === 0) {
    fail('id', 'must be a non-empty string');
  } else {
    const expected = makeEventId(
      typeof e.source === 'string' ? e.source : '<unknown>',
      typeof e.sessionId === 'string' ? e.sessionId : '<unknown>',
      typeof e.ordinal === 'number' ? e.ordinal : -1,
    );
    if (e.id !== expected) fail('id', `must be "${expected}" (source:sessionId:ordinal)`);
  }

  if (typeof e.source !== 'string' || e.source.length === 0) fail('source', 'must be a non-empty string');

  if (typeof e.sessionId !== 'string' || e.sessionId.length === 0) {
    fail('sessionId', 'must be a non-empty string');
  }

  if (typeof e.ordinal !== 'number' || !Number.isInteger(e.ordinal) || e.ordinal < 0) {
    fail('ordinal', 'must be a non-negative integer');
  }

  if (typeof e.ts !== 'number' || !Number.isFinite(e.ts) || e.ts <= 0) {
    fail('ts', 'must be a finite positive epoch-ms number');
  }

  if (!ROLES.includes(e.role as EventRole)) {
    fail('role', `must be one of ${ROLES.join('|')}`);
  }
  if (!KINDS.includes(e.kind as EventKind)) {
    fail('kind', `must be one of ${KINDS.join('|')}`);
  }

  if (e.text !== undefined && typeof e.text !== 'string') {
    fail('text', 'must be a string when present');
  } else if (typeof e.text === 'string' && e.text.length > TEXT_MAX_LENGTH) {
    fail('text', `must be truncated to ${TEXT_MAX_LENGTH} chars (got ${e.text.length})`);
  }

  if (e.rawRef !== undefined && (typeof e.rawRef !== 'string' || !/^[0-9a-f]{64}$/.test(e.rawRef))) {
    fail('rawRef', 'must be a lowercase sha256 hex string');
  }

  if (e.tool !== undefined) {
    if (!isPlainObject(e.tool)) {
      fail('tool', 'must be an object when present');
    } else {
      if (typeof e.tool.name !== 'string' || e.tool.name.length === 0) fail('tool.name', 'must be a non-empty string');
      if (e.tool.argsSummary !== undefined && typeof e.tool.argsSummary !== 'string') {
        fail('tool.argsSummary', 'must be a string when present');
      }
      if (e.tool.ok !== undefined && typeof e.tool.ok !== 'boolean') fail('tool.ok', 'must be a boolean when present');
    }
  }

  if (e.refs !== undefined) {
    if (!isPlainObject(e.refs)) {
      fail('refs', 'must be an object when present');
    } else {
      for (const key of ['files', 'urls'] as const) {
        const v = e.refs[key];
        if (v !== undefined && (!Array.isArray(v) || v.some((x) => typeof x !== 'string'))) {
          fail(`refs.${key}`, 'must be an array of strings when present');
        }
      }
      for (const key of ['cwd', 'model'] as const) {
        const v = e.refs[key];
        if (v !== undefined && typeof v !== 'string') fail(`refs.${key}`, 'must be a string when present');
      }
    }
  }

  if (!isPlainObject(e.meta)) fail('meta', 'must be an object');

  return { ok: errors.length === 0, errors };
}
