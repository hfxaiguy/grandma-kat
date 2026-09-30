# Auto tool-execution loop + tool hooks

Status: implemented (`src/knit.mjs` `execPrompt`, `src/tree.mjs` `.prompt()`,
`src/markers.mjs`). Tests: `tests/auto-tools.test.mjs` (the executable spec),
plus the single-round plumbing tests in `tests/runner.test.mjs`.

## What it does

A `.prompt()` with tools runs a **local conversation** by default:

1. The prompt's messages open a thread; round 1 calls the model.
2. Every tool call the model emits executes — the same resolution and call
   path as `.call()` (`resolveTool`: scoped registers first, runtime tools
   last; tree tools run in place; registers settle their `{ value, memory }`
   patches).
3. Results are appended to the thread as assistant `tool_calls` + one
   `tool` message per call, and the model is called again.
4. The loop ends when a round comes back without tool calls; the leaf's
   value is that round's text.
5. `disableAuto()` on the prompt stops after one round (results recorded,
   never fed back). `max(n[, errFn])` bounds the rounds — default
   `DEFAULT_MAX` (3) — and exhaustion throws `KnitError`. Hooks run per
   call: `toolHookBefore([when(cond)], fn)` / `toolHookAfter([when(cond)], fn)`,
   `fn(m, thread, tool_call)`, mutation-by-return, throws abort.

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

## Known limits / open edges

- **Tools are scoped and enforced**: the prompt's `.tools()` list (per-prompt
  option or inherited) is the whole offer, and a call outside it is refused
  before anything executes — the refusal feeds back as a tool error. Scope
  `.tools()` to the subtree that needs it; wrap-up prompts should carry none.
- **Rules inherit down the execution stack, including into tree-tool
  subtrees**: a callee tree's prompts also see the caller level's
  `.tools()`/`.model()` rules (pre-existing). Combined with text-recovery a
  sufficiently unlucky reply could re-enter a caller-offered tree tool; the
  loop bounds it with `max()`, but a call-boundary cut in `resolveInherited`
  (and its resume story) is future work.
- **A before-hook's arg rewrite is not preserved across a pause inside that
  same call**: the resumed call executes with the model's original args
  (the rewrite is not logged). After-hooks are unaffected.
- Container-level `disableAuto` does not exist (prompt-argument only);
  hooks do not fire for `.call()` leaves (no LLM); the thread is never
  truncated between rounds (bounded by `max()` rounds only); the model is
  resolved once per prompt invocation.
