# agent-memoir

## Adapters

Builtin adapters live under `src/adapters/<id>/` (one `index.ts` for discovery
and row reading, one `normalize.ts` for row → Event mapping) and are declared
in `registry.json`:

- `hermes` — `~/.hermes/state.db` (SQLite, opened `?immutable=1`).
- `claude-code` — `~/.claude/projects/*.jsonl`, one JSONL per session plus
  `subagents/` transcripts; sidechain rows key off `isSidechain`, not filenames.
- `codex` — `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, one self-describing
  envelope per line; the line's own `ordinal` keys the sequence.

Every adapter is read-only on its source, streams `RawEvent`s, and returns
`null` from `normalize()` for telemetry rows rather than inventing content.

`bun run verify` is the Phase 0 gate: it streams all detected sources, asserts
every Event validates, ordinals are strictly increasing per session, ingest is
lossless and idempotent, and the privacy boundary rejects Event/RawEvent while
accepting Insight.
