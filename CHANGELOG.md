# Changelog

Newest first. One dated section per change.

## 2026-10-15 — a deferred port resolves an unbuilt registry tree without poisoning resume

A deferred `From('app')` port (the target is not registered when the host tree
is built, so the branch keeps a run-time ref) falls back to the registry when
the host has no `loadTree`. A tree that only self-registered on import — or via
`registerTree` — never ran the build pass that auto-names its subtrees, and
`loadNamedTree` returned it as-is. Its unnamed `Branch`/`Each` bodies then
pushed empty stack frames, so the checkpoint's `branch_path` gained empty
segments (`…/trunk_turn///caller-list/…`) and the NEXT resume split on `/` and
threw `cannot resume: tree '' is not registered (call .name() to register)`.

This is the live shape behind a real crash: the trunk attaches
`From('trunk_turn')` before `trunk_step` is imported, and `trunk_turn`'s
`Branch(when(…), Tree(…))` and `Each(…, Tree(Call(…)))` bodies are unnamed.
The two earlier resume fixes covered a `loadTree`-returned tree
(`resume-loadtree.test.mjs`) and the resume-time normalization of a
host-registered tree (`resume-registered.test.mjs`); neither covered
`loadNamedTree`'s registry fallback — the path a deferred port takes on the
*initial* run, which poisoned the pause before resume ever ran.

`loadNamedTree` now auto-names and re-registers the cached def exactly as its
loaded path (and `resolveTreeForResume`) do. Pinned in
`resume-deferred-port.test.mjs`.

## 2026-10-15 — tool hooks fire on the dynamic `Call()` path

`Hook(toolBefore()/toolAfter(), …)` fired only for tool calls executed by a
prompt's auto loop. A tree that runs its own explicit loop — `Prompt(disableAuto())`
plus a dynamic `Call((m) => m.item.name, …)`, the trunk's shape — bypassed them
entirely, so a hook could not enrich or rewrite a tree tool invoked that way.

`execCall()` now fires the same hooks around every call it dispatches: a
`toolBefore` Return is merged into the call args; a `toolAfter` Return may
rewrite the result (or set `isError`); a resumed call skips only its
before-hook — it already ran pre-pause — and the after-hook still fires when the
subtree completes. A captured tree failure fires the after-hook too, with
`isError: true`. This mirrors the auto-loop semantics exactly. Pinned in
`auto-tools.test.mjs`: args enrichment + result rewrite on the explicit path,
and no before-hook replay across a pause.

## 2026-10-15 — a resumed turn keeps its run id (no phantom `runs` row)

`knit()` created a runId and called `startRun` BEFORE dispatching to
`resume()`, which then built its own exec from the checkpoint's run id and
registered that. Every resumed turn therefore registered a fresh run id that
never ran — invisible only because hosts' telemetry wrappers never delegated
`startRun` (so the phantom registration had nowhere to go). With hosts now
delegating it, the duplicate would have filed a bogus `runs` row per turn and
split each session's registry.

The resume dispatch now happens before any runId/startRun work: a resumed
turn registers exactly once, under its original run id. Pinned in
`session-log.test.mjs` (fresh run → pause → resume → one row, same run_id,
the delivered human event under it).

## 2026-10-15 — the `calls` log is indexed for its read paths

Hosts read the run log constantly (resume replays, tree viewer, run-log
tools, and read-time UI derivation), and every read scanned `calls` — 407 MB
/ 175k rows in the live workspace — synchronously on the process that serves
HTTP/SSE and the bot. Two indexes land at logger init (`IF NOT EXISTS`, so
existing logs build them on open; the live DB took ~0.5 s each):

- `idx_calls_run ON calls(run_id)` — the resume read
  (`WHERE run_id = ? ORDER BY seq`; `seq` is the rowid, so the index already
  serves the order) and runlog's emit-anchor/range lookups.
- `idx_calls_run_kind ON calls(run_id, kind)` — kind-filtered reads within a
  run (index seek) and whole-table `GROUP BY run_id, kind` roll-ups (covering
  index-only pass; `MAX(seq)` per group needs no table rows). This is the
  read path a host derives per-session UI state with.

Also pinned: resume replays every row of a run up to the checkpoint seq, so a
host that logs its own event kinds into `calls` must not break a resume —
`resume-foreign-events.test.mjs` proves unknown kinds are ignored and the run
resumes cleanly across them.

## 2026-10-15 — tool-result refs: `ref://<seq>` handles into the run log

A tool result too large to show the model no longer dead-ends at the display
cap. The truncation note now carries a `ref://<seq>/<path>` handle to the FULL
value in the run log, and a tree-tool argument may pass that handle — the
engine resolves it from the log before the target tree's slots are seeded, so
a whole list can move between trees without ever fitting the model's context.
This is the generalized fix for bulk handoffs (the 2026-10-14 enrich stall:
the trunk saw ~5 of 50 contacts and could only feed the app 4-person batches).

- `src/refs.mjs` (new) — ref grammar (`ref://<digits>[/<path>]`),
  `resolveRef(s)` with loud failures (unknown row, another run, missing
  path), structural sharing so ref-free args pass through uncopied, and
  `refsResolvable(exec)` (logger must expose `readRow`).
- `execMap` collects each item's `map_item` seq into the Each record
  (`itemSeqs`; null for replay on resume) — the address a note can mint.
- `runTreeTool` resolves refs in tree-tool args BEFORE seeding the child
  scope; unknown/cross-run refs surface as normal tool errors.
- The auto tool loop's cap (`capToolResult`) mints the same ref note when the
  logger can read rows back — the one-shot subagent path now matches the
  trunk's explicit-loop shaper; logger-less runs keep the old note verbatim.
- `SqliteLogger.readRow(seq)` (+ `CompositeLogger` forwarding and
  `runLogTools`' DB) — the store behind every ref.
- Tests: `refs.test.mjs` (unit), `ref-passthrough.test.mjs` (Each seqs +
  whole/path refs + loud failures), `ref-handoff.test.mjs` (the generalized
  producer → trunk-like loop → consumer handoff, and the same through the
  engine's auto loop; both mutation-checked).
