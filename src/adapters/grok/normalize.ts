/**
 * Grok CLI normalization: SQLite rows → unified Event.
 *
 * Source shape (from the grok-cli storage layer, src/storage/migrations.ts and
 * transcript.ts on superagent-ai/grok-cli main@2026-10):
 * - `sessions` carries {id, workspace_id, title, model, mode, cwd_at_start,
 *   cwd_last, status, created_at, updated_at}; timestamps are ISO strings.
 * - `messages` carries {session_id, seq, role, message_json, created_at}
 *   with PRIMARY KEY (session_id, seq); message_json is an AI SDK
 *   ModelMessage: {role:'user'|'assistant'|'system'|'tool', content: string |
 *   Array<{type:'text'|'thinking'|'tool-call'|'tool-result', ...}>}.
 *
 * Ordinal scheme: `seq` is strictly increasing per session and stable (it is
 * half the primary key), so it keys the sequence directly; the fan-out folds
 * into a per-message sub-space:
 *
 *   ordinal = seq * GROK_SUB_SPACE + partOffset
 */

import type { Event, EventRefs, EventTool } from '../../core/event.ts';
import type { RawEvent } from '../../core/privacy.ts';
import { buildEvent, isPlainRecord, parseJsonSafe, toEpochMs, truncate } from '../shared.ts';

export const GROK_SOURCE = 'grok';
/** Ordinal headroom for the fan-out under one message row. */
export const GROK_SUB_SPACE = 100;
const ARGS_SUMMARY_MAX = 400;

export type GrokPartKind = 'message' | 'reasoning' | 'tool_call' | 'tool_result';

export interface GrokPart {
  kind: GrokPartKind;
  index: number;
  /** 0-based fan-out position among the row's parts; keys the ordinal. */
  offset: number;
}

