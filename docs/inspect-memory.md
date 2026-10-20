# `inspect_memory` — a bounded view of a value held by handle

**Status:** shipped (2026-10-17) — `inspectMemoryTool()` in `src/inspect.mjs`,
exported from `grandma-kat`, merged into `runtime.tools` by the host.

## The problem

A tool result too big for context does not have to enter context: it crosses
trees as a `ref://<name>.<seq>` handle, and the engine resolves it at the
tree-tool boundary (`refs.mjs`). A live slot is likewise addressable by its
`m.<name>`. But both are **opaque**:

- a ref is a string the model can only forward — it cannot look inside to decide
  *which* tool to call next, or with what;
- a slot the model never read is not in its context at all.

So a model facing a 50-row list could only guess, or ask for the whole thing and
pay the tokens. `inspect_memory` is the third option: ask for a small, honest
view.

## What it does

The host wraps it into its tool registry (the same way as `runLogTools`):

```js
import { inspectMemoryTool } from 'grandma-kat';
const tools = { /* … */, inspect_memory: inspectMemoryTool({ sample: 5, maxChars: 2000 }) };
```

A call addresses a value one of three ways, resolves it, optionally walks
`path` into it, and shapes the result:

| arg | resolves against |
|---|---|
| `name` | a live slot through `ctx.view` (nearest binding in the scope chain) |
| `ref` | the run log through `ctx.readRef` (the same resolver as tree-tool args) |
| `name: "*"` / `list: true` | the scope inventory through `ctx.scopeInfo` |

Shaping keeps the return **valid JSON** and bounded:

- **array** → `{ type, length, rows, rowsShown, order, … }`, where `rows` is a
  random `sample` (default `DEFAULT_SAMPLE`, 5) or the `head`; whole rows are
  kept while they fit `maxChars` (default `DEFAULT_MAX_CHARS`, 2000), at least
  one always. `truncated` + a `note` appear when rows were dropped.
- **object** that fits → shown whole; oversized → its keys listed, values
  withheld.
- **string** → capped; **primitive** → `{ type, value }`.

The result echoes the handle it was read through as `ref`, and a live slot with
a write row is reported as its own `ref://<name>.<seq>`; either can be handed to
another tree tool for the whole value. A bad `name`/`ref` returns
`{ error }` (an error-shaped tool result), so the model recovers in-loop. The
tool is read-only: it never mutates memory or the log.

`seed` makes a random draw reproducible (tests and deterministic reruns).

## Why it is a host tool with engine capabilities

The tool is deliberately ordinary host code, but a host tool alone cannot reach
either store. The engine passes, on the tool `ctx`:

- `ctx.view` — the call-site memory view (already passed to every tool);
- `ctx.readRef(ref)` — resolve a handle against **this** run's log (guarded to
  the run id by `refs.mjs`);
- `ctx.scopeInfo()` — the slots visible from here (`scopeInventory` in
  `memory.mjs`: name, owning scope id, and the write `seq`), nearest binding
  wins, so the tool can mint a live slot's ref.

`src/refs.mjs` exports its `walk` for the shared path semantics.

### Host wiring

Register it like any host tool, with one caveat: it must receive the
engine's per-call `ctx` (`view`/`readRef`/`scopeInfo`). A host registry that
substitutes its own context for app tools — BOB's `ToolRegistry.dispatch` hands
app tools the app's secrets context — must special-case `inspect_memory` and
forward `ctx` (see `grandpa-bob-bot/src/tools/index.ts`). In BOB it is a
built-in definition, not a `tools.mjs` app tool. Offer it to a prompt by name
(`Tools('inspect_memory')`) and include it in the host's tool list; BOB adds it
to `TOOL_NAMES` so the trunk sees it.

## Gotchas

- A `ref` carries its own path; a call may add `path` to walk further.
- `ctx.scopeInfo()` reports the write `seq` per slot; a host **seed** has none,
  so its listing carries no `ref`.
- A ref only exists when the run has a readable log (`refsResolvable`); a
  logger-less run returns the run-log-unavailable error.
- The engine still caps the model's *view* of this tool's own result
  (`capToolResult`), so an `inspect_memory` result can itself be truncated and
  minted as a new ref.
- A handle's label must match the row's attested `content.refName`; a
  relabelled handle is rejected with the row's real name (see the README's
  *Handles attest their name*).

## Tests

`tests/inspect-memory.test.mjs` — unit (listing, name, `head`, `path`, seeded
sample, budget, error shapes) and engine integration (a live slot by name; a
ref read from a truncation note, resolved by `ctx.readRef`, with the full result
still in the log).
