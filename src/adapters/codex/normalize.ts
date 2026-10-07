/**
 * Codex normalization: rollout JSONL lines → unified Event.
 *
 * Source shape (measured against ~/.codex/sessions on this machine):
 * - Each line is a self-describing envelope
 *   {timestamp, ordinal, type, payload}; `ordinal` is strictly increasing
 *   within a file (measured across all 312 files: zero regressions), so —
 *   unlike Claude/Hermes — nothing is fanned out: one line yields at most one
 *   Event, and `payload.ordinal` keys the sequence directly.
 * - Measured line types: session_meta, response_item, event_msg,
 *   turn_context, compacted, world_state, token_usage_record. Only
 *   response_item, session_meta and the turn-boundary event_msg rows carry
 *   conversation content; token_count / item_completed / world_state / ...
 *   are telemetry and map to null as designed.
 * - Measured payload.type shapes: message blocks are input_text /
 *   output_text (input_image is counted, not dropped on the floor — see
 *   meta.nonTextBlocks); reasoning carries summary[].text, and newer rows
 *   put plaintext thoughts in content[].text with encrypted_content as an
 *   opaque blob; function_call/custom_tool_call arguments are JSON strings.
 *
 * Ordinal scheme: session_meta.id and session_meta.session_id are NOT unique
 * per file (forked rollouts and subagent/guardian threads share the parent's
 * id), so ordinal folds in a per-file rank:
 *
 *   ordinal = fileRank * CODEX_FILE_SPACE + line.ordinal * CODEX_SUB_SPACE + partOffset
 *
 * with CODEX_FILE_SPACE above any plausible line count (measured max line
 * ordinal: 3981). Part is always index 0 today; the sub-space leaves room for
 * a future fan-out without a renumbering. Caveat: appending to a file keeps
 * earlier ordinals stable, but a rewritten rollout would shift ids.
 */

import type { Event, EventKind, EventRefs, EventRole, EventTool } from '../../core/event.ts';
import type { RawEvent } from '../../core/privacy.ts';
import { buildEvent, collectText, isPlainRecord, parseJsonSafe, toEpochMs, truncate } from '../shared.ts';

export const CODEX_SOURCE = 'codex';
/** Ordinal headroom under one line's ordinal — reserve for future fan-out. */
export const CODEX_SUB_SPACE = 100;
/** Ordinal headroom for one file's worth of lines, so files of one session never collide. */
export const CODEX_FILE_SPACE = 100_000_000;
const ARGS_SUMMARY_MAX = 400;
const EXIT_CODE_MAX_SCAN = 200;
const EXIT_CODE_PATTERNS = [/^Exit code:\s*(-?\d+)/m, /^Process exited with code\s*(-?\d+)/m];

/** EventKind plus 'meta' — the classification read() stamps on every line. */
export type CodexPartKind = EventKind | 'meta';

/** Per-file state read() threads through the stream (mirrors Codex's own order). */
export interface CodexContext {
  cwd?: string;
  model?: string;
  approvalPolicy?: unknown;
  sandboxPolicy?: unknown;
  /** True once a compacted line has been seen in this file. */
  compacted: boolean;
}

/** RawEvent.payload envelope for Codex: one line, its classification, context. */
export interface CodexPayload {
  /** From session_meta.session_id (falls back to id; they can DIFFER). */
  sessionId: string;
  file: string;
  /** 0-based rank of `file` in the adapter's sorted file list. */
  fileRank: number;
  /** The parsed JSONL line, verbatim. */
  row: unknown;
  part: { kind: CodexPartKind; index: number };
  context: CodexContext;
}

export function isCodexPayload(payload: unknown): payload is CodexPayload {
  if (!isPlainRecord(payload) || !isPlainRecord(payload.row) || !isPlainRecord(payload.part)) return false;
  if (!isPlainRecord(payload.context)) return false;
  if (typeof payload.part.kind !== 'string' || typeof payload.sessionId !== 'string') return false;
  return typeof payload.fileRank === 'number';
}

/**
 * Which EventKind a rollout line can map to; 'meta' means no conversation
 * content (telemetry, turn_context, compacted, world_state, ...).
 */
export function codexPartKind(row: Record<string, unknown>): CodexPartKind {
  const type = row.type;
  const payload = isPlainRecord(row.payload) ? row.payload : undefined;
  const payloadType = payload !== undefined && typeof payload.type === 'string' ? payload.type : undefined;

  if (type === 'session_meta') return 'session_start';
  if (type === 'response_item') {
    switch (payloadType) {
      case 'message':
        return 'message';
      case 'reasoning':
        return 'reasoning';
      case 'function_call':
      case 'custom_tool_call':
      case 'web_search_call':
        return 'tool_call';
      case 'function_call_output':
      case 'custom_tool_call_output':
        return 'tool_result';
      default:
        return 'meta';
    }
  }
  if (type === 'event_msg') {
    switch (payloadType) {
      case 'task_started':
        return 'session_start';
      case 'task_complete':
      case 'turn_aborted':
        return 'session_end';
      default:
        return 'meta';
    }
  }
  return 'meta';
}

