# Auto tool-execution loop + tool hooks

Status: implemented (`src/knit.mjs` `execPrompt`, `src/tree.mjs` `Prompt()`,
`src/markers.mjs`). Tests: `tests/auto-tools.test.mjs` (the executable spec),
plus the single-round plumbing tests in `tests/runner.test.mjs`.

## What it does

A `Prompt()` with tools runs a **local conversation** by default:

1. The prompt's messages open a thread; round 1 calls the model.
2. Every tool call the model emits executes — the same resolution and call
   path as `.call()` (`resolveTool`: scoped registers first, runtime tools
   last; tree tools run in place; registers settle their `{ value, memory }`
   patches).
3. Results are appended to the thread as assistant `tool_calls` + one
   `tool` message per call, and the model is called again.
4. The loop ends when a round comes back without tool calls; the leaf's
   value is that round's text.
5. `disableAuto()` offers the tools but does **not** auto-execute the model's
   call — it records it, and the tree runs the chosen tool via a gated
   `Call(...)` (which accepts a function for the tool name, so a model-chosen
   name dispatches directly). `max(n[, errFn])` bounds the rounds — default
   `DEFAULT_MAX` (3) — and exhaustion throws `KnitError`. Positional
   `Hook(toolBefore()/toolAfter(), [when(cond)], tree)` trees run per call,
   seeded with `call`; mutation-by-return; throws abort (see the README's
   *Tool hooks*). For a fully explicit loop, see *Explicit loops* below.

Tool errors are fed back as tool messages (the model can recover), bounded
by `max()`.

## Record / `m.raw.prev[0]`

- `calls[]` — one entry per round (`{ round, messages, response }`).
- `toolCalls` / `toolResults` — union across rounds, in call order.
- `rounds` — number of model rounds; `thread` — the final message array.
- `content` — the final round's text (the leaf's value).

## Resume

Rounds log like the single-round path always did (`llm_call` per round with
the full thread in `messages`; `tool_result` per call), so `resume()`'s
existing scan — last `llm_call` for the paused prompt child + following
`tool_results` — reconstructs the paused round and its thread with no new
log schema. After a replayed round completes (including a tree tool resumed
structurally), the loop continues with fresh rounds when auto is on.

**Hooks run exactly once per actual execution**: replayed calls skip both
hooks; a call that paused inside a tree tool had its before-hook run
pre-pause (skipped on resume) and runs its after-hook when the tool finally
returns.

## Def-hash stability

The `auto` config is written onto a prompt child only when configured
(`disableAuto()`, `max()`, hooks) — a plain prompt keeps its exact JSON
shape, so `definitionId` / host session hashes do not churn on upgrade.

## Explicit loops (the recommended way to shape results)

The auto loop hides its thread: results go straight back to the model, and the
only knobs are the size cap (`runtime.maxToolResultChars`) and the
`runAfterTool` marker (below). When a tree wants to SEE or SHAPE each round —
fold in a condense step, emit progress, pause for a human, switch models — run
the loop itself:

```js
Tree(
  Tools(...TOOL_NAMES),
  // The thread lives in memory: seed once (the fn sees the current value, so a
  // rewind keeps it) and it survives a pause inside a tree tool.
  Memory('messages', (m, cur) => (Array.isArray(cur) ? cur : openMessages(m))),
  Prompt(disableAuto(), 'response', (m) => m.messages),   // model proposes; nothing runs
  // Capture the calls into a slot — the short, gate-friendly read (m.calls).
  // m.raw.branch.response.toolCalls works too (resume-safe; see the note below).
  Memory('calls', (m) => (m.raw?.branch?.response?.toolCalls ?? [])),
  Branch(when((m) => (m.calls ?? []).length > 0), Tree(
    Each('tool_calls', (m) => m.calls, Tree(
      Call((m) => m.item.name, (m) => parseArgs(m.item)),      // dynamic tool name
    )),
    Memory(update(), 'messages', (m, cur) => foldRound(cur, m)), // shape + append here
  )),
  Until((m) => (m.calls ?? []).length === 0, max(12)),
  Return((m) => m.branch.response),
)
```

- `disableAuto()` records the model's calls (`m.raw.branch.<prompt>.toolCalls`)
  and executes nothing; the tree dispatches them.
- `Call(tool, args)` accepts a **function** for `tool`, so a model-chosen name
  dispatches without a per-tool branch. (A tree tool still runs in place and a
  `Human()` inside it still pauses/resumes the whole run.)
- `Each('tool_calls', …)` handles a round with several calls; its results land
  at `m.branch.tool_calls`, in call order, so `foldRound` pairs them with the
  calls by index.
- `foldRound` builds the wire messages: one `assistant` message carrying
  `tool_calls`, then one `tool` message per call with the matching
  `tool_call_id`. Result shaping is an ordinary step here — no engine hook.

**Resume note.** Prompt raw records are reconstructed on resume from the events
already in the log: `m.raw.branch.<name>.toolCalls` / `.toolResults` / `.rounds`
(and the same via `m.raw.prev[0]`) survive a pause, so a `when()` gate may read
them directly. The rest are **live-only** — `reasoning`, and the whole-exchange
`calls` (per-round messages/responses) and `thread`; a tree that needs them
across a pause captures them in memory.

Capturing the calls into a slot right after the prompt (as above) is still the
recommended gate read: it is shorter (`m.calls`) and durable by construction —
a memory slot is rebuilt from its own logged write, independent of the record
reconstruction.

## `runAfterTool` — deprecated

`Prompt(name, fn, runAfterTool(fnOrName))` shapes each auto-loop result for the
model without changing what the tree reads (full results stay in
`record.toolResults` and the run log). It is **being phased out** in favour of
the explicit loop above, where shaping is a normal step and the rounds are
visible. The marker and its tests remain for existing trees — do not adopt it in
new ones.

## Known limits / open edges

- **Tools are scoped and enforced**: the prompt's `Tools()` list (per-prompt
  option or inherited) is the whole offer, and a call outside it is refused
  before anything executes — the refusal feeds back as a tool error. Scope
  `Tools()` to the subtree that needs it; wrap-up prompts should carry none.
- **Tools do not cross a tree-tool boundary** (chosen). A tree entered as a
  tool — a model-called tree or a `Call(...)` to a tree-backed tool — sees only
  its own `Tools()`; the invoker's tool list is not inherited. `Model()` rules
  still inherit (a callee may pick a model from its caller). A
  `From(...)`-attached subtree is a plain branch and *does* inherit tools, as
  explicit composition. Consequence: an app must declare the tools it needs.
  (`resolveInherited` stops at the frame `runTreeTool` marks as a boundary.)
- **A before-hook's arg rewrite is not preserved across a pause inside that
  same call**: the resumed call executes with the model's original args
  (the rewrite is not logged). After-hooks are unaffected.
- Container-level `disableAuto` does not exist (prompt-argument only);
  hooks do not fire for `.call()` leaves (no LLM); the thread is never
  truncated between rounds (bounded by `max()` rounds only); the model is
  resolved once per prompt invocation.
