# Changelog

Newest first. One dated section per change.

## 2026-11-05 — a prompt can set its own temperature

`Prompt(temperature(0.7), …)` now sets the sampling temperature for that
prompt's LLM call(s). The marker accepts a finite number `>= 0` or a function
of memory returning one; a function is re-evaluated for every round of the auto
tool loop, and the slots it reads join the prompt's provenance. It sits anywhere
among the Prompt arguments, like `when()`/`max()`.

The OpenAI-compatible path sends the value as `body.temperature` (default stays
`0` when the marker is absent). The native Ollama path sends it as
`options.temperature`, overriding a configured `thinking.options.temperature`
but preserving the other options. The resolved value is carried on `llm_start`,
`llm_call`, and `llm_error` log rows, and on each `record.calls` round. A prompt
without the marker keeps its exact old record shape, so definition hashes do
not churn.

Tests: `tests/llm-temperature.test.mjs` (marker parsing/validation, OpenAI and
Ollama request bodies, mock handler context, per-round dynamic evaluation).

## 2026-11-03 — human rows say who spoke; `read_runs` gains a transcript

A delivered `human` row used to look identical whether the host handed the
engine a real reply (`runtime.humanInput`) or the tree filled the slot itself
(`Human(readFromMemoryOnce())`, an armed `Goto`/redirect). A reader — notably
the insight tree — could not tell the user's words from memory.

Delivered rows now carry `source`: `human` for a direct reply, `memory` for a
slot value delivered by `readFromMemoryOnce()`, and `goto` for an armed
Goto/redirect. The memory case also names `via` and the write `seq`; a pause
row has no source. Legacy delivered rows without `source` read as `human`.

`read_runs` surfaces this in condensed rows (`source` for human rows,
`channel: 'user' | 'machine'` for emits) and adds `mode: 'transcript'`: the
conversation as the user experienced it, oldest first — direct human replies
plus every emit, each `{ seq, speaker, source | channel, text }`. Memory/goto
deliveries and internals stay out. Machine emits are kept and labeled, and
`run_id`, `limit`, and `before`/`after` page a long conversation.

Tests: `tests/transcript.test.mjs` (chronological entries, exclusions,
paging, condensed source/channel, async parity), `tests/human-log.test.mjs`
(direct vs memory vs Goto source), and the existing runlog suite.

## 2026-11-03 — an LLM call can no longer hang a turn

The call deadline used to stop at the response headers: `postJsonWithRetry`
cleared its AbortController timer as soon as `fetch` resolved, so a provider
that accepted the connection and then stalled mid-body left the body read
awaiting forever — in the web app, a turn spinner that never resolved.

The deadline now covers the whole call (connect, headers and body), and once
body bytes start flowing a 30s idle window aborts a stalled stream instead of
waiting out the full budget. A timeout is now `LlmTimeoutError` (`code:
'llm_timeout'`) rather than a bare AbortError, so it is distinguishable from a
user stop and can be retried: hung calls get one retry regardless of
`maxAttempts` (four hung attempts would outlast any run watchdog). Truncated
bodies are retried as transport failures too, and the OpenAI-compatible path
now honours a per-model `timeout` like the Ollama path already did; both
accept `idleTimeout` to tune the body window.

Tests: `tests/llm-retry.test.mjs` (headers never arrive, mid-body stall,
truncated body, a slow trickle bounded by the whole-call deadline); `npm test`
(349 passing).

## 2026-11-02 — `max(count)` may resolve its cap from memory

A loop budget was fixed at build time. `max()` now also accepts a function of
memory as its count and re-evaluates it at every edge, so a tree can grow its
own budget as work succeeds — `Until(cond, max(m => m.max_passes))`, and the
same form on `Check(goback(..., max(fn)))` and `Prompt(max(fn), ...)`. A
dynamic count must return a positive integer; anything else fails with a
`KnitError` naming the loop and the bad value instead of silently using a
default. Static `max(n)` behavior is unchanged.

Tests: `tests/until-tree.test.mjs` (Until grows mid-loop, Check grows
mid-loop, invalid dynamic count fails), `tests/auto-tools.test.mjs` (a register
extends an auto-loop budget mid-run), `tests/builder.test.mjs`;
`npm test` (345 passing).

## 2026-11-02 — resume survives a tree edited while paused

A checkpoint saves child indexes from the build that paused. Editing the
pattern during a pause — the common case is a seed update adding a `Memory()`
before the trunk's `Human()` — shifted those indexes: the reply re-entered the
Human and was lost, and a later `Memory(update(), 'hook_actions')` threw
because the new declaration had never run. Resume now re-anchors each level by
name: the innermost level resumes past the same Human and ancestor levels
re-enter the branch/map that led deeper, falling back to the saved index when
a name no longer exists. Declarations the rebuilt tree added before the pause
point are seeded before hooks run, so an update can rely on its slot.

Tests: `tests/resume-shape-change.test.mjs` (a Memory inserted before the
paused Human, and an onHuman hook added in the new build); `npm test` (341
passing).

