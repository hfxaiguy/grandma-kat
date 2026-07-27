# Grandma KAT

**Grandma Knits Agent Trees.**

Yes, really. The name is absurd, and also just… accurate: you write a
*pattern*, hand it to grandma, and she knits it into a finished thing —
`grandma.knit(pattern)`. What comes off the needles is a tree of LLM steps:
prompts, tool calls, checks, and loops, all woven together with memory.

## What is this, really?

Grandma KAT is a tiny, zero-dependency JavaScript library for building LLM
workflows as **explicit trees** instead of open-ended agent loops.

You define the control flow — which prompts run, in what order, what gets
retried, when to loop, when to stop — as plain data built with a chained
builder API. A runner (`grandma.knit()`) validates the whole tree up front
and then executes it, calling the model only for the parts that actually
need a model.

The guiding bet: **the control flow should be yours, and the LLM should only
do the fuzzy parts.** Modern small models (1–30B params, running locally)
are surprisingly good at narrow, well-scoped questions — "is there an
address on this page?", "which of these links looks promising?", "yes or
no?" — and surprisingly bad at sustaining an autonomous multi-step agent
loop. Grandma KAT is built around that reality: you write the procedure,
the model fills in the judgment calls, and every judgment call is checked,
bounded, and logged.

```js
import grandma, { Tree, goback, max } from 'grandma-kat';

const pattern = Tree.name('draft-and-verify')
  .branch(Tree.name('draft').prompt(m => `Write one paragraph about ${m.task}.`))
  .branch(Tree.name('verify').prompt(m =>
    `Does this paragraph stay on topic? Answer "pass" or "fail".\n\n${m.branch.draft}`))
  .until(m => m.branch.verify?.trim() === 'pass', max(3));

const { result, memory, runId } = await grandma.knit(pattern, {
  models: {
    default: { baseURL: 'http://localhost:8080/v1', apiKey: 'no-key', model: 'LFM2.5-1.2B' },
  },
  memory: { task: 'the history of knitting' },
});
```

## Where it fits (vs. LangChain & friends)

The LLM tooling landscape roughly splits into three camps:

| Tool | Mental model | Who decides what happens next |
|---|---|---|
| **LangChain / LangGraph** | Big framework: chains, retrievers, agents, graph state machines, an integration for everything | You wire the graph; within agent nodes, often the model |
| **CrewAI / AutoGen** | Multi-agent role-play: autonomous "agents" converse and delegate | Mostly the models |
| **Grandma KAT** | A recipe: a fixed tree of small steps with checks and bounded loops | You — always. The model only answers the questions you ask it |

More concretely:

- **Use LangChain/LangGraph** if you want a large ecosystem of integrations,
  RAG plumbing, and prebuilt agent abstractions — and you're comfortable
  with the abstraction layers and dependency weight that come with it.
- **Use CrewAI/AutoGen** if you want emergent behavior from agents talking
  to each other and have frontier-model budget to burn.
- **Use Grandma KAT** if you *already know the procedure* for your task and
  want an LLM (especially a small/local one) to execute the unreliable
  parts of it reliably: granular steps, explicit retries, visible
  validation, and a complete audit log — with zero dependencies and no
  framework lock-in. The tree *is* the control flow; you can read it, diff
  it, log it, and test it without a live model.

It's also designed so that **LLMs are good at writing the trees
themselves**: the builder API is small and patterned, and it fails loudly at
build time on hallucinated methods, missing branches, or unknown tool
names — the mistakes an LLM author actually makes.

And if your alternative is "just hand-roll a `while` loop around
`fetch()`": that's a fine instinct, and Grandma KAT is roughly that — plus
scoped memory, validation, bounded retries, per-step models and tools,
SQLite logging, and mock-model testing, for one import and no dependencies.

## Status

**Alpha** (v0.1.0). Implemented and tested: builder, markers, runner,
memory scope chain, single-round tool calls, gates, checks/goback/until,
`.memory()`/`.memoryUpdate()`, `.return()`, `.map()`, validation, SQLite +
console logging.

Deferred (designed, not built): tool-call pause mode, escalation promotion,
YAML authoring layer, mid-run resume, `grandma.compile()`.

## Requirements & install

- **Node.js ≥ 22.5** (uses the built-in `node:sqlite`; there are no npm
  dependencies)
- ES modules only

```sh
npm install grandma-kat
```

If the package isn't on npm yet in your timeline, depend on it directly:

```json
{ "dependencies": { "grandma-kat": "git+https://github.com/<you>/grandma-knits.git" } }
```

## Quick start

A tree that asks a small model to judge a yes/no question, and retries with
feedback until the model actually answers in the required format:

```js
import grandma, { Tree, goback, max } from 'grandma-kat';

const pattern = Tree.name('judge')
  .prompt(m => `Is ${m.topic} a good first programming language? Answer ONLY "yes" or "no".`)
  .check(
    m => ['yes', 'no'].includes(m.prev[0].trim().toLowerCase())
      || 'Answer with ONLY the word "yes" or "no".',
    goback(1, max(3)),
  );

const { result } = await grandma.knit(pattern, {
  models: {
    default: { baseURL: 'http://localhost:8080/v1', apiKey: 'no-key', model: 'my-local-model' },
  },
  memory: { topic: 'Python' },
  logLevel: 'info',
});

console.log(result); // "yes" (or "no" — grandma doesn't judge your language choices)
```