export function normalizeCodex(raw: RawEvent): Event | null {
  if (!isCodexPayload(raw.payload)) return null;
  const { sessionId, file, fileRank, part, context } = raw.payload;
  const row = raw.payload.row;
  if (!isPlainRecord(row)) return null;
  if (sessionId.length === 0) return null;
  const lineOrdinal = row.ordinal;
  if (typeof lineOrdinal !== 'number' || !Number.isInteger(lineOrdinal) || lineOrdinal < 0) return null;
  const ts = toEpochMs(row.timestamp);
  if (ts === undefined) return null;

  const payload = isPlainRecord(row.payload) ? row.payload : undefined;
  if (payload === undefined || part.kind === 'meta') return null;

  const ordinal = fileRank * CODEX_FILE_SPACE + lineOrdinal * CODEX_SUB_SPACE + part.index;
  const refs = buildRefs(context);
  const draft = { source: CODEX_SOURCE, sessionId, ordinal, ts, refs, rawPayload: raw.payload };

  switch (part.kind) {
    case 'message':
      return messageEvent(draft, payload, file, context);

    case 'reasoning': {
      // summary[] is the portable field; newer rows carry the actual thought
      // in content[].text. encrypted_content is opaque — flag it, never text.
      const summary = collectText(payload.summary).text;
      const content = collectText(payload.content).text;
      const meta = baseMeta(file, context);
      if (typeof payload.encrypted_content === 'string' && payload.encrypted_content.length > 0) {
        meta.hasEncryptedReasoning = true;
      }
      return buildEvent({ ...draft, role: 'assistant', kind: 'reasoning', text: summary.length > 0 ? summary : content, meta });
    }

    case 'tool_call': {
      const name =
        payload.type === 'web_search_call'
          ? 'web_search'
          : typeof payload.name === 'string' && payload.name.length > 0
            ? payload.name
            : 'unknown'; // measured: some function_call rows carry name ""
      const args =
        payload.type === 'web_search_call' ? payload.action : (payload.arguments ?? payload.input);
      const meta = toolMeta(payload, file, context);
      return buildEvent({
        ...draft,
        role: 'assistant',
        kind: 'tool_call',
        tool: { name, argsSummary: argsSummaryOf(args) },
        meta,
      });
    }

    case 'tool_result': {
      // ok only when the output itself says so (Exit code / metadata.exit_code).
      const ok = exitOk(payload.output);
      const tool: EventTool = ok === undefined ? { name: 'unknown' } : { name: 'unknown', ok };
      const meta = toolMeta(payload, file, context);
      return buildEvent({
        ...draft,
        role: 'tool',
        kind: 'tool_result',
        text: typeof payload.output === 'string' ? payload.output : '',
        tool,
        meta,
      });
    }

    case 'session_start': {
      if (row.type === 'session_meta') return sessionMetaEvent(draft, payload, file, context);
      // event_msg: task_started — a turn boundary, per the source's own naming.
      const meta = baseMeta(file, context);
      copyMeta(meta, payload, {
        turnId: 'turn_id',
        startedAt: 'started_at',
        modelContextWindow: 'model_context_window',
        collaborationModeKind: 'collaboration_mode_kind',
      });
      attachPolicies(meta, context);
      return buildEvent({ ...draft, role: 'system', kind: 'session_start', meta });
    }

    case 'session_end': {
      const meta = baseMeta(file, context);
      copyMeta(meta, payload, {
        turnId: 'turn_id',
        completedAt: 'completed_at',
        reason: 'reason',
        lastAgentMessage: 'last_agent_message',
      });
      attachPolicies(meta, context);
      return buildEvent({ ...draft, role: 'system', kind: 'session_end', meta });
    }
  }
}

function messageEvent(
  draft: { source: string; sessionId: string; ordinal: number; ts: number; refs: EventRefs | undefined; rawPayload: unknown },
  payload: Record<string, unknown>,
  file: string,
  context: CodexContext,
): Event | null {
  const sourceRole = payload.role;
  if (sourceRole !== 'user' && sourceRole !== 'assistant' && sourceRole !== 'developer') return null;
  // developer rows carry the CLI's own instructions; they are system content
  // in conversation position, so they map to role 'system' rather than null.
  const role: EventRole = sourceRole === 'assistant' ? 'assistant' : sourceRole === 'user' ? 'user' : 'system';
  const collected = collectText(payload.content);
  const meta = baseMeta(file, context);
  if (collected.nonTextBlocks > 0) meta.nonTextBlocks = collected.nonTextBlocks;
  return buildEvent({ ...draft, role, kind: 'message', text: collected.text, meta });
}

