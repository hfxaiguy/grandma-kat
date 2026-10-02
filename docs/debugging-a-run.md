# Debugging a run

Where the events go, what they mean, and how to find the cause of a tree that
misbehaves. Read this with a failing `run_id` in hand and the tree's `.md`
sketch open beside it.

## Where the log lives

Every event worth debugging is a row in SQLite — **checks failing, gates
skipping, gobacks rewinding, until passes, every scope write**. The default
store is `logs/grandma-kat.db`; the host can point it elsewhere, inject a
custom `{ log, close? }`, or turn it off with `logger: false`. `knit()` returns
the `run_id`.

Two console switches (no DB needed):

- `logLevel: 'info'` — LLM calls, tool calls, and flow events, live.
- `logLevel: 'debug'` — the above plus full prompts, reasoning, gate
  evaluations and scope inits.

```js
const { result, run_id } = await grandma.knit(tree, { ..., logLevel: 'debug' });
```

## The `calls` table

```sql
CREATE TABLE calls (
  run_id TEXT, definition_id TEXT, seq INTEGER PRIMARY KEY AUTOINCREMENT,
  branch_path TEXT, iteration INTEGER, scope_id INTEGER, kind TEXT, content TEXT
);
```

| Column | Meaning |
|---|---|
| `run_id` | one run; returned by `knit()` |
| `definition_id` | root name + structural hash — **which version** of the tree ran |
| `seq` | global execution order |
| `branch_path` | path from the root, e.g. `agent/draft#1` |
| `iteration` | loop pass number (1 on the first pass) |
| `scope_id` | the scope the event happened in (matches `scope_init`) |
| `kind` | the event kind (below) |
| `content` | JSON — the event's payload |

## Event kinds

| `kind` | `content` | Notes |
|---|---|---|
| `scope_init` | `{ scopeId, parentScopeId }` | the scope tree, in creation order |
| `gate` | `{ child, result: "skipped" }` | **only logged when a branch is SKIPPED** — a passing branch is silent |
| `check` | `{ child, pass, feedback? }` | `feedback` is what the retried prompt reads as `m.error` |
| `until` | `{ child, pass, feedback? }` | the loop's exit test each pass |
| `flow` | `{ type, from, target?/n?, used }` | `goto` · `goback` · `until-goto` · `until-goback` · `until-rewind` · `exhausted` |
| `return` | `{ child, value }` | a `Return(...)` that fired |
| `human` | `{ child, context }` | a pause |
| `record` | `{ child, childIndex, value, op }` | `op` is `set` · `memory` · `memoryUpdate`; `memoryUpdate` also carries `execScopeId` (which scope it wrote to) |
| `llm_call` | `{ child, round, model, messages, content, toolCalls, reasoning? }` | one model round |
| `llm_error` | `{ child, round, model, error, messages? }` | |
| `tool_call` / `tool_result` | `{ child, tool, args, result }` | |
| `tool_error` | `{ child, tool, args, error }` | |
| `emit` | `{ child, value }` | one emitted message |

**The single most useful fact:** a `gate` row means a branch **did not run**.
The absence of a `gate` row for a branch means its `when(...)` was truthy (or
it had none).

## Symptom → cause

| Symptom | Look for | Likely cause |
|---|---|---|
| A branch never ran | `gate { child: "<name>", result: "skipped" }` | its `when(cond)` was falsy. Fix the condition (or a missing upstream slot it reads). |
| `m.branch.X` is `undefined` / empty | no `record { child: "X" }` after the branch | the branch was gated, ran *after* the consumer, or **X is unnamed** (auto-named `${parent}#${k}` — name it if you reference it) |
| A child's `Memory(update(), …)` didn't reach the parent | `record { op: "memory", child: "<slot>" }` in the child, and no `memoryUpdate` | the child **re-declared** the slot (`Memory(name, fn)`) instead of updating it — the parent copy is now dead (shadowing). See `pitfalls.md`. |
| A loop ran to its `max` | `flow { type: "exhausted" }` with no `until { pass: true }` | the exit condition never became true — a step isn't making progress |
| A retry ignored the feedback | `check { pass: false }` not followed by an `llm_call` whose messages contain the feedback | the prompt doesn't fold in `m.error` |
| The model "ignored the format" | the last `llm_call.content` | the prompt never *forced* the format (see `examples/notation/README.md`'s boolean gotcha) |
| A tool call was refused | `tool_error`, or no `tool_call` for it | the tool was not offered to that prompt — `Tools(...)` scoping missed it |
| The wrong model ran | `llm_call.model` | `Model(...)` is **last-match-wins** up the execution path; a broader `Model(...)` above is being overridden — or a header `Model(...)` leaked where you didn't want it |
| Nothing at all after a pause | `human` with no later rows | the run is waiting for a human (resume it) |

## Recipes

```sql
-- the whole run, in order
SELECT seq, kind, branch_path, iteration,
       json_extract(content,'$.child') AS child, content
FROM calls WHERE run_id = :run ORDER BY seq;

-- branches that were SKIPPED (a gate that was false)
SELECT seq, branch_path, content FROM calls
WHERE run_id = :run AND kind = 'gate' ORDER BY seq;

-- every loop pass and how it ended
SELECT seq, iteration, json_extract(content,'$.type') AS flow,
       json_extract(content,'$.used') AS used
FROM calls WHERE run_id = :run AND kind IN ('flow','until') ORDER BY seq;

-- one slot's whole history (declare vs update, and which scope each wrote)
SELECT seq, json_extract(content,'$.op') AS op,
       json_extract(content,'$.execScopeId') AS wrote_scope, content
FROM calls
WHERE run_id = :run AND kind = 'record'
  AND json_extract(content,'$.child') = 'page_budget' ORDER BY seq;

-- the last thing the model said, and what it was asked
SELECT seq, json_extract(content,'$.child') AS child,
       json_extract(content,'$.content') AS out
FROM calls WHERE run_id = :run AND kind = 'llm_call' ORDER BY seq DESC LIMIT 1;

-- tool failures
SELECT seq, json_extract(content,'$.tool') AS tool,
       json_extract(content,'$.error') AS err
FROM calls WHERE run_id = :run AND kind = 'tool_error';
```

`json_extract` needs SQLite's JSON1 (standard in modern SQLite). If your host
stores logs elsewhere, the schema is the same — the columns above are all
you need.

## Dead outputs live here

When a `Check` fails and the flow rewinds, the retried prompt **overwrites**
the slot it produced; the discarded output is gone from memory. It is **not**
gone from the log — the `llm_call` and `record` rows remain. Likewise
`m.raw.branch.X` keeps the `{ content, reasoning, toolCalls, toolResults,
calls }` record even after `m.branch.X` is clean. When you can't explain why a
value changed, query the slot's history above rather than adding `console.log`
to the tree.

## See also

- [`values-flow.md`](values-flow.md) — `m.branch` / `m.prev` / `m.raw` and how
  values move.
- [`pitfalls.md`](pitfalls.md) — the causes above, each with a fix.
- [`../README.md`](../README.md) — "Logging: where dead outputs live".
