/**
 * Gemini CLI normalization: session JSONL records → unified Event.
 *
 * Source shape (from the gemini-cli chat recorder, packages/core/src/services/
 * chatRecordingService.ts, measured format on gemini-cli main@2026-10):
 * - One JSONL per session under ~/.gemini/tmp/<project>/chats/, first line is
 *   the conversation metadata {sessionId, projectHash, startTime, lastUpdated,
 *   summary?, kind?} and the rest are records:
 *   MessageRecord {id, timestamp, type:'user'|'gemini'|'info'|'error'|'warning',
 *   content, displayContent?, toolCalls?, thoughts?, tokens?, model?},
 *   {$rewindTo} rollbacks, {$patch:{...}} edits, and {$set:{...}} metadata.
 * - A gemini message fans out: text content, thoughts[], and toolCalls[] are
 *   all siblings on one record, so read() fans each record into one
 *   message/thought/tool part per unit.
 *
 * Ordinal scheme: files are append-only between compactions/rewinds, so the
 * 1-based line index keys the sequence and the fan-out folds into a
 * sub-space, like the Claude Code adapter. Patch records do NOT mutate
 * earlier ordinals — they map to their own meta rows (dropped), keeping ids
 * stable across re-reads even when the file is rewritten (the rewritten file
 * yields the post-patch message set; the caveat is that ids then differ from
 * the pre-rewrite read of the same session).
 */

import type { Event, EventRefs, EventTool } from '../../core/event.ts';
import type { RawEvent } from '../../core/privacy.ts';
import { buildEvent, collectText, isPlainRecord, pickMeta, toEpochMs } from '../shared.ts';

export const GEMINI_SOURCE = 'gemini';
/** Ordinal headroom for the fan-out under one record. */
export const GEMINI_SUB_SPACE = 100;

export type GeminiPartKind = 'message' | 'thought' | 'tool_call' | 'meta';

export interface GeminiPart {
  kind: GeminiPartKind;
  index: number;
  /** 0-based fan-out position among the row's parts; keys the ordinal. */
  offset: number;
}

/** RawEvent.payload envelope for Gemini CLI; `part` is one mappable unit. */
export interface GeminiPayload {
  sessionId: string;
  file: string;
  /** 1-based line index inside `file`; append-only between rewrites. */
  line: number;
  /** The parsed JSONL record, verbatim. */
  row: unknown;
  part: GeminiPart;
}

export function isGeminiPayload(payload: unknown): payload is GeminiPayload {
  if (!isPlainRecord(payload) || !isPlainRecord(payload.row) || !isPlainRecord(payload.part)) return false;
  if (typeof payload.part.kind !== 'string' || typeof payload.sessionId !== 'string') return false;
  return typeof payload.line === 'number';
}

/**
 * The mappable parts of a record, in fan-out order. Metadata lines and
 * $patch/$rewindTo/$set records yield a single 'meta' part; normalize()
 * maps the file's metadata line to session_start and returns null for the
 * patch records.
 */
export function geminiParts(row: Record<string, unknown>): GeminiPart[] {
  if (isPatchRecord(row)) return [{ kind: 'meta', index: 0, offset: 0 }];
  if (typeof row.type !== 'string') return [{ kind: 'meta', index: 0, offset: 0 }];
  const parts: GeminiPart[] = [{ kind: 'meta', index: 0, offset: 0 }];
  if (row.type === 'user' || row.type === 'gemini') {
    parts.push({ kind: 'message', index: 0, offset: parts.length });
  }
  if (row.type === 'gemini') {
    const thoughts = Array.isArray(row.thoughts) ? row.thoughts.filter(isPlainRecord) : [];
    for (const thought of thoughts) {
      if (parts.length >= GEMINI_SUB_SPACE) break;
      parts.push({ kind: 'thought', index: parts.filter((p) => p.kind === 'thought').length, offset: parts.length });
    }
    const calls = Array.isArray(row.toolCalls) ? row.toolCalls.filter(isPlainRecord) : [];
    for (const call of calls) {
      if (parts.length >= GEMINI_SUB_SPACE) break;
      parts.push({ kind: 'tool_call', index: parts.filter((p) => p.kind === 'tool_call').length, offset: parts.length });
    }
  }
  return parts;
}

