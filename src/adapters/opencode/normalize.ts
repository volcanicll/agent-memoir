/**
 * OpenCode normalization: SQLite rows → unified Event.
 *
 * Source shape (measured against ~/.local/share/opencode/opencode.db):
 * - `message.data` is a JSON blob: user rows carry {role:'user', agent,
 *   model:{providerID,modelID}}; assistant rows carry {role:'assistant',
 *   parentID, mode, agent, path:{cwd,root}, cost, tokens, modelID,
 *   providerID, time:{created,completed}, finish}.
 * - `part.data` is a JSON blob keyed by its parent message:
 *   {type:'text'|'reasoning'|'tool'|'step-start'|'step-finish'|'patch'|'file'|'compaction'}.
 *   text parts may carry {synthetic:true, metadata:{kind:'editor_context'}}
 *   for editor-injected reminders; tool parts carry {tool, callID,
 *   state:{status, input, output, metadata, title}}.
 *
 * Ordinal scheme: messages carry no per-message ordinal in the schema, so the
 * (time_created, id) pair within a session keys the sequence — read() numbers
 * them 0-based in query order. Parts fold into a per-message sub-space. A
 * session's rows are append-only in practice; a re-read of the same bytes is
 * idempotent.
 */

import type { Event, EventRefs, EventRole, EventTool } from '../../core/event.ts';
import type { RawEvent } from '../../core/privacy.ts';
import { buildEvent, isPlainRecord, parseJsonSafe, truncate } from '../shared.ts';

export const OPENCODE_SOURCE = 'opencode';
/** Ordinal headroom for the parts under one message. */
export const OPENCODE_PART_SPACE = 100_000;
const ARGS_SUMMARY_MAX = 400;

export type OpencodePartKind = 'message' | 'reasoning' | 'tool_call' | 'tool_result' | 'meta';

export interface OpencodePart {
  kind: OpencodePartKind;
  index: number;
}

export interface OpencodeSessionRow {
  id: string;
  directory: string;
  title: string;
  /** Epoch-ms integers per the schema. */
  time_created: number;
  time_updated: number;
  parent_id: string | null;
}

export interface OpencodeMessageRow {
  id: string;
  session_id: string;
  time_created: number;
  data: string;
}

export interface OpencodePartRow {
  id: string;
  message_id: string;
  session_id: string;
  data: string;
}

/** RawEvent.payload envelope for OpenCode: one part (or whole message). */
export interface OpencodePayload {
  session: OpencodeSessionRow;
  message: OpencodeMessageRow;
  /** 0-based rank of the message inside its session, in read order. */
  messageRank: number;
  /** Undefined for a message-level part (the message's own user/system role). */
  partRow?: OpencodePartRow;
  part: OpencodePart;
  /** 0-based fan-out position among this message's mappable parts; keys the ordinal. */
  offset: number;
  /** Parsed message.data; read() parses it once per message. */
  messageData: Record<string, unknown>;
}

export function isOpencodePayload(payload: unknown): payload is OpencodePayload {
  if (!isPlainRecord(payload) || !isPlainRecord(payload.session) || !isPlainRecord(payload.message)) return false;
  if (!isPlainRecord(payload.part) || typeof payload.messageRank !== 'number' || typeof payload.offset !== 'number') return false;
  return isPlainRecord(payload.messageData);
}

export function isOpencodeSessionRow(value: unknown): value is OpencodeSessionRow {
  if (!isPlainRecord(value)) return false;
  return typeof value.id === 'string' && typeof value.directory === 'string' && typeof value.time_created === 'number';
}

export function isOpencodeMessageRow(value: unknown): value is OpencodeMessageRow {
  if (!isPlainRecord(value)) return false;
  return typeof value.id === 'string' && typeof value.session_id === 'string' && typeof value.time_created === 'number' && typeof value.data === 'string';
}

export function isOpencodePartRow(value: unknown): value is OpencodePartRow {
  if (!isPlainRecord(value)) return false;
  return typeof value.id === 'string' && typeof value.message_id === 'string' && typeof value.data === 'string';
}

/**
 * The mappable kinds of a part.data blob. text parts map to the message part
 * (user prompts and assistant text alike); reasoning and tool parts map
 * directly (a tool row fans out further — see opencodePartsFor());
 * step-start/step-finish/patch/file/compaction are telemetry.
 */
export function opencodePartKind(role: string, blob: Record<string, unknown>): OpencodePartKind {
  const type = blob.type;
  if (type === 'reasoning') return 'reasoning';
  // A tool part row holds the call AND its outcome in `state`, so one row
  // fans out into the call first, then the result (see opencodePartsFor()).
  if (type === 'tool') return 'tool_call';
  if (type === 'text') return 'message';
  return 'meta';
}

/**
 * The mappable parts of one part row: a tool part expands into tool_call +
 * tool_result; text and reasoning map one-to-one. Every returned entry
 * carries the kind and the index among same-kind entries for this row.
 */
export function opencodePartsFor(role: string, blob: Record<string, unknown>): OpencodePart[] {
  const kind = opencodePartKind(role, blob);
  if (kind !== 'tool_call') return kind === 'meta' ? [] : [{ kind, index: 0 }];
  const state = isPlainRecord(blob.state) ? blob.state : undefined;
  const parts: OpencodePart[] = [{ kind: 'tool_call', index: 0 }];
  // Pending calls have no output yet; the result event appears on later re-reads.
  if (state !== undefined && typeof state.output === 'string' && state.output.length > 0) {
    parts.push({ kind: 'tool_result', index: 0 });
  }
  return parts;
}

