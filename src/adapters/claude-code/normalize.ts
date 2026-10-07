/**
 * Claude Code normalization: JSONL rows → unified Event.
 *
 * Source shape (measured against ~/.claude/projects on this machine):
 * - One JSONL per session, plus per-subagent transcripts under
 *   <session-uuid>/subagents/. Subagent files repeat the PARENT session id on
 *   every row, so a sessionId does not identify a file — the ordinal scheme
 *   below folds in a per-file rank for exactly that reason.
 * - Row `type` ∈ user | assistant | system | attachment | mode |
 *   permission-mode | atis-latch | last-prompt | ai-title | cost-state |
 *   queue-operation | file-history-snapshot | file-history-delta. Only
 *   user/assistant rows carry conversation content; everything else is
 *   infrastructure and maps to null.
 * - One assistant row can carry text AND thinking blocks AND several tool_use
 *   blocks; one user row can carry several tool_result blocks. The Adapter
 *   contract is 1 raw → 1 event, so read() fans a row out into one RawEvent
 *   per mappable part (payload.part) and this module maps each part. Rows
 *   whose message part carries no text are represented by their sub-parts.
 *
 * Ordinal scheme: files are append-only, so the 1-based line index is stable
 * across re-reads, and the sorted file list makes a file's rank stable too.
 * With CLAUDE_FILE_SPACE above any plausible file length (measured max: 1537
 * lines):
 *
 *   ordinal    = fileRank * CLAUDE_FILE_SPACE + line * CLAUDE_SUB_SPACE + partOffset
 *   partOffset = 0 for the row's own message, else the part's fan-out position
 *
 * which is unique and strictly increasing within a sessionId. `part.index`
 * stays the position among same-kind sub-parts (the value callers look up
 * blocks with); the ordinal uses the fan-out position instead, so a row that
 * mixes thinking and tool_use blocks cannot collide. Caveat: compacting a file
 * rewrites line indexes, and a new subagent file inserted earlier in the sort
 * order shifts later file ranks — both change ids of the affected rows.
 * Append-only files are the norm; re-reading the same bytes is idempotent.
 */

import type { Event, EventRefs, EventRole, EventTool } from '../../core/event.ts';
import type { RawEvent } from '../../core/privacy.ts';
import { buildEvent, collectText, isPlainRecord, pickMeta, toEpochMs, truncate } from '../shared.ts';

export const CLAUDE_SOURCE = 'claude-code';
/** Ordinal headroom for the fan-out under one row (the row + up to 99 sub-parts). */
export const CLAUDE_SUB_SPACE = 100;
/** Ordinal headroom for one file's worth of lines, so files of one session never collide. */
export const CLAUDE_FILE_SPACE = 100_000_000;
const ARGS_SUMMARY_MAX = 400;

export type ClaudePartKind = 'message' | 'tool_call' | 'tool_result' | 'thinking' | 'meta';

/** RawEvent.payload envelope for Claude Code; `part` is one mappable unit. */
export interface ClaudeCodePayload {
  /** From row.sessionId — subagent rows carry the parent session's id. */
  sessionId: string;
  file: string;
  /** 1-based line index inside `file`; the file is append-only, so it is stable. */
  line: number;
  /** 0-based rank of `file` in the adapter's sorted file list. */
  fileRank: number;
  /** The parsed JSONL line, verbatim. */
  row: unknown;
  part: { kind: ClaudePartKind; index: number };
}

export interface ClaudePart {
  kind: ClaudePartKind;
  /** Position among same-kind sub-parts (tool_use / thinking / tool_result blocks). */
  index: number;
}

const ROW_META_KEYS = [
  'uuid',
  'parentUuid',
  'isSidechain',
  'gitBranch',
  'version',
  'entrypoint',
  'permissionMode',
  'subtype',
  'agentId',
] as const;

export function isClaudeCodePayload(payload: unknown): payload is ClaudeCodePayload {
  if (!isPlainRecord(payload) || !isPlainRecord(payload.row) || !isPlainRecord(payload.part)) return false;
  if (typeof payload.part.kind !== 'string' || typeof payload.sessionId !== 'string') return false;
  return typeof payload.line === 'number' && typeof payload.fileRank === 'number';
}

/**
 * The mappable parts of a row, in fan-out order: the row's own message part
 * first, then one part per thinking / tool_use / tool_result block, capped at
 * CLAUDE_SUB_SPACE-1 sub-parts. Non-conversation rows yield a single 'meta'
 * part so read() drops nothing; normalize() returns null for them.
 */
export function claudeParts(row: Record<string, unknown>): ClaudePart[] {
  const rowType = row.type;
  if (rowType !== 'user' && rowType !== 'assistant') return [{ kind: 'meta', index: 0 }];

  const parts: ClaudePart[] = [{ kind: 'message', index: 0 }];
  for (const block of contentBlocks(messageOf(row))) {
    if (parts.length >= CLAUDE_SUB_SPACE) break;
    const kind = blockKind(rowType, block);
    if (kind === undefined) continue;
    parts.push({ kind, index: parts.filter((part) => part.kind === kind).length });
  }
  return parts;
}