Run it against any OpenAI-compatible endpoint (llama.cpp, vLLM, Ollama, HF
router, OpenAI itself). Point `baseURL` at it, set `model`, done.

## Core concepts

### Trees are containers; prompts are always children

A named tree is a pure container with config. All *doing* lives in its
children, which run **sequentially, in declared order**. A container's
exported value is its last executed child's result.

```js
Tree.name('draft').prompt(m => `Write about ${m.task}`)

// draft        ← container (named tree)
//  └─ draft#1  ← anonymous prompt child (auto-named at build time)
```

Anonymous children get build-time names like `draft#1` (`#` is reserved in
your own names). If you reference a child's output, give it an explicit
name — `.prompt('outline', m => ...)` — positional auto-names shift when
you insert siblings.

**Doing methods accumulate; config methods select.** `.prompt(a).prompt(b)`
runs both. `.model('x').model('y')` resolves to `'y'` (last match wins).

### The children (leaves)

| Method | Kind | Produces |
|---|---|---|
| `.branch(tree)` | nested container | the subtree's exported value |
| `.prompt(fn)` | LLM call | the model's text |
| `.call(tool, argsFn)` | direct tool call, no LLM | the tool's result |
| `.check(fn, goback(n, max(k)))` | validation | nothing on pass; sets `m.error` on fail |
| `.memory(name, fn)` | memory write | the written value (also stored under `name`) |
| `.memoryUpdate(name, fn)` | memory update (slot must already exist) | the updated value |
| `.return(fn)` | early exit | stops the tree if `fn` returns non-null |
| `.map(name, arrayFn, tree)` | run a subtree per element | array of results, stored under `name` |

All of them accept an optional `when(cond)` gate as the first argument:

```js
.branch(when(m => m.branch.check_address === 'no'), tryFindTree)
```

### Memory: a scope chain

Every branch owns a memory linked to its parent's. **Reads resolve upward**
(nearest binding wins); **writes flow up one level** (a completed child's
result lands in its parent's slots under the child's name). Siblings can't
see each other's internals — only what completed branches exported.

Inside any prompt/gate/check function, the memory view `m` gives you:

| Access | Meaning |
|---|---|
| `m.branch.X` | exported **value** of branch/step `X`, resolved up the chain |
| `m.prev` | completed siblings' outputs, **most-recent-first** (positional) |
| `m.raw.branch.X` / `m.raw.prev[i]` | the full **record**: `{ content, reasoning, toolCalls, toolResults, calls }` |
| `m.error` | feedback from the last failed check (cleared on pass) |
| `m.item` | current element inside a `.map()` subtree |
| `m.<anything>` | any other name resolves up the scope chain (root inputs, ancestor slots) |

Root inputs come from `memory:` in the runtime. Sessions are just the root
scope threaded through runs: `knit()` returns `memory`; feed it back into
the next run.

### Flow control: `.check()` + `goback()` + `max()`

Validation is a visible node in the tree, and every backward jump is
**relative and bounded** — unbounded loops are unconstructible.

```js
.check(
  m => m.prev[0].length <= 5 || 'Too long. One word only.',
  goback(1, max(3, m => `Judge never answered validly: ${m.error}`)),
)
```

- Check returns `true` → pass, no output. Returns a string → fail; the
  string lands in `m.error` so the retried prompt can incorporate it
  (`${m.error ?? ''}`).
- `goback(1)` rewinds to the child just before the check; `m.prev` rewinds
  with it (named slots persist until overwritten).
- `max(3)` = 1 initial run + 3 retries, then a loud `KnitError`. The
  optional `errFn` controls the failure message.
- `.until(cond, max(k))` is the same primitive at container scope: re-run
  all children until `cond` passes. Omit `max()` and a documented default
  cap (3) applies.

### Models per step

`.model(name)` on any tree, inherited down: step → parent → root → runtime
default. Names reference the runtime's `models` map, so "different
endpoint" and "same endpoint, different model" are one concept:

```js
const pattern = Tree.name('agent')
  .model('cheap')                                              // default for this tree
  .branch(Tree.name('summarize').model('strong').prompt(...))  // override per branch
```

```js
await grandma.knit(pattern, {
  models: {
    cheap:  { baseURL: 'http://localhost:8080/v1', apiKey: 'no-key', model: 'LFM2.5-1.2B' },
    strong: { baseURL: 'http://localhost:8080/v1', apiKey: 'no-key', model: 'Qwen3-32B' },
  },
});
```

### Tools

Tools live in a **runtime-provided registry** — Grandma KAT stays decoupled
from MCP or any specific tool source:

```js
const tools = {
  navigate: {
    description: 'Open a URL in the browser tab.',
    parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    execute: async (args) => { /* ... */ },
  },
};
```

