/**
 * pi normalization: session JSONL rows → unified Event.
 *
 * Source shape (measured against ~/.pi/agent/sessions, version 3):
 * - One JSONL per session, named `<ISO timestamp>_<uuid>.jsonl` under a
 *   per-project slug directory. Rows carry `type` ∈ session |
 *   thinking_level_change | model_change | message; only `session` and
 *   `message` rows map to Events. Every message row is one fan-out source:
 *   `message.content` is an array of text / thinking / toolCall blocks
 *   (user content may be a plain string in older sessions), and toolResult
 *   rows are their own `type`, so the fan-out yields at most one message /
 *   thinking part plus one part per toolCall per row.
 * - `session` rows are always the first line; their `cwd` seeds refs.cwd and
 *   later `model_change` rows refine refs.model the same way pi applies them
 *   in stream order.
 *
 * Ordinal scheme: files are append-only and the line index is stable across
 * re-reads, so the 1-based line index keys the sequence; the sorted file list
 * makes a file's rank stable too. Files re-using the parent session id fold
 * into a per-file rank, like the Claude Code adapter:
 *
 *   ordinal = fileRank * PI_FILE_SPACE + line * PI_SUB_SPACE + partOffset
 */

import type { Event, EventRefs, EventRole, EventTool } from '../../core/event.ts';
import type { RawEvent } from '../../core/privacy.ts';
import { buildEvent, isPlainRecord, pickMeta, toEpochMs, truncate } from '../shared.ts';

export const PI_SOURCE = 'pi';
/** Ordinal headroom for the fan-out under one row. */
export const PI_SUB_SPACE = 100;
/** Ordinal headroom for one file's worth of rows. */
export const PI_FILE_SPACE = 100_000_000;
const ARGS_SUMMARY_MAX = 400;

export type PiPartKind = 'message' | 'thinking' | 'tool_call' | 'tool_result' | 'meta';

export interface PiPart {
  kind: PiPartKind;
  index: number;
}

/** RawEvent.payload envelope for pi; `part` is one mappable unit. */
export interface PiPayload {
  /** From the file's `session` row id (falls back to the filename uuid). */
  sessionId: string;
  file: string;
  /** 1-based line index inside `file`; files are append-only, so it is stable. */
  line: number;
  /** 0-based rank of `file` in the adapter's sorted file list. */
  fileRank: number;
  /** The parsed JSONL row, verbatim. */
  row: unknown;
  /** Session-level state inherited by every row (cwd, current model). */
  context: { cwd?: string; model?: string };
  part: PiPart;
  /** 0-based fan-out position among this row's mappable parts; keys the ordinal. */
  offset: number;
}

export function isPiPayload(payload: unknown): payload is PiPayload {
  if (!isPlainRecord(payload) || !isPlainRecord(payload.row) || !isPlainRecord(payload.part)) return false;
  if (!isPlainRecord(payload.context)) return false;
  if (typeof payload.part.kind !== 'string' || typeof payload.sessionId !== 'string') return false;
  return typeof payload.line === 'number' && typeof payload.fileRank === 'number' && typeof payload.offset === 'number';
}

const MESSAGE_META_KEYS = ['api', 'provider', 'model', 'stopReason', 'errorMessage', 'usage'] as const;

/**
 * The mappable parts of a row, in fan-out order. Non-message rows yield a
 * single 'meta' part so read() drops nothing; normalize() returns null for
 * them. toolResult rows map whole (their toolName rides along), assistant
 * rows fan out into one thinking / toolCall part per block.
 */
export function piParts(row: Record<string, unknown>): PiPart[] {
  if (row.type !== 'message') return [{ kind: 'meta', index: 0 }];
  const message = isPlainRecord(row.message) ? row.message : undefined;
  const role = message?.role;
  const parts: PiPart[] = [{ kind: 'meta', index: 0 }];
  if (role === 'toolResult') {
    parts.push({ kind: 'tool_result', index: 0 });
    return parts;
  }
  if (role !== 'user' && role !== 'assistant') return parts;
  parts.push({ kind: 'message', index: 0 });
  if (role !== 'assistant') return parts;
  const blocks = Array.isArray(message?.content) ? message.content.filter(isPlainRecord) : [];
  for (const block of blocks) {
    if (parts.length >= PI_SUB_SPACE) break;
    if (block.type === 'thinking') {
      parts.push({ kind: 'thinking', index: parts.filter((p) => p.kind === 'thinking').length });
    }
    if (block.type === 'toolCall') {
      parts.push({ kind: 'tool_call', index: parts.filter((p) => p.kind === 'tool_call').length });
    }
  }
  return parts;
}

