# Changelog

Newest first. One dated section per change.

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