export function normalizeGemini(raw: RawEvent): Event | null {
  if (!isGeminiPayload(raw.payload)) return null;
  const { sessionId, file, line, part } = raw.payload;
  const row = raw.payload.row;
  if (!isPlainRecord(row) || sessionId.length === 0) return null;

  // File metadata line: session_start (no per-record timestamp; the file's
  // startTime keys it).
  if (typeof row.sessionId === 'string' && isPlainRecord(row) && row.projectHash !== undefined && row.startTime !== undefined) {
    if (part.kind !== 'meta') return null;
    const ts = toEpochMs(row.startTime);
    if (ts === undefined) return null;
    const meta = pickMeta(row, ['projectHash', 'lastUpdated', 'summary', 'kind']);
    meta.file = file;
    return buildEvent({ source: GEMINI_SOURCE, sessionId, ordinal: line, ts, role: 'system', kind: 'session_start', meta, rawPayload: raw.payload });
  }

  if (part.kind === 'meta') return null; // $patch / $rewindTo / $set records
  const ts = toEpochMs(row.timestamp);
  if (ts === undefined) return null;
  const type = row.type;
  const ordinal = line * GEMINI_SUB_SPACE + part.offset;
  const meta = baseMeta(row, file);
  const draft = { source: GEMINI_SOURCE, sessionId, ordinal, ts, meta, rawPayload: raw.payload };

  if (part.kind === 'message') {
    if (type === 'user') {
      return buildEvent({ ...draft, role: 'user', kind: 'message', text: contentText(row.content) });
    }
    if (type === 'gemini') {
      const text = contentText(row.displayContent ?? row.content);
      if (text.length === 0) return null; // content lives in the thought/tool parts
      return buildEvent({ ...draft, role: 'assistant', kind: 'message', text });
    }
    // info / error / warning are UI notices with no authored content.
    return null;
  }

  if (type !== 'gemini') return null;
  if (part.kind === 'thought') {
    const thoughts = Array.isArray(row.thoughts) ? row.thoughts.filter(isPlainRecord) : [];
    const thought = thoughts[part.index];
    if (thought === undefined) return null;
    const text = collectText([thought]).text || (typeof thought.subject === 'string' ? thought.subject : '');
    return buildEvent({ ...draft, role: 'assistant', kind: 'reasoning', text });
  }
  // part.kind === 'tool_call'
  const calls = Array.isArray(row.toolCalls) ? row.toolCalls.filter(isPlainRecord) : [];
  const call = calls[part.index];
  if (call === undefined) return null;
  const name = typeof call.name === 'string' && call.name.length > 0 ? call.name : 'unknown';
  const tool: EventTool = { name, argsSummary: truncateArgs(call.args) };
  const callMeta = { ...meta };
  if (typeof call.id === 'string') callMeta.toolCallId = call.id;
  if (typeof call.status === 'string') callMeta.status = call.status;
  if (call.status !== undefined && call.status !== 'executing' && call.status !== 'awaiting_approval') {
    callMeta.ok = call.status === 'success';
  }
  return buildEvent({ ...draft, role: 'assistant', kind: 'tool_call', tool, meta: callMeta });
}

function isPatchRecord(row: Record<string, unknown>): boolean {
  return row.$rewindTo !== undefined || row.$patch !== undefined || row.$set !== undefined;
}

function baseMeta(row: Record<string, unknown>, file: string): Record<string, unknown> {
  const meta = pickMeta(row, ['id', 'model', 'tokens']);
  meta.file = file;
  return meta;
}

/** content is PartListUnion: a string or an array of {text} parts. */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  return collectText(content).text;
}

function truncateArgs(args: unknown): string {
  if (args === undefined) return '';
  const json = JSON.stringify(args) ?? '';
  return json.length > 400 ? json.slice(0, 400) : json;
}