- `.tools('navigate', 'click')` on a container whitelists tools for its
  prompt children (inherited down the tree). Opt out per prompt:
  `.prompt(fn, { tools: [] })`. Default: no tools.
- When a prompt's model responds with tool calls, they execute **once** —
  no hidden internal loop. The text comes back as the value; calls and
  results are at `m.raw.prev[0].toolCalls` / `.toolResults`. Retries are
  your tree's job (`.check()` + `goback()`), visible and debuggable.
- `.call('navigate', m => ({ url: m.branch.best }))` calls a tool directly,
  no LLM involved.

### Validation up front

`knit()` sees the whole tree before the first LLM call and fails loudly:
unresolvable models, `.needs()` with no producer anywhere, unknown tool
names (all typos listed in one error), zero-children trees, `#` in names,
bare functions in condition slots ("did you mean `when()`?"). Soft
warnings cover duplicate child names, shadowed config rules, and
`.needs()` on auto-named slots.

`.needs('draft', 'navigate')` declares expected memory inputs: hard build
error if nothing in the tree (or injected memory) produces them, loud
runtime error if they don't resolve when the step runs.

### Reuse

`Tree.name(id)` registers into a global registry. Builder methods return
new definitions (copy-on-write), so a tree dropped into multiple parents
can never be mutated through one reference:

```js
const navigate = Tree.name('navigate').prompt(...);
const a = Tree.name('a').branch(navigate);
const b = Tree.name('b').branch(Tree.from('navigate'));
```

## Runtime options

```js
await grandma.knit(pattern, {
  models:   { /* name → { baseURL, apiKey, model } or { model, handler } */ },
  tools:    { /* name → { description, parameters, execute } */ },
  memory:   { /* initial root scope: plain JSON values */ },
  logger:   true,          // SQLite at ./logs/grandma-kat.db
            // 'path/to.db' | { path } | { log, close } | false (off, default)
  logLevel: 'none',        // 'none' (default) | 'info' | 'debug' (console)
});
// → { result, memory, runId }
```

Model entries are either an OpenAI-compatible endpoint
(`{ baseURL, apiKey, model }`) or a mock (`{ model, handler }`) — see
testing below. The endpoint flavor sends `temperature: 0` with a 120s
timeout, handles thinking-model `<think>` tag leakage, and can even rescue
tool calls that small models emit as plain text.

## Logging: where dead outputs live

Every event worth debugging is a row in SQLite — including flow control:
checks failing, gates skipping, gobacks rewinding, until-loop passes.

```sql
SELECT seq, branch_path, kind, content
FROM calls
WHERE run_id = '2026-07-27_10-00-00'
ORDER BY seq;
```

| Column | Contents |
|---|---|
| `run_id` | timestamp-based run identifier (also returned from `knit()`) |
| `definition_id` | root name + structural hash — which *version* ran |
| `seq` | global execution order |
| `branch_path` | path from root, e.g. `agent/draft#1` |
| `iteration` | loop pass number |
| `kind` | `llm_call` · `tool_call` · `tool_result` · `check` · `gate` · `flow` · `memory` · … |
| `content` | JSON — messages, response, tool args/results, check feedback, goback target |

Since rewound retries drop outputs from memory, **the log is where dead
outputs live.** `logLevel: 'info'` gives you a live console trace;
`'debug'` adds full prompts, reasoning, and gate evaluations.

## Testing without a live model

A model entry with a `handler` is a mock — script the responses, assert on
the tree's behavior. Tests exercise structure (gating, retries,
exhaustion), not the LLM's judgment:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import grandma from 'grandma-kat';

test('retries until the answer is valid', async () => {
  let calls = 0;
  const handler = async () => ({ content: ++calls === 1 ? 'maybe??' : 'yes' });

  const { result } = await grandma.knit(pattern, {
    models: { default: { model: 'mock', handler } },
    tools: {},
    logger: false,
  });

  assert.equal(result, 'yes');
  assert.equal(calls, 2); // failed the check once, retried with feedback
});
```

This repo's own suite runs this way: `npm test` (61 tests, no network).

## Examples in this repo

- **`examples/find-address/`** — the flagship: a tree that finds a business
  address on a website. Check the page, scan for clickables, ask the model
  which is promising, click, repeat — with tried-element tracking in memory,
  per-step tool whitelists, and bounded loops throughout. Heavily commented
  for newcomers.
- `examples/find-listings/`, `examples/find-pagination/` — more web-task
  patterns, backed by the `browser-mcp` tool server.

## Not (yet) in the box

- Tool-call pause mode (pause the run around side-effecting tools)
- Escalation promotion (a failed retry escalating to a bigger rewind)
- YAML authoring layer
- Mid-run resume (runs are atomic; the log tells you how far a dead run got)
- `grandma.compile()` (hand a compiled subtree to another system as a tool)

## License

See [LISENCE.md](LISENCE.md). (The filename typo is grandma's. She knitted
it, we're not unraveling it.)