export function normalizePi(raw: RawEvent): Event | null {
  if (!isPiPayload(raw.payload)) return null;
  const { sessionId, file, line, fileRank, part, context, offset } = raw.payload;
  const row = raw.payload.row;
  if (!isPlainRecord(row) || sessionId.length === 0) return null;
  const ts = toEpochMs(row.timestamp);
  if (ts === undefined) return null;

  const ordinal = fileRank * PI_FILE_SPACE + line * PI_SUB_SPACE + offset;
  const refs = buildRefs(context);

  if (row.type === 'session') {
    const meta = pickMeta(row, ['version']);
    meta.file = file;
    return buildEvent({
      source: PI_SOURCE,
      sessionId,
      ordinal,
      ts,
      role: 'system',
      kind: 'session_start',
      refs,
      meta,
      rawPayload: raw.payload,
    });
  }

  if (row.type !== 'message') return null;
  const message = isPlainRecord(row.message) ? row.message : undefined;
  if (message === undefined) return null;
  const meta = baseMeta(message, file);

  if (message.role === 'toolResult') {
    if (part.kind !== 'tool_result') return null;
    const ok = typeof message.isError === 'boolean' ? !message.isError : undefined;
    const tool: EventTool = { name: toolNameOf(message), ok };
    const resultMeta = { ...meta };
    if (typeof message.toolCallId === 'string') resultMeta.toolCallId = message.toolCallId;
    if (typeof message.isError === 'boolean') resultMeta.isError = message.isError;
    return buildEvent({
      source: PI_SOURCE,
      sessionId,
      ordinal,
      ts,
      role: 'tool',
      kind: 'tool_result',
      text: collectParts(message.content),
      tool,
      refs,
      meta: resultMeta,
      rawPayload: raw.payload,
    });
  }

  if (message.role !== 'user' && message.role !== 'assistant') return null;
  if (part.kind === 'thinking') {
    const block = blocksOf(message, 'thinking')[part.index];
    if (block === undefined || typeof block.thinking !== 'string') return null;
    return buildEvent({ source: PI_SOURCE, sessionId, ordinal, ts, role: 'assistant', kind: 'reasoning', text: block.thinking, refs, meta, rawPayload: raw.payload });
  }
  if (part.kind === 'tool_call') {
    const block = blocksOf(message, 'toolCall')[part.index];
    if (block === undefined) return null;
    const name = typeof block.name === 'string' && block.name.length > 0 ? block.name : 'unknown';
    const tool: EventTool = { name, argsSummary: truncate(JSON.stringify(block.arguments) ?? '', ARGS_SUMMARY_MAX) };
    const callMeta = { ...meta };
    if (typeof block.id === 'string') callMeta.toolCallId = block.id;
    return buildEvent({ source: PI_SOURCE, sessionId, ordinal, ts, role: 'assistant', kind: 'tool_call', tool, refs, meta: callMeta, rawPayload: raw.payload });
  }
  if (part.kind !== 'message') return null;
  const role: EventRole = message.role === 'assistant' ? 'assistant' : 'user';
  return buildEvent({ source: PI_SOURCE, sessionId, ordinal, ts, role, kind: 'message', text: messageText(message), refs, meta, rawPayload: raw.payload });
}

function baseMeta(message: Record<string, unknown>, file: string): Record<string, unknown> {
  const meta = pickMeta(message, MESSAGE_META_KEYS);
  meta.file = file;
  return meta;
}

function buildRefs(context: { cwd?: string; model?: string }): EventRefs | undefined {
  const refs: EventRefs = {};
  if (context.cwd !== undefined) refs.cwd = context.cwd;
  if (context.model !== undefined) refs.model = context.model;
  return Object.keys(refs).length > 0 ? refs : undefined;
}

function blocksOf(message: Record<string, unknown>, type: string): Array<Record<string, unknown>> {
  if (!Array.isArray(message.content)) return [];
  return message.content.filter((block): block is Record<string, unknown> => isPlainRecord(block) && block.type === type);
}

/** User content may be a plain string (older sessions) or a block array. */
function messageText(message: Record<string, unknown>): string {
  if (typeof message.content === 'string') return message.content;
  return collectParts(message.content);
}

function collectParts(content: unknown): string {
  let text = '';
  if (!Array.isArray(content)) return text;
  for (const part of content) {
    if (!isPlainRecord(part) || part.type !== 'text' || typeof part.text !== 'string') continue;
    if (part.text.length > 0) text += text.length > 0 ? `\n${part.text}` : part.text;
  }
  return text;
}

function toolNameOf(message: Record<string, unknown>): string {
  if (typeof message.toolName === 'string' && message.toolName.length > 0) return message.toolName;
  return 'unknown';
}