## 2026-11-01 — read_runs: recover a JSON-encoded type filter

Models sometimes send `type` as `"[\"tool_call\", …]"` or `"\"human\""`.
`normalizeTypes()` took the string literally, so `kind IN (?)` matched no row
and the caller read the empty result as "the log has no such rows". It now
recovers a JSON list or quoted string when the value parses as JSON, trims and
de-duplicates kinds, and leaves a genuinely literal kind alone. The parameter
description says to pass a real array.

Tests: `npm test` (339 passing; the new case covers an encoded list, a quoted
kind, a plain kind, a non-JSON string, and duplicates).

## 2026-10-28 — knit: `tool_start` event before a tool executes

`tool_call`/`tool_result` are logged after execution — each carries the
result — so a live event stream could not show which tool was running right
now, only which one had finished. Both execution paths (the model auto-loop's
`runCall` and the tree's `execCall`, including tree-backed tools) now log
`tool_start` with `{ child, round?, tool, args }` immediately before dispatch,
after the call is validated against the prompt's Tools() scope. Refused and
unknown calls still throw without a start row. The start row is also included
in the logger's info-level console output (`tool…`).

Tests: `npm test` (338 passing; the new row rides the existing auto-tools and
tree-tools resume paths).

## 2026-10-27 — llm: recover tool calls from the DSML text envelope

Some DeepSeek endpoints return their tool-call markup as plain `content`
instead of lifting it into `message.tool_calls` — a deepseek-v4.1-flash
session returned a compaction step as a `<|DSML| …>` envelope (the bar is
U+FF5C) of `invoke name="…"` blocks with `parameter name="…" string="true"`
children. `parseDsmlToolCalls()` reads that envelope into the same
`tool_calls` shape as the OpenAI path (string parameters keep their text,
untyped ones parse as JSON when they can), strips the envelope from
`content` — including when no tools were offered, the compaction case that
leaked — and ignores names the prompt was not offered. `callLlm` runs it
before the short-text recovery, so the leak cannot reach the caller as prose
or poison a compaction loop.

Tests: `tests/llm-dsml.test.mjs` — single and multiple invokes, untyped JSON,
unknown names, the no-tools strip, prose around the block, and the HTTP
`callLlm` path.

## 2026-10-26 — portable session log store: checkpoint shadows + restore over async drivers

`createSessionLogStore({ driver, allocateSeq, onEvent, onError, flushDelayMs })`
is the engine's synchronous logger contract over an asynchronous durable
driver. It owns the in-memory replica knit needs (`log` returns the row's seq
before any write; `readRow` resolves `ref://`), shadows call rows and
checkpoints, and restores a paused run after a process restart:

- `log()`/`readRow()`/`saveCheckpoint()`/`getCheckpoint()` stay synchronous.
- a checkpoint's shadow write is enqueued only after every call row it depends
  on, so "the checkpoint exists on disk" implies "its replay window does".
- `restore(checkpoint)` loads the run's rows up to `cp.seq`, validates that the
  pause row is present, hydrates memory, and leaves `resume()` synchronous.
- `flush()` settles rows + checkpoint shadows; `ready` seeds the seq counter
  from `driver.headSeq()` when the host allocates elsewhere.

`LOG_TABLES` (calls + checkpoints) is exported as the one schema, and
`SqliteLogger` now builds its tables from it — hosts no longer mirror the DDL.
`tests/logstore.test.mjs` pins the sync surface, shadow ordering,
restore/resume across stores, checkpoint consumption, torn-flush refusal, and
seq seeding. Hosts keep policy: BOB resolves which checkpoint a chat resumes
from its own turn markers.

## 2026-10-23 — logger: legacy `memory` rows are converted to records on open

Before record rows carried an `op` flag (2026-09-21), memory writes were
logged with their own kind (`memory`). The resume path kept a legacy branch
that still read that encoding, while the log readers never did. `SqliteLogger`
now converts such rows once on open — kind `record`, `op` `memory` (or
`memoryUpdate` when a legacy truthy `update` flag marks a patch write), with
`patch: true` preserving the old replay semantics (the slot is set, no
prev/raw entry is pushed) — and the legacy resume branch is gone, so the log
has one encoding everywhere. A `calls(kind)` index keeps the conversion's
existence guard an index seek on already-converted logs, and serves
`read_runs`' whole-log kind filters. Tests: `tests/logger.test.mjs` pins the
conversion, payload/seq stability, and that reopening converts nothing.

## 2026-10-23 — docs: the tree's header comment is the spec

The authoring docs drop the two-file (`.spec.md` + `.mjs`) model. A tree is one
file: the notation in its leading comment block is the spec, and the elements
below it are the execution; git is the version history. `docs/spec-parity.md`
is rewritten around that rule (header ↔ code audits; the `## Guide` host
contract still lives in an app README), `docs/pitfalls.md` retitles the drift
trap to "patching the code without its header", and the notation guide and
`AGENTS.md` no longer describe drafts or a pinned prod snapshot.

## 2026-10-22 — needs error names the call shape

A declared input that does not resolve now says what the caller actually sent
and what shape the tree expects, e.g.:

    tree 'insight' needs 'question', but it does not resolve in scope. The call
    sent {"input": "…"} but the tree declares {"question": "…"}; call it like:
    insight({"question": "…"}).

A tree-tool call with no args says "The call sent no arguments…"; a static
branch (From-attached, no call args) says "The tree declares inputs: late —
nothing in the scope chain provides it." The leading sentence is unchanged, so
hosts that classify on it (BOB's `isDroppableContinuationError`) and the
existing runner test keep working. `runTreeTool` stamps a fresh call's tool
name and argument keys on the child scope; the hint reads them only to phrase
the miss. Tests: `tests/runner.test.mjs` pins all three shapes.

## 2026-10-22 — Each records carry ready-made refs (`itemRefs`)

An `Each` record now ships the finished `ref://<name>.<seq>` handle for every
item (`itemRefs`, parallel to `itemSeqs`), minted beside the row it addresses:
`execMap` calls `refs.mjs` `formatRef` at the same moment it logs the
`map_item` row, with the loop's own name — the label that row attests via
`refName`. A fold or emit reads the handle instead of re-deriving the grammar,
so the label cannot drift from the row, and the case-sensitive ref grammar is
written in one place. Replayed items on resume stay null: their rows belong to
the previous run, and `resolveRef` rejects a cross-run handle.

`itemSeqs` and `refName` remain for one compatibility cycle — consumers that
predate `itemRefs` (grandma-workspace `lib/tool-policy.mjs` `rowRef`) can still
derive the handle from them.

**After:** once no live session can resume across this change, retire the
consumer fallback in `lib/tool-policy.mjs`, then `itemSeqs` here — the `RETIRE`
comments at both sites mark the pair. Tests: `tests/ref-passthrough.test.mjs`
now asserts the record's handle and passes it to a consumer unchanged.

## 2026-10-21 — pitfalls: reject natural-language allowlists

Documented a bad practice in `docs/pitfalls.md`: classifying prose (bare
affirmations, greetings, cancel words) with a hand-maintained `Set` of
phrases. Coverage is unbounded and every miss is a silent, arbitrary-looking
misclassification. Give the model the utterance and its context; keep code for
verifying the chosen action, not for deciding whether a phrase belongs to a
semantic category.

## 2026-10-21 — token usage on `llm_call`

`callLlm()` now returns `usage: { input, output }`, normalized from the
provider's response (`usage.prompt_tokens`/`completion_tokens`, the
`input_tokens`/`output_tokens` aliases some gateways use, or Ollama's
`prompt_eval_count`/`eval_count`). Nothing is invented when an endpoint — or a
mock handler — reports no usage: `usage` is then absent, so "not reported" is
distinguishable from zero. A knit prompt logs it on the `llm_call` event, so a
host can meter tokens per call/turn without reaching into the raw response.
`extractUsage` is exported for callers that already hold a raw body. Tests:
`tests/llm-usage.test.mjs`.

## 2026-10-21 — tools see the whole enclosing-tree chain (`ctx.trees`)

A registry tool's `execute(args, ctx)` now receives `ctx.trees` — every
enclosing named tree, outermost → innermost — alongside `ctx.tree` (the nearest
one). `ctx.tree` alone misidentifies an app whose flow runs inside a named
inner subtree: the contacts app's `select` loop reported `"select"`, so the
app's own company-creation gate (`upsert_contact`) refused calls made by the
app itself. Host tools can now check the whole chain (e.g.
`["contacts", "select"]`); `ctx.tree` is unchanged. Tested via the contacts
tool-gate and tree e2e suites.

## 2026-10-21 — Emit channel flags

`Emit()` takes a `flag(name)` marker anywhere among its arguments:
`Emit("starting", flag("machine"))` or
`Emit((m) => ({ text, buttons }), flag("machine"))`. The emitted value is
tagged with `level: name` (strings become `{ text, level }`; objects keep
their fields), so hosts can filter or style narration without losing it.
Literals are accepted only when a flag is present, preserving the existing
"missing function" build error. `flag` is exported from the package and added
to `PatternContext` in BOB. Tests: `tests/emit-flag.test.mjs`.

## 2026-10-21 — direct `Call()` / `calls()` tools get the full engine ctx

A host tool invoked directly — `Call('peek', 'inspect_memory', …)` or a
Register's `calls('inspect_memory')` — used to receive only
`view`/`context`/`boundary`/`tree`, so `inspect_memory` saw no
`ctx.readRef`/`ctx.scopeInfo` and returned an empty-scope error. Both paths now
use the same `toolCtxFor()` as the auto tool loop, so the tool works however it
is invoked. Test: `tests/inspect-memory.test.mjs` (direct-Call case).

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
