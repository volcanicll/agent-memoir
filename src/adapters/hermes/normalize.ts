/**
 * Hermes normalization: SQLite rows → unified Event.
 *
 * Source shape (measured against ~/.hermes/state.db):
 * - messages.role ∈ {user, assistant, tool, session_meta}
 * - messages.tool_calls is a JSON string of
 *   [{id, call_id, response_item_id, type, function:{name, arguments}}]
 *   where `arguments` is ITSELF a JSON string (double-encoded).
 * - One assistant row can carry text AND several tool calls. The Adapter
 *   contract is 1 raw → 1 event, so read() fans the row out into one
 *   RawEvent per mappable part (payload.part below) and this module maps
 *   each part. Ordinal = messageId * 100 + subIndex keeps Events unique
 *   and monotonic within a session (message ids are AUTOINCREMENT and
 *   strictly increasing per session).
 */

import type { Event } from '../../core/event.ts';
import type { RawEvent } from '../../core/privacy.ts';
import { buildEvent, isPlainRecord, parseJsonSafe, toEpochMs, truncate } from '../shared.ts';

export interface HermesSessionRow {
  id: string | null;
  source: string | null;
  model: string | null;
  started_at: number | null;
  ended_at: number | null;
  title: string | null;
  cwd: string | null;
  profile_name: string | null;
}

export interface HermesMessageRow {
  id: number | null;
  session_id: string | null;
  role: string | null;
  content: string | null;
  tool_call_id: string | null;
  tool_calls: string | null;
  tool_name: string | null;
  timestamp: number | null;
  token_count: number | null;
  finish_reason: string | null;
  reasoning: string | null;
}

/**
 * RawEvent.payload envelope for Hermes. `part` selects which mappable unit
 * of the message row this RawEvent represents: the row's own text/meta
 * ('message') or one entry of its tool_calls array ('tool_call').
 */
export interface HermesPayload {
  session: HermesSessionRow;
  message: HermesMessageRow;
  part: { kind: 'message' | 'tool_call'; index: number };
}

export const HERMES_SOURCE = 'hermes';
/** Ordinal headroom for the tool-call fan-out under one message row. */
export const HERMES_SUB_SPACE = 100;
const ARGS_SUMMARY_MAX = 400;

export function isHermesPayload(payload: unknown): payload is HermesPayload {
  if (!isPlainRecord(payload) || !isPlainRecord(payload.session) || !isPlainRecord(payload.message)) return false;
  if (!isPlainRecord(payload.part)) return false;
  return typeof payload.message.role === 'string' && typeof payload.part.kind === 'string';
}

function baseMeta(session: HermesSessionRow, message: HermesMessageRow): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  if (session.source !== null) meta.source = session.source;
  if (session.profile_name !== null) meta.profileName = session.profile_name;
  if (message.token_count !== null) meta.tokenCount = message.token_count;
  if (message.finish_reason !== null) meta.finishReason = message.finish_reason;
  if (message.reasoning !== null && message.reasoning.length > 0) meta.hasReasoning = true;
  return meta;
}

function sessionRefs(session: HermesSessionRow): { cwd?: string; model?: string } | undefined {
  const refs: { cwd?: string; model?: string } = {};
  if (session.cwd !== null) refs.cwd = session.cwd;
  if (session.model !== null) refs.model = session.model;
  return Object.keys(refs).length > 0 ? refs : undefined;
}

export interface ParsedToolCall {
  callId?: string;
  name: string;
  argsSummary: string;
}

/** tool_calls column → per-call summaries; arguments is double-encoded JSON. */
export function parseToolCalls(column: string | null): ParsedToolCall[] {
  const parsed = parseJsonSafe(column);
  if (!Array.isArray(parsed)) return [];
  const calls: ParsedToolCall[] = [];
  for (const entry of parsed) {
    if (!isPlainRecord(entry) || !isPlainRecord(entry.function) || typeof entry.function.name !== 'string') {
      continue;
    }
    const rawArgs = entry.function.arguments;
    const parsedArgs = parseJsonSafe(rawArgs);
    const argsSummary =
      parsedArgs === undefined
        ? truncate(typeof rawArgs === 'string' ? rawArgs : '', ARGS_SUMMARY_MAX)
        : truncate(JSON.stringify(parsedArgs) ?? '', ARGS_SUMMARY_MAX);
    const callId =
      typeof entry.id === 'string' ? entry.id : typeof entry.call_id === 'string' ? entry.call_id : undefined;
    calls.push({ callId, name: entry.function.name, argsSummary });
  }
  return calls;
}

/** tool result rows may carry a JSON body with a success flag. */
function resultOk(content: string | null): boolean | undefined {
  const parsed = parseJsonSafe(content);
  if (isPlainRecord(parsed) && typeof parsed.success === 'boolean') return parsed.success;
  return undefined;
}

export function normalizeHermes(raw: RawEvent): Event | null {
  if (!isHermesPayload(raw.payload)) return null;
  const { session, message, part } = raw.payload;

  const sessionId = message.session_id ?? session.id;
  if (sessionId === null || sessionId.length === 0) return null;
  const messageId = message.id;
  if (messageId === null || messageId < 0) return null;
  const ts = toEpochMs(message.timestamp) ?? toEpochMs(session.started_at);
  if (ts === undefined) return null;

  const refs = sessionRefs(session);
  const meta = baseMeta(session, message);
  const draft = { source: HERMES_SOURCE, sessionId, ts, refs, rawPayload: raw.payload };

  if (part.kind === 'tool_call') {
    const call = parseToolCalls(message.tool_calls)[part.index];
    if (call === undefined) return null;
    return buildEvent({
      ...draft,
      ordinal: messageId * HERMES_SUB_SPACE + 1 + part.index,
      role: 'assistant',
      kind: 'tool_call',
      tool: { name: call.name, argsSummary: call.argsSummary },
      meta: call.callId !== undefined ? { ...meta, toolCallId: call.callId } : meta,
    });
  }

  switch (message.role) {
    case 'user':
      return buildEvent({ ...draft, ordinal: messageId * HERMES_SUB_SPACE, role: 'user', kind: 'message', text: message.content ?? undefined, meta });

    case 'assistant':
      return buildEvent({ ...draft, ordinal: messageId * HERMES_SUB_SPACE, role: 'assistant', kind: 'message', text: message.content ?? undefined, meta });

    case 'tool': {
      const tool =
        message.tool_name !== null && message.tool_name.length > 0
          ? { name: message.tool_name, ok: resultOk(message.content) }
          : { name: message.tool_call_id ?? 'unknown', ok: resultOk(message.content) };
      return buildEvent({
        ...draft,
        ordinal: messageId * HERMES_SUB_SPACE,
        role: 'tool',
        kind: 'tool_result',
        text: message.content ?? undefined,
        tool,
        meta: message.tool_call_id !== null ? { ...meta, toolCallId: message.tool_call_id } : meta,
      });
    }

    case 'session_meta': {
      const startMeta: Record<string, unknown> = { ...meta };
      if (session.title !== null) startMeta.title = session.title;
      if (session.started_at !== null) startMeta.startedAt = toEpochMs(session.started_at);
      if (session.ended_at !== null) startMeta.endedAt = toEpochMs(session.ended_at);
      return buildEvent({ ...draft, ordinal: messageId * HERMES_SUB_SPACE, role: 'system', kind: 'session_start', meta: startMeta });
    }

    default:
      return null;
  }
}