export function normalizeClaudeCode(raw: RawEvent): Event | null {
  if (!isClaudeCodePayload(raw.payload)) return null;
  const { sessionId, file, line, fileRank, part } = raw.payload;
  const row = raw.payload.row;
  if (!isPlainRecord(row)) return null;
  if (sessionId.length === 0) return null;
  const ts = toEpochMs(row.timestamp);
  if (ts === undefined) return null;

  const message = messageOf(row);
  const meta = baseMeta(row, file, message);
  const refs = buildRefs(row, message);
  const ordinal = fileRank * CLAUDE_FILE_SPACE + line * CLAUDE_SUB_SPACE + partOffset(row, part);
  const draft = { source: CLAUDE_SOURCE, sessionId, ordinal, ts, refs, rawPayload: raw.payload };

  if (part.kind === 'meta') {
    // System rows become session_start only when they open the session (root
    // row); mid-session notices stay infrastructure and map to null.
    if (row.type !== 'system' || row.parentUuid !== null) return null;
    return buildEvent({ ...draft, role: 'system', kind: 'session_start', meta });
  }

  const rowType = row.type;
  if (rowType !== 'user' && rowType !== 'assistant') return null;
  const role: EventRole = rowType === 'assistant' ? 'assistant' : 'user';
  // A subagent transcript opens with a sidechain root row; that row is the
  // subagent session's start, not an ordinary prompt.
  const sessionRoot = row.parentUuid === null && row.isSidechain === true;

  switch (part.kind) {
    case 'message': {
      const text = messageText(message);
      if (text.length === 0) return null; // content lives in the sub-parts
      return buildEvent({
        ...draft,
        role,
        kind: sessionRoot ? 'session_start' : 'message',
        text,
        meta,
      });
    }

    case 'thinking': {
      const block = blocksOf(message, 'thinking')[part.index];
      if (block === undefined) return null;
      const thinkingMeta = { ...meta };
      if (typeof block.signature === 'string' && block.signature.length > 0) thinkingMeta.hasSignature = true;
      const text = typeof block.thinking === 'string' ? block.thinking : '';
      return buildEvent({ ...draft, role: 'assistant', kind: 'reasoning', text, meta: thinkingMeta });
    }

    case 'tool_call': {
      const block = blocksOf(message, 'tool_use')[part.index];
      if (block === undefined) return null;
      const name = typeof block.name === 'string' && block.name.length > 0 ? block.name : 'unknown';
      const tool: EventTool = { name, argsSummary: truncate(JSON.stringify(block.input) ?? '', ARGS_SUMMARY_MAX) };
      const callMeta = { ...meta };
      if (typeof block.id === 'string') callMeta.toolCallId = block.id;
      return buildEvent({ ...draft, role: 'assistant', kind: 'tool_call', tool, meta: callMeta });
    }

    case 'tool_result': {
      const block = blocksOf(message, 'tool_result')[part.index];
      if (block === undefined) return null;
      // ok only when the source actually says so via the is_error flag.
      const ok = typeof block.is_error === 'boolean' ? !block.is_error : undefined;
      const tool: EventTool = ok === undefined ? { name: 'unknown' } : { name: 'unknown', ok };
      const resultMeta = { ...meta };
      if (typeof block.tool_use_id === 'string') resultMeta.toolUseId = block.tool_use_id;
      if (typeof block.is_error === 'boolean') resultMeta.isError = block.is_error;
      return buildEvent({
        ...draft,
        role: 'tool',
        kind: 'tool_result',
        text: blockText(block.content),
        tool,
        meta: resultMeta,
      });
    }
  }
}

/** 0 for the row's own message, else the part's position in the fan-out. */
function partOffset(row: Record<string, unknown>, part: ClaudeCodePayload['part']): number {
  if (part.kind === 'message') return 0;
  const position = claudeParts(row).findIndex((candidate) => candidate.kind === part.kind && candidate.index === part.index);
  return position < 0 ? 1 + part.index : position;
}

function blockKind(rowType: 'user' | 'assistant', block: Record<string, unknown>): ClaudePartKind | undefined {
  if (block.type === 'thinking') return rowType === 'assistant' ? 'thinking' : undefined;
  if (block.type === 'tool_use') return rowType === 'assistant' ? 'tool_call' : undefined;
  if (block.type === 'tool_result') return rowType === 'user' ? 'tool_result' : undefined;
  return undefined;
}

function messageOf(row: Record<string, unknown>): Record<string, unknown> | undefined {
  return isPlainRecord(row.message) ? row.message : undefined;
}

function contentBlocks(message: Record<string, unknown> | undefined): Record<string, unknown>[] {
  if (message === undefined || !Array.isArray(message.content)) return [];
  return message.content.filter(isPlainRecord);
}

function blocksOf(message: Record<string, unknown> | undefined, type: string): Record<string, unknown>[] {
  return contentBlocks(message).filter((block) => block.type === type);
}

function messageText(message: Record<string, unknown> | undefined): string {
  if (message === undefined) return '';
  if (typeof message.content === 'string') return message.content;
  return collectText(message.content).text;
}

function blockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return collectText(content).text;
  return '';
}

function baseMeta(
  row: Record<string, unknown>,
  file: string,
  message: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const meta = pickMeta(row, ROW_META_KEYS);
  meta.file = file;
  if (message !== undefined && isPlainRecord(message.usage)) meta.usage = message.usage;
  return meta;
}

function buildRefs(row: Record<string, unknown>, message: Record<string, unknown> | undefined): EventRefs | undefined {
  const refs: EventRefs = {};
  if (typeof row.cwd === 'string') refs.cwd = row.cwd;
  if (message !== undefined && typeof message.model === 'string') refs.model = message.model;
  return Object.keys(refs).length > 0 ? refs : undefined;
}
