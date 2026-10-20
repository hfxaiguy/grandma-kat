# Changelog

Newest first. One dated section per change.

## 2026-10-19 — package: a `grandma-kat/llm` subpath

Hosts and tests that drive a model directly can now `import { callLlm } from
"grandma-kat/llm"` — the package exports gained `"./llm": "./src/llm.mjs"`.
Previously a workspace consumer had to reach into the checkout's `src/` by
relative path, which breaks the npm-link contract.

## 2026-10-19 — ref labels are attested: every row names itself, a mismatched handle is rejected

A `ref://<name>.<seq>` handle's label used to be decoration — resolution parsed
only the seq. So a model could relabel or swap a real handle
(`ref://caller-list.99001` where 99001 is the contacts result) and a tree would
silently receive another value wearing the wrong name.

`logEvent` now stamps `content.refName` on every kind, best-effort: the tool for
a `tool_result`, the child/loop/slot for `map_item`/`map`/`record`, the hook
tree, the prompt for `llm_call`. Kinds with none (`scope_init`, `error`, …) are
left unstamped — the key is uniform, its presence is not. `resolveRef` compares
a handle's label to that field: when both are present and differ, the call fails
with the row's real name and both fixes (`ref://contacts.99001` or the bare
`ref://99001`). Bare handles, nameless rows, and pre-`refName` logs still
resolve, so old sessions and mixed-period logs keep working.

The mints now line up with the rows they point at. The engine's auto-loop cap
mints `ref://<tool>.<seq>` (and `/list` for a `{ list: […] }` result) instead of
a bare handle; `execMap`'s record carries `refName` so the trunk and trunk_step
folds label with the map's own name (`tool_calls`, `rows`); the contacts app's
hand-written `rows` literal already matches its `Each("rows", …)`. `refs.mjs`
exports `formatRef` so every producer writes the one grammar.
`tests/refname.test.mjs` pins the stamping per kind and the end-to-end
rejection; `tests/refs.test.mjs` pins the resolver.

## 2026-10-19 — predicate slots accept a Tree (`Until`, `Check`, `max` errFn)

`Until(cond, max(n, errFn))` and `Check(cond, goback/goto(…, max(n, errFn)))`
required a **function** for the condition and for the `max` error message.
Now either slot also takes a **Tree** — a bare element (wrapped into a
one-child tree) or a built `Tree(...)` def. The tree runs paused-free in a
fresh child scope and its exported value is the predicate result: for a
condition, truthy passes (a falsy value is the failure feedback); for an errFn,
the value is the exhaustion message.

Mechanically: `records.mjs` accepts an element/def in `checkFields`/
`untilFields` (`isTreeSpec`); `markers.mjs` `max()` accepts an object errFn;
`knit.mjs` `normalizeConditions` (run in `finalize`) wraps elements, names and
registers them, and asserts they are pause-free; `evalPredicate` runs the tree
at evaluation time; `validateTree`/`validateRuntime` walk predicate trees so
their child names, `Tools()`, `Call()` and model references are checked like
any other subtree. `exhaustionMessage` now takes the exec/scope so an errFn
tree can run.

Note for authors: a condition tree runs on **every pass**, so a prompt-backed
condition is one model call per loop pass — intended for "let the model decide
when to stop", costly if the loop is hot. Pinned in
`tests/until-tree.test.mjs`.

## 2026-10-17 — `inspect_memory`: a bounded view of a value held only by handle

A tool result too big for context crosses trees as a `ref://<name>.<seq>`
handle, and a live slot is addressable by its `m.<name>` — but both are opaque
to the model: a ref is a string it can only forward, and a slot it never read is
invisible. A model facing a 50-row list could only guess, or haul the whole
thing into context.

`inspect_memory` (new `src/inspect.mjs`, exported as `inspectMemoryTool()`) is a
host tool merged into `runtime.tools` like `runLogTools`. Given `name` (a live
slot), `ref` (a handle), or `name: '*'` (list the scope), it returns a small,
valid-JSON view: a type/size summary plus a random sample of rows (default 5;
`head` for the first N), with `path` to walk in, `seed` for a reproducible draw,
and `maxChars` for the budget. The full value stays in memory / the run log; only
the view enters context. A bad name or ref comes back as a normal tool error.

The engine grew two read-only capabilities on the tool context (`ctx.view`
already existed): `ctx.readRef(ref)` resolves a handle against this run's log,
and `ctx.scopeInfo()` lists the slots visible from the call site with each
slot's write `seq` — so the tool can cite a live slot's own `ref://<name>.<seq>`
for a later handoff. `src/memory.mjs` adds `scopeInventory`; `src/refs.mjs`
exports its `walk`; `tests/helpers.mjs` `mockRuntime` passes extra runtime
options through. Pinned in `tests/inspect-memory.test.mjs`.

## 2026-10-15 — resume re-derives a level whose stored name is gone; a pause reports its `treePath`

A checkpoint names the paused tree stack by `branch_path`, whose segments are
positional auto-names (`r#2`, `draft_profile#3`) — valid only for the exact
build that wrote them. When the tree was rebuilt (an anonymous body gets an
author name, a sibling shifts, an app is re-versioned) the name no longer
resolved and resume died with `cannot resume: tree 'draft_profile#3' is not
registered`, even though the pause point was intact.

Resume now resolves each level by name first and, when that name is gone,
re-derives the level from its **parent's recorded child index**: a branch/map
child carries its subtree (or a ref to load), so the paused subtree is picked
by position. A `Call` to a tree tool is not structural and still resolves by
name (the tool name in the branch_path). An auto-name already meant "child k of
parent", so this recovers the same subtree without depending on the name — and
it also revives checkpoints already poisoned with an empty segment. A host that
would rather not resume into a changed tree should drop the session first; the
engine cannot know the old build.

A waiting result now also carries `treePath` — the paused stack's
`branch_path` — so a host can pin which runtime-loaded subtrees a session
depends on. Pinned in `resume-positional.test.mjs` (a stale auto-name resumes
cleanly across two processes; fails with the exact error when the re-derivation
is disabled).

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