function sessionMetaEvent(
  draft: { source: string; sessionId: string; ordinal: number; ts: number; refs: EventRefs | undefined; rawPayload: unknown },
  payload: Record<string, unknown>,
  file: string,
  context: CodexContext,
): Event {
  const meta = baseMeta(file, context);
  copyMeta(meta, payload, {
    threadId: 'id',
    sessionId: 'session_id',
    cliVersion: 'cli_version',
    originator: 'originator',
    modelProvider: 'model_provider',
    source: 'source',
    historyMode: 'history_mode',
    threadSource: 'thread_source',
    parentThreadId: 'parent_thread_id',
    forkedFromId: 'forked_from_id',
    agentNickname: 'agent_nickname',
  });
  if (isPlainRecord(payload.git)) meta.git = payload.git;
  if (payload.base_instructions !== null && payload.base_instructions !== undefined) meta.hasBaseInstructions = true;
  if (Array.isArray(payload.dynamic_tools)) meta.dynamicToolCount = payload.dynamic_tools.length;
  attachPolicies(meta, context);
  return buildEvent({ ...draft, role: 'system', kind: 'session_start', meta });
}

/** meta for tool rows: call id, status and the turn id in all its known homes. */
function toolMeta(payload: Record<string, unknown>, file: string, context: CodexContext): Record<string, unknown> {
  const meta = baseMeta(file, context);
  copyMeta(meta, payload, { callId: 'call_id', status: 'status' });
  const turnId = turnIdOf(payload);
  if (turnId !== undefined) meta.turnId = turnId;
  return meta;
}

function turnIdOf(payload: Record<string, unknown>): string | undefined {
  if (typeof payload.turn_id === 'string') return payload.turn_id;
  const passthrough = payload.internal_chat_message_metadata_passthrough;
  if (isPlainRecord(passthrough) && typeof passthrough.turn_id === 'string') return passthrough.turn_id;
  return undefined;
}

function baseMeta(file: string, context: CodexContext): Record<string, unknown> {
  const meta: Record<string, unknown> = { file };
  if (context.compacted) meta.compacted = true;
  return meta;
}

function copyMeta(target: Record<string, unknown>, source: Record<string, unknown>, keys: Record<string, string>): void {
  for (const [out, from] of Object.entries(keys)) {
    if (source[from] !== undefined) target[out] = source[from];
  }
}

function attachPolicies(meta: Record<string, unknown>, context: CodexContext): void {
  if (context.approvalPolicy !== undefined) meta.approvalPolicy = context.approvalPolicy;
  if (context.sandboxPolicy !== undefined) meta.sandboxPolicy = context.sandboxPolicy;
}

function buildRefs(context: CodexContext): EventRefs | undefined {
  const refs: EventRefs = {};
  if (context.cwd !== undefined) refs.cwd = context.cwd;
  if (context.model !== undefined) refs.model = context.model;
  return Object.keys(refs).length > 0 ? refs : undefined;
}

/**
 * argsSummary: pretty-print an already-parsed JSON string (function_call
 * arguments are JSON text), otherwise stringify the value itself, otherwise
 * fall back to the raw string (custom_tool_call input is a patch, not JSON).
 */
function argsSummaryOf(value: unknown): string {
  if (typeof value === 'string') return truncate(JSON.stringify(parseJsonSafe(value)) ?? value, ARGS_SUMMARY_MAX);
  if (value !== undefined) return truncate(JSON.stringify(value) ?? '', ARGS_SUMMARY_MAX);
  return '';
}

/** Exit status when the output states one; undefined otherwise — never guessed. */
function exitOk(output: unknown): boolean | undefined {
  if (typeof output !== 'string') return undefined;
  const parsed = parseJsonSafe(output);
  if (isPlainRecord(parsed) && isPlainRecord(parsed.metadata)) {
    const code = parsed.metadata.exit_code;
    if (typeof code === 'number' && Number.isFinite(code)) return code === 0;
    if (typeof code === 'string' && code.trim().length > 0 && Number.isFinite(Number(code))) return Number(code) === 0;
  }
  const head = output.slice(0, EXIT_CODE_MAX_SCAN);
  for (const pattern of EXIT_CODE_PATTERNS) {
    const match = pattern.exec(head);
    const digits = match?.[1];
    if (digits !== undefined) {
      const code = Number(digits);
      if (Number.isFinite(code)) return code === 0;
    }
  }
  return undefined;
}