export interface GrokSessionRow {
  id: string;
  title: string | null;
  model: string | null;
  mode: string | null;
  cwd_at_start: string | null;
  cwd_last: string | null;
  status: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface GrokMessageRow {
  session_id: string;
  seq: number;
  role: string;
  message_json: string;
  created_at: string | null;
}

/** RawEvent.payload envelope for Grok; `part` is one mappable unit. */
export interface GrokPayload {
  session: GrokSessionRow;
  message: GrokMessageRow;
  /** Parsed message_json; read() parses it once per row. */
  messageData: Record<string, unknown>;
  part: GrokPart;
}

export function isGrokPayload(payload: unknown): payload is GrokPayload {
  if (!isPlainRecord(payload) || !isPlainRecord(payload.session) || !isPlainRecord(payload.message)) return false;
  if (!isPlainRecord(payload.messageData) || !isPlainRecord(payload.part)) return false;
  return typeof payload.part.kind === 'string';
}

export function isGrokSessionRow(value: unknown): value is GrokSessionRow {
  return isPlainRecord(value) && typeof value.id === 'string';
}

export function isGrokMessageRow(value: unknown): value is GrokMessageRow {
  if (!isPlainRecord(value)) return false;
  return typeof value.session_id === 'string' && typeof value.seq === 'number' && typeof value.role === 'string' && typeof value.message_json === 'string';
}

/**
 * The mappable parts of a ModelMessage row. user/system rows map whole;
 * assistant rows fan out into thinking / tool-call parts (text rides the
 * message part); tool rows fan out into tool-result parts.
 */
export function grokParts(role: string, messageData: Record<string, unknown>): GrokPart[] {
  const parts: GrokPart[] = [{ kind: 'message', index: 0, offset: 0 }];
  if (!Array.isArray(messageData.content)) return parts;
  for (const block of messageData.content) {
    if (parts.length >= GROK_SUB_SPACE) break;
    if (!isPlainRecord(block)) continue;
    if (role === 'assistant') {
      if (block.type === 'thinking') parts.push({ kind: 'reasoning', index: parts.filter((p) => p.kind === 'reasoning').length, offset: parts.length });
      if (block.type === 'tool-call') parts.push({ kind: 'tool_call', index: parts.filter((p) => p.kind === 'tool_call').length, offset: parts.length });
    }
    if (role === 'tool' && block.type === 'tool-result') {
      parts.push({ kind: 'tool_result', index: parts.filter((p) => p.kind === 'tool_result').length, offset: parts.length });
    }
  }
  return parts;
}

export function normalizeGrok(raw: RawEvent): Event | null {
  if (!isGrokPayload(raw.payload)) return null;
  const { session, message, messageData, part } = raw.payload;
  if (message.session_id !== session.id) return null;
  const ts = toEpochMs(message.created_at ?? session.updated_at ?? session.created_at);
  if (ts === undefined) return null;
  if (message.seq < 0 || !Number.isInteger(message.seq)) return null;

  const ordinal = message.seq * GROK_SUB_SPACE + part.offset;
  const refs = buildRefs(session);
  const meta: Record<string, unknown> = {
    seq: message.seq,
    dbRole: message.role,
    model: session.model ?? undefined,
    mode: session.mode ?? undefined,
    status: session.status ?? undefined,
    title: session.title ?? undefined,
  };
  const draft = { source: GROK_SOURCE, sessionId: session.id, ordinal, ts, refs, meta, rawPayload: raw.payload };

  const role = messageData.role;
  if (part.kind === 'message') {
    if (role === 'user') return buildEvent({ ...draft, role: 'user', kind: 'message', text: contentText(messageData) });
    if (role === 'assistant') {
      const text = contentText(messageData);
      if (text.length === 0) return null; // content lives in the sub-parts
      return buildEvent({ ...draft, role: 'assistant', kind: 'message', text });
    }
    // system prompts and any other roles are infrastructure.
    return null;
  }

  if (!Array.isArray(messageData.content)) return null;
  const blocks = messageData.content.filter(isPlainRecord);
  if (part.kind === 'reasoning') {
    const kinded = blocks.filter((b) => b.type === 'thinking');
    const block = kinded[part.index];
    if (block === undefined) return null;
    return buildEvent({ ...draft, role: 'assistant', kind: 'reasoning', text: typeof block.thinking === 'string' ? block.thinking : '' });
  }
  if (part.kind === 'tool_call') {
    const kinded = blocks.filter((b) => b.type === 'tool-call');
    const block = kinded[part.index];
    if (block === undefined) return null;
    const name = typeof block.toolName === 'string' && block.toolName.length > 0 ? block.toolName : 'unknown';
    const tool: EventTool = { name, argsSummary: truncate(JSON.stringify(block.input ?? {}) ?? '', ARGS_SUMMARY_MAX) };
    const callMeta = { ...meta };
    if (typeof block.toolCallId === 'string') callMeta.toolCallId = block.toolCallId;
    return buildEvent({ ...draft, role: 'assistant', kind: 'tool_call', tool, meta: callMeta });
  }
  // part.kind === 'tool_result'
  const kinded = blocks.filter((b) => b.type === 'tool-result');
  const block = kinded[part.index];
  if (block === undefined) return null;
  const tool: EventTool = { name: typeof block.toolName === 'string' && block.toolName.length > 0 ? block.toolName : 'unknown' };
  const resultMeta = { ...meta };
  if (typeof block.toolCallId === 'string') resultMeta.toolCallId = block.toolCallId;
  return buildEvent({ ...draft, role: 'tool', kind: 'tool_result', text: resultText(block.output), tool, meta: resultMeta });
}

function buildRefs(session: GrokSessionRow): EventRefs | undefined {
  const refs: EventRefs = {};
  if (typeof session.cwd_last === 'string' && session.cwd_last.length > 0) refs.cwd = session.cwd_last;
  if (typeof session.model === 'string' && session.model.length > 0) refs.model = session.model;
  return Object.keys(refs).length > 0 ? refs : undefined;
}

/** content is a string or an array of blocks; text blocks join with newlines. */
function contentText(messageData: Record<string, unknown>): string {
  if (typeof messageData.content === 'string') return messageData.content;
  let text = '';
  if (!Array.isArray(messageData.content)) return text;
  for (const block of messageData.content) {
    if (!isPlainRecord(block) || block.type !== 'text' || typeof block.text !== 'string') continue;
    if (block.text.length > 0) text += text.length > 0 ? `\n${block.text}` : block.text;
  }
  return text;
}

/** AI SDK tool-result output shapes: string, {value}, or a raw blob. */
function resultText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (isPlainRecord(output) && typeof output.value === 'string') return output.value;
  return output === undefined ? '' : truncate(JSON.stringify(output) ?? '', 2000);
}