export function normalizeOpencode(raw: RawEvent): Event | null {
  if (!isOpencodePayload(raw.payload)) return null;
  const { session, message, messageRank, partRow, part, offset, messageData } = raw.payload;
  const ts = toTs(message.time_created);
  if (ts === undefined) return null;

  const refs = buildRefs(session, messageData);
  const base = { source: OPENCODE_SOURCE, sessionId: session.id, ts, refs, rawPayload: raw.payload };
  const ordinal = messageRank * OPENCODE_PART_SPACE + offset;

  const role = roleOf(messageData);

  const row = partRow === undefined ? undefined : parseJsonSafe(partRow.data);
  if (!isPlainRecord(row)) {
    // Message-level event: a user row with no mappable text parts at all.
    if (role !== 'user') return null;
    const meta: Record<string, unknown> = { messageId: message.id, agent: messageData.agent, title: session.title, parentId: session.parent_id ?? undefined };
    return buildEvent({ ...base, ordinal, role: 'user', kind: 'message', text: userTextOf(messageData), meta });
  }
  // Re-derive the exact fan-out for this row and pick the entry at `offset`
  // so normalize() and read() can never disagree about part kinds.
  const fanout = opencodePartsFor(role, row);
  const chosen = fanout[offset];
  if (chosen === undefined || chosen.kind !== part.kind || chosen.index !== part.index) return null;
  const kind = chosen.kind;

  if (kind === 'reasoning') {
    const meta: Record<string, unknown> = { messageId: message.id, partId: partRow?.id };
    return buildEvent({ ...base, ordinal, role: 'assistant', kind: 'reasoning', text: textOf(row.text), meta });
  }
  if (kind === 'tool_call') {
    const state = isPlainRecord(row.state) ? row.state : undefined;
    const tool: EventTool = {
      name: typeof row.tool === 'string' && row.tool.length > 0 ? row.tool : 'unknown',
      argsSummary: truncate(JSON.stringify(state?.input ?? {}) ?? '', ARGS_SUMMARY_MAX),
    };
    const callMeta: Record<string, unknown> = { messageId: message.id, partId: partRow?.id, status: state?.status };
    if (typeof row.callID === 'string') callMeta.callId = row.callID;
    return buildEvent({ ...base, ordinal, role: 'assistant', kind: 'tool_call', tool, meta: callMeta });
  }
  if (kind === 'tool_result') {
    const state = isPlainRecord(row.state) ? row.state : undefined;
    const tool: EventTool = {
      name: typeof row.tool === 'string' && row.tool.length > 0 ? row.tool : 'unknown',
    };
    const meta: Record<string, unknown> = { messageId: message.id, partId: partRow?.id, status: state?.status };
    if (typeof row.callID === 'string') meta.callId = row.callID;
    const ok = okOf(state);
    if (ok !== undefined) {
      tool.ok = ok;
      meta.isError = !ok;
    }
    if (typeof state?.input !== 'undefined') meta.toolInput = truncate(JSON.stringify(state.input) ?? '', ARGS_SUMMARY_MAX);
    return buildEvent({ ...base, ordinal, role: 'tool', kind: 'tool_result', text: textOf(state?.output), tool, meta });
  }
  // kind === 'message': text parts. User prompts live here too — the
  // message.data blob for a user row carries no text of its own. Synthetic
  // reminders (editor context injected as user-visible text) are still
  // recorded verbatim and flagged.
  const meta: Record<string, unknown> = { messageId: message.id, partId: partRow?.id, agent: messageData.agent };
  const blobMeta = isPlainRecord(row.metadata) ? row.metadata : undefined;
  if (typeof blobMeta?.kind === 'string') meta.syntheticKind = blobMeta.kind;
  if (row.synthetic === true) meta.synthetic = true;
  const eventRole: EventRole = role === 'user' ? 'user' : 'assistant';
  return buildEvent({ ...base, ordinal, role: eventRole, kind: 'message', text: textOf(row.text), meta });
}

function roleOf(messageData: Record<string, unknown>): string {
  return typeof messageData.role === 'string' ? messageData.role : '';
}

function toTs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.round(value);
  return undefined;
}

function buildRefs(session: OpencodeSessionRow, messageData: Record<string, unknown>): EventRefs | undefined {
  const refs: EventRefs = {};
  refs.cwd = session.directory;
  const path = isPlainRecord(messageData.path) ? messageData.path : undefined;
  if (typeof path?.cwd === 'string' && path.cwd.length > 0) refs.cwd = path.cwd;
  const modelId = typeof messageData.modelID === 'string' ? messageData.modelID : undefined;
  const model = isPlainRecord(messageData.model) && typeof messageData.model.modelID === 'string' ? messageData.model.modelID : modelId;
  if (model !== undefined && model.length > 0) refs.model = model;
  return refs;
}

function userTextOf(messageData: Record<string, unknown>): string {
  return textOf(messageData.text);
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** ok only when the tool state says so — never guessed. */
function okOf(state: Record<string, unknown> | undefined): boolean | undefined {
  if (state === undefined) return undefined;
  if (state.status === 'completed') return true;
  if (state.status === 'error') return false;
  return undefined;
}
