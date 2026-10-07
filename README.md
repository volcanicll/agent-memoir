# agent-memoir

A portrait of one person's working life, reconstructed from the local histories
of the AI agents they ran: Hermes, Claude Code, and Codex are normalized into
one `Event` stream, analyzed into a `Portrait`, and rendered as a static site.

```
sync → MemoirStore (SQLite) → analyzeAll() → Portrait → renderPortrait() → static site
```

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

## CLI

```sh
bun run cli -- init                             # detected sources and their paths
bun run cli -- sync                             # ingest everything (idempotent)
bun run cli -- stats --class interactive        # analysis summary to stdout
bun run cli -- portrait --out ./portrait        # write the static site
bun run cli -- export                           # one Insight JSON, aggregates only
```

`sync`, `stats`, `portrait`, and `export` share `--db <path>`, defaulting to
`~/.agent-memoir/events.db`. `export` is the only command that emits anything
that may leave the machine; its payload passes `assertExportable()` and
contains no paths, no session ids, and no conversation text.

## Session classes

Measured here: 84% of sessions are `cron`. A portrait over raw totals would
describe a scheduler, so every aggregate is computed per class and the site
defaults to `interactive`:

- `automation` — Hermes `cron` sessions (their `user` turns are written by a
  scheduler, so role alone cannot prove authorship), plus any session that is
  nothing but tool traffic.
- `interactive` — sessions from a human-driven source (telegram, cli, dingtalk,
  feishu, tui, acp; Claude Code and Codex) carrying an authored user turn.
- `other` — everything else: unlabeled, unknown-sourced, or empty. Reported as
  its own bucket, never folded into the other two.

## Privacy

`RawEvent` and `Event` are local-only; `Insight` is the only exportable shape.
Home paths are replaced with `~` at a single point (`src/analyze/redact.ts`,
one `HOME_REDACTION` constant), and `renderPortrait` asserts no home prefix
survives into `index.html`, `portrait.css`, or `portrait.js` before writing.

## Verification

```sh
bun run typecheck        # tsc --noEmit
bun test                 # unit tests: tokenizer, classifier, streak/gap, drift
bun run verify           # Phase 0 gates + the Phase 1 portrait gate
bun run verify:portrait  # just the portrait gate
```

`verify:real` streams this machine's sources; `verify:fixtures` and
`verify:portrait` run against checked-in synthetic fixtures, so they are
reproducible anywhere. The portrait gate builds a store from a fixed 490-event
fixture, asserts hand-computed analysis numbers, renders the site to a temp
directory, then drives headless Chrome to prove the page is neither blank (PNG
size against a blank-page reference) nor empty in the DOM (section markers and
real numbers in `--dump-dom`).
