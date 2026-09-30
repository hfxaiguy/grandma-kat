# Grandma KAT

**Grandma Knits Agent Trees** ("Grandma KAT" for short) — LLM/Threads tools:
an element-tree library for composing LLM execution units ("Trees") with
nesting, memory, and reuse.

**Status: alpha implemented** (v0.1.0). The element surface, markers, runner,
memory, the agentic tool loop with hooks, validation, pause/resume, and
SQLite logging are implemented in `src/` with mock-model tests in `tests/`
(`npm test`). Deferred items remain: crash recovery (mid-run resume),
tool-call pause mode, escalation promotion, YAML authoring layer,
`grandma.compile()`.

Implementation deviations from this doc:

- **SQLite via `node:sqlite`** (built into Node ≥22.5) instead of
  `better-sqlite3` — native bindings are blocked in this environment; zero
  dependencies instead. Requires Node ≥22.5.
- **Autonaming counts all children** — `k` = 1-based position among all of
  a parent's children (uniform, collision-free), not just prompt children.
- **Elements only** — the chain form (`.name()`, `.prompt()`, …) was
  removed; `Tree(...)` with elements is the only authoring surface.

## Packaging

- Standalone JS subpackage: ES modules, own `package.json`, own
  `node_modules/` — same pattern as `browser-mcp/`.
- Package name: `grandma-kat` (full name: "Grandma Knits Agent Trees").

## Core Design: the Tree factory

- The basic unit is a `Tree`; trees contain branches (subtrees).
- `Tree(...)` is a **factory**: elements accumulate into a **definition**
  (plain data), executed by the runner `grandma.knit()` (see "Factory output"
  below).

**Vocabulary (naming).** **Tree** (the factory), **branch** (a named subtree
via `Branch(...)` — also the memory key for outputs: `m.branch.X`,
`branch_path`), **leaf** (anonymous child — prompt/tool/check), **pattern**
(a built definition variable). Name definitions **`pattern`** —
`const pattern = Tree(name('x'), ...); grandma.knit(pattern)` reads as a
sentence and keeps LLM authors consistent.

```js
Tree(
  name('tree_id'),                                  // register into a global registry for reuse
  Branch(Tree(name('navigate'), Prompt(...))),      // attach a sub-branch
  From('navigate', memory(m => ({ ...m }))),        // or attach it by registered name, seeding its scope
  Prompt(memory => `current memory: ${memory.branch.navigate}`),
)
```

- `name(id)` — names the tree into a global registry so it can be reused
- `Branch(child)` — attaches a sub-branch (composition/nesting); gated with
  `Branch(when(cond), child)`. `child` is a def, or a bare element — shorthand
  for `Tree(element)`: `Branch(From('x'))`, `Branch(Prompt(...))`.
- `From('name', [memory(fn)])` — attaches a **registered** tree as if it were
  a branch (`From('x')` ≡ `Branch(Tree.from('x'))`). `memory(fn)` seeds the
  import's own scope at entry: `fn(m)` returns the slots to write
  (`memory(m => ({ input: m.item }))`, or `memory(m => ({ ...m }))` to
  snapshot the chain). The seed is an entry-time pulse, re-applied on resume;
  the static `Needs(...)` check skips seeded attaches (keys are dynamic).
  `Tree.from(id)` still works but is deprecated in its favor.
- `Prompt(fn)` — defines the LLM prompt; `fn` receives memory and returns
  the prompt string
- Memory is keyed by branch name (`m.branch.navigate`) — a parent tree
  reads what its branches produced (see Memory Model below)

### API style: branches as arguments (chosen)

```js
Tree(name('a'), Branch(Tree(name('b'), Prompt(...))))
```

Rejected alternative — branches as chained blocks:

```js
Tree.name('a').branch.runif(cond).prompt().branch ...
```

Reasons:

- Nesting is unambiguous — parentheses make the hierarchy explicit.
- Reuse is natural — assign a tree to a variable, drop it into multiple
  parents.
- The chained-block style can't distinguish sibling vs nested branches
  without an `.end()` / `.back()` mechanism, which gets ugly.

### Conditions (superseded)

An early sketch put `.runif(cond)` on the tree itself so the condition
would travel with reuse. Superseded: gates live at the attachment site only
(`Branch(when(cond), child)`); tree-owned/intrinsic gating is expressed
with a `Check(...)` child inside the tree (see Conditional rules, gotcha #3).

### Factory output: a definition, executed by a runner (chosen)

`Tree(...)` does **not** produce an executable function. It accumulates a
**definition** — plain data: name, rule lists, children. A separate **runner**
executes it with an injected runtime:

```js
const pattern = Tree(
  name('draft-and-verify'),
  Branch(Tree(name('draft'), Prompt(m => `Write about ${m.task}`))),
  Branch(Tree(name('verify'), Needs('draft'), Prompt(m => `Check: ${m.branch.draft}`))),
  Until(m => m.branch.verify === 'pass', max(3)),
);

// pattern is just data — an AST of rule lists and children

const result = await grandma.knit(pattern, {
  provider: 'local',
  tools: toolRegistry,
});
```

Why not the alternatives:

- **Callable tree** (the built tree is itself the executable function):
  aliasing traps if elements mutate-and-return a shared object (attach a
  tree to two parents, add an element via one reference, both silently
  change); magic if every element returns a new function-object. Validation
  gets smeared across the construction instead of one checkpoint.
- **`.build()` finalizer**: splits definition from execution but leaves the
  runtime-injection question unanswered — everyone would wrap the built
  function in a runner anyway.

Why the runner wins:

- **One loud validation checkpoint** — `knit()` sees the whole tree before
  the first LLM call: unresolved models, `Needs(...)` with no producer,
  shadowed rules, unknown tool names, registers used before their point.
- **Explicit runtime injection** — same tree runs against different
  providers/tool registries (mock runtimes for testing).
- **Definitions are inspectable** — a tree of data can be logged, diffed,
  pretty-printed, serialized, or generated by other tools (echoes the YAML
  escape hatch).
- **Observability** — the runner interprets rules instead of opaque
  closures, so it can log "rule 'retry case' matched → prompt variant 2,
  model override applied."

Implementation note: applying elements is **copy-on-write** (cheap
spread-copy), so sharing a tree across parents is bulletproof.

Escape hatch: `grandma.compile(tree, runtime)` → plain async function, for
handing a compiled subtree to an external system as a tool.

## Trees Are Containers: a prompt is always a child (chosen)

`Prompt(...)` never makes a tree *be* a prompt — it always **appends an
anonymous child**. A named tree is a pure container with config (`name`,
`Model`, `Tools`, `Needs`, `Until`, gates); all *doing* lives in
children. Leaves are anonymous invocation nodes: prompt-leaves (from
`Prompt(...)`), tool-leaves (from `Call(...)`), check-leaves (from
`Check(...)`, which produce no output on pass), memory-leaves (from
`Memory(...)`, which write to a named slot and produce `m.prev` output),
return-leaves (from `Return(...)`, which can stop tree execution early).
Internal nodes are named containers.

```js
Tree(name('draft'), Prompt(m => `Write about ${m.task}`))

// draft        ← container (named tree)
//  └─ draft#1  ← anonymous prompt child (leaf)
```

**Export rule: a container's value = its last executed child's result.** So
`m.branch.draft` yields the prompt's output even though `draft` is a
container — the extra tree level is invisible from outside.

**Execution order** (resolves that open question): children run
sequentially in declared order, `Branch(...)` and `Prompt(...)` mixed freely.
Gates re-evaluate lazily whenever the child is reached (including each loop
iteration). There is no "parent's own prompt" to order against children —
only children exist. A named tree with zero children is a build error.

**Two Prompts are a sequence.** `Prompt(a), Prompt(b)` runs both, in
declared order (accumulative, like `Branch(...)`) — NOT last-match-wins. Rule
of thumb: *doing* elements (`Branch`, `From`, `Prompt`, `Call`, `Check`,
`Memory`, `Return`) accumulate; *config* rules (`Model`, `Tools`, `Until`)
select. Prompt variants are expressed as gated children:

```js
Prompt('draft',  when(m => !m.branch.verify), m => `Write the thing`)
Prompt('revise', when(m => m.branch.verify),  m => `Revise: ${m.branch.verify}`)
```

Each variant gets its own memory slot (`m.branch.draft` AND `m.branch.revise`
both exist) — richer for verification and logging.

Rejected alternative — *leaf special case* ("one prompt = the tree itself;
multiple prompts = children"): the node's structure silently changes when
you add a second prompt — a local edit with nonlocal effects (auto-names
shift, memory layout shifts, logs shift). Bad for LLM authors.

### Autonaming (chosen)

Anonymous prompt children receive build-time names: `${parentName}#${k}`
(`k` = 1-based position among the parent's prompt children).

- `#` is **reserved** — illegal in explicit branch names. Auto-names can never
  collide with or shadow author names, and logs visually mark them.
- Assigned at **build time**: a gated-out prompt keeps its number; loop
  iterations reuse the same slot (overwrite semantics); reused definitions
  yield identical auto-names under different parents (safe — memory is
  tree-scoped).
- Positional fragility is a feature: inserting a prompt renumbers later
  ones. Contract: **"if you reference it, you name it."**
  `Needs('parent#2')` (or reading `m.branch['parent#2']`) → build-time
  warning: give that prompt an explicit name.

### `m.prev`: positional access to previous outputs (chosen)

`m.prev` is an array of completed siblings' outputs, **most-recent-first**:
`m.prev[0]` = the sibling that completed immediately before me, `m.prev[1]`
the one before that, etc.

```js
Tree(
  name('pipeline'),
  Prompt(m => `Outline: ${m.task}`),                    // m.prev = []
  Prompt(m => `Draft from: ${m.prev[0]}`),              // prev[0] = outline
  Prompt(m => `Compare ${m.prev[0]} to ${m.prev[1]}`),  // prev[0] = draft, prev[1] = outline
)
```

- Includes all sibling kinds (prompts, branches, tool calls).
- **Dense and execution-relative**: gated-out siblings occupy no position.
  Positions are not declaration-relative — if you care *which* branch produced
  something, use a name.
- Two complementary addressings: `m.prev` positional, `m.branch.X` named.

**Loops: rewind (chosen).** `goback()` / `Until(...)` rewind `m.prev` to the
jump point — `prev` is the log of the current execution path, not the full
history — keeping positional indices stable across retries. See Validation
and Flow Control.

## Validation and Flow Control: `Check(...)` + `goback()` (chosen)

Validation is a visible node in the tree — an anonymous child, not a hidden
option. Flow control is a **relative, bounded** jump within the current
container's children, not an arbitrary goto.

```js
Tree(
  name('agent'),
  Tools('navigate', 'click'),
  Prompt(m => `Define success conditions for: ${m.task}`),
  Prompt(m => `Attempt: ${m.prev[0]}`),
  Prompt(m => [
    { role: 'user', content: `Conditions: ${m.prev[1]}` },
    { role: 'user', content: `Thinking: ${m.raw.prev[0].reasoning}` },
    { role: 'user', content: `Tool results: ${m.raw.prev[0].toolResults}` },
    { role: 'user', content: `Met? ${m.error ?? 'Answer ONLY "yes" or "no".'}` },
  ]),
  Check(
    m => {
      const a = m.prev[0].trim().toLowerCase();
      if (a !== 'yes' && a !== 'no') return 'Answer with ONLY the word "yes" or "no".';
      if (m.prev[0].length > 5) return 'Too long. One word only.';
      return true;
    },
    goback(1, max(3, m => `Judge never answered validly: ${m.error}`)),
  ),
  Until(m => m.prev[0].trim().toLowerCase() === 'yes', max(3)),
)
```

**`Check(fn, flow)`** — an anonymous child (accumulative, auto-named like
prompts). `fn` receives full memory and returns:

- `true` → pass. A passing check produces **no output** — invisible in
  `m.prev`.
- a string → fail; the string is the feedback, placed in **`m.error`**.
- `false` → fail with generic feedback.

**`goback(n, max(...))`** — rewind to `n` children before the check (the
check itself is not counted). `goback(1)` retries the immediately preceding
child; `goback(2)` re-runs the two previous children. Both `goback()` and
`max()` are exported marker factories like `when()`.

**`max(count, errFn?)`** — bounds a backward edge (an exported marker, not
an options bag). `count` = max backward jumps (so `max(3)` = 1 initial run
+ 3 retries); counters are per-edge and reset when the container is re-run
by an outer loop. Exhaustion **fails loudly** — the `errFn` only controls
*what the parent sees*, not whether it fails:

- `max(3)` bare → framework default failure message (names the check, the
  count, the last feedback).
- `max(3, m => \`...: ${m.error}\`)` → authored message. `m` is the
  container's memory at exhaustion: `m.error` holds the last check
  feedback, `m.prev` the current path — genuinely diagnostic messages.
- Omitted entirely → documented framework default cap (the "no unbounded
  loops" rule), overridable per-edge.

### Escalation: `errFn` returning a flow marker (deferred)

`errFn` may return a *flow marker* instead of a string: string = fail with
message; flow = escalate to a bigger rewind. Example — a research flow
where a bad summary is usually the *search*'s fault, not the summary
prompt's:

```js
Tree(
  name('research'),
  Tools('search', 'fetch'),
  Prompt(m => `Plan search queries for: ${m.task}. ${m.error ?? ''}`),     // child 1: plan
  Prompt(m => `Search using: ${m.prev[0]}. ${m.error ?? ''}`),             // child 2: search
  Prompt(m => `Summarize: ${m.prev[0]}. ${m.error ?? ''}`),                // child 3: summarize
  Check(
    m => isGoodEnough(m.prev[0]) || 'Summary too thin — needs more specific facts.',
    goback(1, max(2, m => goback(3, max(2)))),
  ),
)
```

Reading: *retry the summary twice; if it still fails, the problem is
upstream — rewind all three children and redo the research, twice at most.*

Trace:

1. plan → search → summarize → check fails: `m.error` set, `goback(1)`
   re-runs the summarize prompt (it sees the feedback).
2. Summarize v2 → check fails again: `goback(1)`'s `max(2)` budget
   exhausted → errFn returns a flow marker → runner executes `goback(3)`:
   rewind past summarize, search, and plan.
3. Second full pass: `m.error` still holds the check feedback, so the plan
   prompt renders "Plan search queries for X. Summary too thin — ..." and
   plans *different* queries. The inner check edge's counter resets for the
   new pass.
4. Repeat → the escalation edge's own `max(2)` exhausts → framework
   default failure.

Mechanics:

- **String vs marker distinguishes outcomes** — one signature, two
  behaviors; the parser rejects anything else at build time.
- **`m.error` bridges the escalation** — the check already set it on the
  final failure, so re-run children learn *why* via the same
  `${m.error ?? ''}` channel. No special escalation plumbing.
- **Nested bounds stay bounded** — local retry has its budget, the
  escalation its own; unbounded loops are unconstructible.
- **Counter resets** — per-edge counters reset when children re-run, so
  the check's local budget is fresh on each escalated pass.
- **Data-driven escalation** — errFn receives memory:
  `max(2, m => m.error.includes('thin') ? goback(3) : goback(2))`, or
  choose fail-vs-escalate:
  `m => m.attempts > 2 ? \`Giving up: ${m.error}\` : goback(3)`.

Status: deferred — adds "errFn return type is a union" to the mental model;
promote when a real case demands it.

**`Until(cond, max(...))` is sugar** for an implicit check at the end of
the container with `goback(<all children>, max(...))` — same primitive, two
scopes. This resolves the loop-construct question: relative bounded jumps
cover the realistic cases; arbitrary named `goto()` remains deferred.

### Rewind semantics

`goback()` (and `Until(...)`) **rewind `m.prev`** to the jump point: entries
produced by the jumped-over children are dropped. **`m.prev` is the log of
the current execution path, not the full history** — positional indices
stay stable across retries, which the concise authoring style depends on.

- Named slots (`m.branch.X`) are NOT rewound — they persist until a re-run
  overwrites them (natural overwrite semantics).
- **`m.error`** carries check feedback: set by a failed check, cleared when
  a check passes. Control-flow artifacts never appear in `m.prev`; prompts
  incorporate feedback via `${m.error ?? '...'}`.
- Dropped/dead outputs remain available in logs and in the record view
  (`m.raw`).

### `Memory(...)`: imperative memory writes (chosen)

`Memory(name, fn)` is a leaf child that writes a value to a named memory
slot. It is **side-effect only** — it produces no `m.prev` output (like a
passing `Check(...)`). You read the value by name (`m.branch.X`), not
positionally.

```js
Memory('tried', (m, cur) => [...(cur ?? []), m.prev[0]])
```

**Signature:** `Memory(name, fn)` or `Memory(when(cond), name, fn)` — the
`when()` may sit anywhere among the arguments. `fn(memory, currentValue)`
receives the full memory view and the slot's current value (or `undefined`
on first write). The return value is stored under `name` in the parent's
memory.

**Why it exists:** some state is derived, not produced by an LLM or tool.
Tracking a list of tried elements across loop iterations, incrementing a
counter, caching a computed value — these are pure memory operations that
don't need a prompt or tool call. `Memory(...)` replaces the hack of using
`Call('exec_js', ...)` to manipulate a side-channel.

**Scoping:** `Memory(...)` writes to the scope of the tree it belongs to. If
you need a value to survive a branch boundary (persist across loop
iterations), place `Memory(...)` at the level where it needs to live — not
inside the branch that produces the data you're reading. Read from
`m.raw.branch.X` to access a child branch's record view.

```js
Tree(
  name('loop'),
  Prompt(m => 'do something'),
  Check(m => ..., goback(1, max(3))),
  Memory('history', (m, cur) => [...(cur ?? []), m.prev[0]]),
  // 'history' accumulates across Until(...) iterations
  Until(m => done, max(5)),
)
```

**`m.prev` behavior:** `Memory(...)` produces `m.prev` output — its written
value appears in `m.prev` like a prompt's output. The sibling after it sees
`m.prev[0]` as the memory value. This makes `Memory(...)` usable as the final
step in an `Each(...)` subtree, where the collected value is the memory output.

**Updates.** `Memory(update(), name, fn)` updates an existing slot instead
of initializing one; the slot must already exist in the scope chain (declare
it with `Memory(...)` first or inject it via runtime memory), and the update
is written back into the scope that owns it — which may be an ancestor.

**Known false positive (note):** `Memory('x', fn)` immediately followed by
`Memory(update(), 'x', fn)` (same slot name, seed-then-append) trips the
"duplicate child name 'x' — the second overwrites the first's memory slot"
validation warning. That pairing is an intentional, supported idiom — the
duplicate-name check can't tell it apart from a real collision. Potential
fix (deferred): when the duplicate pair is a `Memory(...)` directly followed
by a `Memory(update(), ...)` of the same name, suppress the warning. Tracked
in `src/knit.mjs` next to `validateTree`.

### `Return(...)`: early exit (chosen)

`Return(fn)` is a leaf child that can stop tree execution early. If `fn`
returns a value, remaining children are skipped and the tree exports that
value. If `fn` returns `undefined` or `null`, the tree continues normally.

```js
Return(m => 'done')                           // always returns
Return(when(m => m.branch.rated.length === 0), m => 'no candidates')  // conditional
```

**Signature:** `Return(fn)` or `Return(when(cond), fn)`.

**Semantics:**
- `fn(memory)` is called with the full memory view
- If the return value is not `undefined`/`null`: the value is pushed to
  `m.prev`, recorded, and the tree stops — remaining children are skipped
- If the return value is `undefined`/`null`: the tree continues to the next
  child (the return is a no-op)
- `Return(...)` is anonymous (auto-named like prompts)
- Does NOT write to a named slot (use `Memory(...)` for that)

**Use case:** conditional early exit — if a preliminary check determines
there's nothing to do, stop the tree instead of running remaining steps.

```js
Tree(
  name('pick_action'),
  Prompt(m => `Pick an element:\n${m.branch.format_clickables}`),
  Return(m => {
    const text = m.prev[0].trim().toLowerCase();
    if (text.includes('no candidates')) return 'no candidates';
    // not a return — tree continues
  }),
  Check(m => { ... }),
)
```

**`m.prev` behavior:** when `Return(...)` fires, its value appears in
`m.prev` and the tree's exported value is the return value. When it doesn't
fire (returns `undefined`), it occupies no position in `m.prev`.

### `Each(...)`: per-element subtree execution (chosen)

`Each(name, arrayFn, tree)` runs a subtree once per element of an array,
sequentially. Each invocation gets `m.item` injected (the raw array element).
Results are collected into an array in the parent scope under `name`.

```js
Each('ratings', m => m.branch.clickables,
  Tree(
    name('rate'),
    Prompt(m => `Rate: ${m.item.text}\nlikely/unlikely`),
    Check(m => { ... }, goback(1, max(2))),
  ))
// m.branch.ratings = ['likely', 'unlikely', 'likely', ...]
```

**Signature:** `Each(name, arrayFn, tree)` or `Each(when(cond), name, arrayFn, tree)`.
`tree` is a def or a bare element (shorthand for `Tree(element)`:
`Each('rows', m => m.rows, From('upsert_row'))`).

**Semantics:**
- `arrayFn(memory)` returns the array to iterate over (read from memory)
- Each invocation creates a child scope with `m.item` set to the current element
- The subtree runs fully (all children, checks, etc.) per element
- Results collected into an array → stored in parent scope under `name`
- Empty array → no invocations, `m.branch.name = []`
- Sequential execution (one element at a time)
- Supports `when()` gates

**Use cases:**
- Rating/scoring elements individually (one LLM call per element)
- Filtering candidates by running a check per element
- Transforming array elements through a subtree pipeline

**Combined with `Memory(...)` and `Return(...)`:**

```js
Each('rated', m => m.branch.items,
  Tree(
    name('rate'),
    Prompt(m => `Rate: ${m.item}\nlikely/unlikely`),
    Check(m => { ... }, goback(1, max(2))),
    Memory('score', m => ({ element: m.item, rating: m.prev[0] })),
  ))
// m.branch.rated = [{ element: ..., rating: 'likely' }, ...]

Memory('filtered', m =>
  (m.branch.rated ?? []).filter(r => r.rating === 'likely'))
```

### Trees as tools: dynamic tree execution (chosen)

A runtime tool entry may declare `tree` instead of `execute`:

```js
tools: {
  'caller-list': { description: '…', parameters: {…}, tree: 'caller-list' },
}
```

**Why:** the model (and `Call(...)`) invoke trees exactly like tools — no
new element, no model-facing distinction between a function tool and a
tree. An earlier `.dispatch(selectFn)` leaf with a `pick_tree` pseudo-tool
was rejected: it forced authors to dig the selection out of `toolResults`
and made the model call a tool that was not a tool.

**Semantics** (chosen: *call*, not handoff — "as if the subtree were
included from the beginning"):
- Resolution: `runtime.loadTree(name)` (host hook — may load from disk) →
  global registry → `KnitError`. Resolved defs are registered under their
  name so resume can find them; `resume()` resolves registry-first with the
  `loadTree` fallback after a restart.
- Execution: child scope seeded with the call args as slots (satisfying
  `Needs(...)`), `execTree` runs it like a static branch. The exported value
  is the tool result. One run / log / continuation; caller state survives.
- A `Human(...)` inside a model-called tree pauses the whole run. On resume
  the calling prompt round is **replayed from the logged `llm_call` +
  `tool_result` events** — the model is not called again and completed
  sibling tool calls are not re-executed. The paused call index is derived
  from the count of logged results; no checkpoint format change.
- `PauseSignal` passes through the prompt tool loop untouched; subtree
  `KnitError`s become `isError` tool results so the caller can recover.

**Limitations:** selectors aside, a subtree edited mid-pause can shift shape
without invalidating the root definition hash; self-recursive tree tools are
legal but unguarded (loop `max()` still bounds rounds).

## Memory Model: Scope Chain (chosen)

**Memory is a scope chain.** Every branch owns a memory — a set of name →
value bindings. Memories form a tree mirroring the branch tree: each memory
is linked to its parent's memory.

**Reads resolve upward.** When a branch asks for a name, the engine checks
its own memory first; if absent, it asks the parent, then the grandparent,
up to the root. **The nearest binding wins** — same as variable scoping in
nested functions, JS prototype chains, or React context.

**Writes flow up one level.** When a branch completes, its result is stored
in its *parent's* memory under the branch's name. A parent's memory is thus
an ordered record of what its children have produced so far, visible to all
later descendants. The root memory holds the thread's initial inputs.

Consequences:

- **Shadowing is free** — two branches named `draft` in different trees
  don't collide; each resolves to the nearest one up its own chain. Branch
  names are scoped, not global.
- **Sibling isolation** — a branch can't see another branch's internal
  state, only what completed branches exported to their shared parent.
- **Deep reads need no wiring** — a grandchild reads the root's values
  without the middle layer passing anything through.
- **Local vs exported** — a branch's own memory holds its internals (tool
  round-trips, per-iteration state); what it exports upward is its final
  result. Leaf branches start empty and read mostly from ancestors.
- **Misses** — lookup reaching the root with no hit yields `undefined`, or a
  loud error if the name was declared in `Needs(...)`.
- **Loops** — each `Until(...)` iteration's children overwrite their slot in
  the parent's memory, so iteration N sees iteration N−1's results (the
  retry-with-verification requirement). Accumulated history, if adopted,
  hangs off this (see Open Questions).

Interactions:

- `m.branch.navigate` reads "the result of the branch named `navigate`",
  resolved by the chain walk; nearest scope holding that name wins.
- `Needs(...)` validation becomes precise: an input is valid if a producing
  branch exists among the preceding siblings, or the preceding siblings of
  any ancestor — and the value must exist when the tree starts (see
  Defined inputs).

This resolves the memory-scope question: neither a global registry nor
strict parent/child — tree-scoped with upward resolution.

### `m.raw`: the record view (chosen)

`m.branch.X` and `m.prev[i]` hold clean exported **values** (strings — safe
for template interpolation). Everything else a leaf produced lives at the
same address under **`m.raw`**:

- `m.raw.prev[i]` / `m.raw.branch.X` →
  `{ content, reasoning, toolCalls, toolResults, calls }`
- `calls[]` — the per-round transcript of a prompt-leaf's internal tool
  loop (the root spec's "Calls"), append-only; dead/rewound outputs remain
  available here and in logs.

So: positional and named addressing, each with a value-view (`m`) and a
record-view (`m.raw`). Nothing a branch produces is invisible.

### `m.error`: the feedback channel (chosen)

Set by a failed `Check(...)` (the check's feedback string), cleared when a
check passes. Re-run prompts incorporate it — `${m.error ?? '...'}` — so
retry feedback flows without polluting `m.prev` positional addressing.
Control-flow artifacts never appear in `prev`.

## Persistence: Logging and Sessions (chosen)

Two separate concerns with different stores: the **call log** (looking
backward — observability) and **session memory** (going forward —
continuity across runs).

### Call log: SQLite

Every event worth debugging is a row — including flow-control events, which
are first-class:

| Column | Contents |
|---|---|
| `run_id` | Timestamp-based run identifier |
| `definition_id` | Root branch name + tree hash (which *version* ran) |
| `seq` | Auto-increment, global execution order |
| `branch_path` | Path from root: `agent/draft#1`, `agent/judge#3` |
| `iteration` | Loop pass number (0 for non-looped) |
| `kind` | `llm_call` · `tool_call` · `tool_result` · `check` · `gate` · `flow` · `skip` |
| `content` | JSON — messages, response, tool args/result, check feedback, goback target, ... |

The `kind` column is the upgrade over the root spec: checks failing, gates
evaluating false, gobacks rewinding are exactly what you debug, so they're
queryable rows — the promised "rule 'retry case' matched" observability.
Since `prev` rewinds drop outputs from memory, **the log is where dead
outputs live.**

Pluggable via `grandma.knit(pattern, { logger })` — default SQLite logger at a
standard path; JSONL or console logger for tests.

### Session memory: memory-in, memory-out

Memory is a plain-data scope chain, so runs are memory-in, memory-out:

```js
const { result, memory } = await grandma.knit(pattern, {
  models: config.models,
  tools: registry,
  memory: previousRootMemory,   // optional initial root scope
});
// save `memory`; feed it into the next run
```

A "session" is just **the root scope threaded through runs** — no session
manager, no session IDs. Serialization is trivial (memory values are plain
JSON); where it lives between runs (file, DB, Redis) is the application's
choice.

**Invariant:** memory values must stay JSON-serializable, forever.

### Human pauses and resume (chosen)

`Human(name, contextFn?)` pauses the run: `knit()` returns
`{ status: 'waiting', humanSlot, context, continuation }` and the caller
resumes with `grandma.resume(continuation, { ...runtime, humanInput })`. The
continuation is a checkpoint ID; state is rebuilt from the event log, and
checkpoints are single-use. See README for the full contract.

Crash recovery (restarting a dead process mid-run from the log alone) is
**not** in v1 — that is the deferred kind of "resume". Runs are atomic in
that sense; the log tells you how far a dead run got.

## YAML vs JS: JS chosen (for now)

Target authors: **LLMs write, humans edit.**

Why JS over YAML:

- Prompts are **functions of memory**. YAML can only hold strings, which
  would require a template engine plus an expression language for conditions
  (the GitHub Actions / Ansible model — no type checking, typos like
  `${memory.step.navigte}` fail at runtime instead of in the editor).
- JS-in-YAML is technically possible — custom `!js` tags (js-yaml / the
  `yaml` package both support custom tags) or eval'd code strings in literal
  blocks (`|`) — but practically worse: eval security, tooling dies at the
  string boundary (no highlighting/linting/autocomplete), runtime errors
  with stack traces pointing into `new Function` instead of the source file.
- LLMs write patterned JS fluently; YAML's approachability advantage matters
  less when the authors are LLMs.
- What LLM authors need most is **validation**: the factory should fail
  loudly at build time on hallucinated elements or references to nonexistent
  branch names.

Escape hatch: a YAML authoring layer can compile down to the element form
later, if non-code tooling ever needs to read thread structure.

### Line notation (sketch layer, in `examples/notation/`)

A five-symbol, line-oriented notation for *sketching* a tree before (or
instead of) writing the elements by hand. It is a **plan, not a compiler** —
it trades the full API's power for a whole-tree view you can read
top-to-bottom. Lives entirely under `examples/notation/`:

- `examples/notation/README.md` — the notation spec: the symbols, the 4
  rules (one line = one chunk; reference-by-name; `"..."` literal vs bare
  text expanded; `|`-prefix nesting), and the line→element mapping table.
- `examples/notation/notation.md` — the worked example, annotated
  line-by-line (notation → chunk → the element it becomes and why).
- `examples/notation/person-scan.mjs` — the translated tree
  (`export const pattern`), heavily commented per `examples/AGENTS.md`.
- `examples/notation/person-scan.test.mjs` — mock-model tests (no network)
  for the translated tree.

Symbols: `++` memory, `<<` emit, `>>` human, `--` prompt, `**` gated branch,
`||` nesting prefix (plus `->` direct calls, `#->` registers, `??` checks,
`@@` per-element subtrees, `()` loops, `!!` needs, `##` imported trees). It
intentionally *forces* the author to face the "gated branch needs a clean
boolean" issue: since a `** if above is true` decision depends on a bare
`--` prompt's output, the translator must add a strict answer-format
instruction to the prompt and a normalizer (e.g. `isYes`) to the condition.
See README.md for the gotcha and person-scan for the concrete fix.

## Design Discussion (Open)

The following points are under active discussion — proposals and tradeoffs,
not settled decisions.

### Skippable steps (resolved)

A gated-out child simply doesn't run — **a skip is just a non-write**. No
special skip semantics exist; the ordinary memory rules decide:

- `Needs(X)` → X must resolve via the scope chain, else a loud error. That's
  the entire rule — the error fires on *lookup miss*, not on "producer was
  skipped." Because memory is a scope chain, X may resolve from an ancestor
  anyway (root inputs, a same-named step in another branch, a grandparent's
  slot) even when the intended sibling producer was skipped.
- Want permissive? Don't declare the need — read defensively
  (`m.branch.X ?? ...`). No declaration, no error.
- Want cascade-skipping? Write a gate: `Branch(when(m => m.branch.X), child)`.
  Visible in the tree and logs, never a hidden rule.

`Needs(X)` means **"given to me"** — put it at the top of the tree. It is
checked when the tree starts, so it is satisfied by an ancestor scope,
injected runtime memory, or a tree tool's call args — never by a sibling
write, even one that appears earlier in the sequence. Loop-carried reads
(draft reading `m.branch.verify` on iteration 1) must stay undeclared —
hence the defensive-read style in all examples (`${m.branch.verify ?? ''}`).

Build-time validation: hard error for needs that appear nowhere in the tree
(hallucinated producer); soft warning for needs whose only producers are
gated or later-in-loop (may still be satisfied by root memory at runtime —
unknowable at build time).

### Prompt shapes

`Prompt(...)` accepts `string | message[] | (memory) => string | message[]`.
Typed message arrays (roles: system/user/assistant/tool) matter because
tool-call round-trips are better expressed as proper role-typed messages
than flattened into one string.

### Tool call steps

A step can be a direct tool call, no LLM. Proposed mental model: **a step is
a named producer of a memory slot** — LLM prompt, tool call, or plain
function are just mechanisms for producing the value.

- `Call(name, argsFn)` — named tool resolved from a **runtime-provided
  registry**, keeping grandma-kat decoupled from MCP (`browser-mcp` or
  anything else supplies tools at run time). (Renamed from `.tool()` — see
  Per-step tools.)

### Inline tool registration (chosen)

`Register(name, description, fn, calls(...), parameters(schema))` lets a
tree declare its own tools — the handler JS lives in the tree file, so a
pattern can ship a tool without a runtime-registry entry.

Modeled as a **declaration, not a step** — but **positional** and **scoped
like a memory slot**: a register is usable from its point in the sequence
onward (a reference before the declaration — a `Call(...)`, a `Tools(...)`
whitelist, another register's `calls(...)`, or anything inside a branch
that runs earlier — is a build error at `knit()` start, "declare it first").
It belongs to the subtree of the def that declares it — inherited downward,
overridable by a child for its own subtree, invisible to callers above and
to siblings, with the runtime's tools as the bottom layer. Lookup happens
at the point of use against the execution scope chain (nearest wins).
Installation is hoisted to scope build (so a pause cannot lose the tool);
the position rule is enforced as validation, not by executing a node.

Consequences: `Register(...)` deliberately does **not** take `when()` (the
gated-declaration exception, alongside `Needs(...)`); two registers with the
same name on ONE tree are a build error (parent/child overrides and
sibling reuse are legal); `calls(...)` and `parameters(...)` are markers like
`when()`/`max()`. The fn is `(memory, args, tools) => result` with `memory` the
call-site view and `tools` the handles for the host tools named in `calls(...)`
— resolved on the register's home path (declaring scope chain, then the
runtime's tools), function-kind only, each call logged as a tool result. A
success result is `{ value, memory }` — `memory` an optional `{ slot: value }`
patch applied as memory updates at both tool-execution sites (`Call(...)`
leaves and prompt tool rounds) and stripped, so the stored tool result is
`{ value }` — or `{ error }` on failure (the patch is skipped). The body is
authored **inline at the call site** (multi-line, `async` allowed) — the same
rule as prompt text, so the tool and the tree using it stay together.

### Defined inputs

Trees declare what they expect in memory: `Needs('draft', 'navigate')`.
Motivation: this is the **validation story for LLM authors**.

- Build-time check: every declared input has a producing tree somewhere in
  the thread (fail loudly on hallucinated names).
- Runtime check at tree entry: the value must be present — from an ancestor
  scope, injected memory, or a tree tool's call args ("given to me").
- Readable dataflow for human editors.

Wrinkle: can't validate "producer appears *before* consumer" at build time,
because loops deliberately violate that — inputs need an "optional / may not
exist yet" notion.

### Loopable steps (resolved)

Resolved — see **Validation and Flow Control**: `Until(...)` is sugar for an
implicit end-of-container `Check(...)` with `goback(<all children>)`.
`goback(n)` provides relative bounded jumps; arbitrary named `goto()` is
deferred. `m.prev` rewinds to the jump point (current-path log); named
slots (`m.branch.X`) persist until overwritten; full history lives in
`m.raw.calls` and logs.

Original discussion: retry-with-verification = *a parent re-running its
branches*; loops get a `max()` bound (or the framework default cap) —
LLM-authored loops without bounds burn tokens forever.

### Per-step model (resolved)

Each step can run with a different model: `Model(name)` anywhere in the
tree, with inheritance down the tree — step → parent step → root → runtime
default. Build-time validation: every referenced model name must exist
before execution (matches the root spec's model-inheritance rule).

**The argument is a named model from config (chosen).** The config's job is
to define *named models*, not providers-with-one-model-each — each entry
carries the full connection (`baseURL` + `apiKey` + model ID):

```json
"models": {
  "cheap":  { "baseURL": "http://localhost:8080/v1", "apiKey": "no-key", "model": "LFM2.5-1.2B" },
  "strong": { "baseURL": "http://localhost:8080/v1", "apiKey": "no-key", "model": "Qwen3-32B" }
}
```

```js
Model('cheap')    // classification steps
Model('strong')   // synthesis steps
```

One concept covers both "different endpoint" and "same endpoint, different
model" — the name is the unit. Broken provider/model combos are
unrepresentable; there's no `.provider()` / raw-ID escape hatch to get
wrong. For LLM authors, one obvious way wins.

Use case: cheap/small model for simple classification steps (the "yes/no"
checks in `find-listings`), stronger model for synthesis — cost/latency
optimization per step.

Config note: this reshapes `threads.config.json` from a `providers` map to
a `models` map for grandma-kat (existing prototyping scripts keep their
format).

### Per-step tools

Each prompt step defines which tools are available to its LLM call:
`Tools('navigate', 'click')` — a whitelist of names from the runtime
registry, sent as function-calling schemas. Default: no tools.

**Container inheritance (chosen).** Prompt-leaves are anonymous — no handle
for per-leaf config — so `Tools(...)` on a container applies to all its
prompt children (resolution up the scope chain, like `Model(...)`). Opt out
per prompt via options bag: `Prompt(fn, { tools: [] })`. Per-prompt tool
sets → use named branches.

**Tool calls: auto loop by default (chosen; supersedes "single round").**
A prompt executes every tool call the model emits, appends the results to
its local thread, and calls the model again — until a round returns no
tool calls. See `docs/auto-tool-loop.md` for the full contract (record
shape, resume, hooks). `disableAuto()` restores the single-round behaviour
for steps that act on exactly one call per pass (`find-address`'s
`pick_action` is the canonical example); `max(n)` bounds the loop and
exhaustion throws; `toolHookBefore`/`toolHookAfter` observe and rewrite
each call.

The original single-round rationale — the tree controls retries, visible
and debuggable; small models make poor recovery choices in an opaque loop —
still applies to opted-out steps. The loop exists because every real tree
was already hand-rolling it (`Prompt → Memory(buildToolMessages) →
Until(!toolCalls, max(12))`), which duplicated conversation plumbing in
every pattern and dropped the tool exchange whenever the tree rewound.

**Naming (chosen):** the direct tool-call leaf is `Call(name, argsFn)`,
not `.tool()` — one letter from `Tools(...)`, too confusable.

**Validation timing (chosen): up-front at `knit()` start.** The runner walks
the whole tree, collects every `Tools(...)` reference, and diffs against the
injected registry *before anything executes* — unknown names throw
immediately, listing every miss with its branch path (`agent#2 references
unknown tool 'navigte' — did you mean 'navigate'?`). No partial validation,
no failing when the branch is reached: a tree referencing missing tools is
rejected wholesale, one error with all the typos. `grandma.compile()` runs
the same check at compile time. Loud on missing, lenient on ugly: a
registered tool with a sparse schema (no description, minimal params)
warns but proceeds — schema quality is the registry's own business.

### Conditional rules everywhere (proposed)

Every element takes an optional condition wrapped in `when()` (syntax
chosen — see gotcha #1): `Model(when(run_if), model)`, `Prompt(when(run_if), prompt_fn)`,
`Branch(when(run_if), child)`, `Until(when(run_if), check)`. The marker may
sit anywhere among an element's arguments; rules are evaluated lazily at
the point of use, against memory.

Unconditional calls stay bare: `Prompt(m => ...)`. A `when()` marker is a
distinct type, so the parser rejects a bare function in the condition slot
at build time with "did you mean `when()`?" — loud, specific errors for the
mistake LLM authors will make.

**Semantics: last match wins (conditional assignment).** Rules apply in
declared order; each matching rule overwrites the previous value.
`Model('x'), Model('y')` → `'y'` — same as normal assignment, each with
a gate. The override pattern puts defaults first:

```js
Model('cheap-model')                                                    // default first
Model(when(m => m.branch.plan.complexity === 'high'), 'strong-model')   // conditional override

Until(when(m => m.branch.plan.mode === 'interactive'), m => m.branch.confirm === 'yes')  // gated loop check
```

(Note: `Prompt(...)` is accumulative, not selective — see Trees Are
Containers. Prompt "variants" are gated children, not overrides.)

Ordering convention: **general first, specific later** — the reverse of
pattern matching (specific first) and the reverse of the root spec's
first-match-wins conditions. Chosen because it matches normal setter
intuition (later calls overwrite). Must be documented loudly: LLM authors
may import either convention by habit.

**Two flavors of elements:**

- *Selective (config)* — one value is chosen: `Model`, `Until`. Last
  matching rule wins.
- *Accumulative (doing)* — every element applies, in declared order:
  `Branch(when(cond), child)`, `Prompt(...)`, `Call(...)`, `Check(...)`,
  `Memory(...)`, `Return(...)`.
  No overriding; authors must not expect switch-like behavior. (See Trees
  Are Containers.)

Defaults when no rule matches: `Model(...)` → inherit from parent; `Branch(...)` /
`Prompt(...)` / `Call(...)` → child not attached (this largely subsumes
`.skipif` / `.runif` as separate concepts); `Until(...)` → no loop. A named
tree with zero attached children is a build error (see Trees Are
Containers).

**Gotchas / validation:**

1. *Condition syntax: `when()` wrapper (chosen).* Conditions are wrapped:
   `Prompt(when(m => m.branch.verify), m => ...)`; unconditional calls pass
   the value bare. The marker is a distinct type, so the parser can reject
   a bare function in the condition slot at build time ("did you mean
   `when()`?"). Rejected alternative: enforced 2-arity
   (`Prompt(true, m => ...)`) — uniform for generators (the SQL
   `WHERE 1=1` trick), but the noise tax lands on the common unconditional
   case, and `Until(true, check)` is actively misleading since both slots
   are `memory => boolean`. Bonus: `when()` can later grow labels,
   `when(cond, 'retry case')`, so logs can name which rule matched.
2. *Shadowed rules* — a conditional rule followed by an unconditional rule
   is dead code (the unconditional one always overwrites it). Build-time
   warning.
3. *Attachment-site vs tree-owned conditions (resolved)* — gates live at
   the attachment site **only**: `Branch(when(cond), child)`. Tree-owned /
   intrinsic gating is expressed with a `Check(...)` child inside the tree
   itself — the check IS the tree's own gate, visible in its tree. One gate
   location to learn; no AND-ed two-gate semantics.
4. *Dynamic trees* — conditional attachment means `Needs(...)` can only check
   "a producer exists among potentially attached branches"; runtime
   missing-input handling follows skip semantics (see Open Questions).

### Unified lifecycle (proposed)

Every tree gets the same lifecycle: **gate-check → collect declared inputs →
produce value (prompt / call / branches) → store in memory under its name →
flow control (`Check(...)` / `goback()` / `Until(...)`)**. One uniform shape
keeps behavior predictable for LLM writers and the engine simple.

## Open Questions

*No questions remain.* Only deferred items: crash recovery (mid-run resume),
tool-call pause mode, escalation promotion, YAML authoring layer.

Resolved:

- ~~Tool validation timing~~ → up-front at `knit()` start: whole-tree diff
  against the registry before the first call; loud on missing, lenient on
  ugly (see Per-step tools).

- ~~Attachment-site vs tree-owned conditions~~ → attachment-site only;
  intrinsic gating via a `Check(...)` child (see Conditional rules, gotcha
  #3).

- ~~Model reference~~ → `Model(name)` references a named model in config;
  config defines a `models` map, each entry carrying full connection
  details (see Per-step model).

- ~~Skip semantics~~ → a skip is a non-write; `Needs(X)` errors on lookup
  miss via the scope chain (which ancestors may satisfy); permissive =
  don't declare; cascade = write a gate (see Skippable steps).

- ~~Memory scope~~ → tree-scoped with upward resolution (see Memory Model).
- ~~Condition syntax~~ → `when()` wrapper (see Conditional rules, gotcha #1).
- ~~Factory output~~ → `Tree(...)` produces a definition (plain data); a
  runner executes it with injected runtime (see Factory output).
- ~~Execution order~~ → prompts are always children (Model B: container);
  children run sequentially in declared order; container value = last
  executed child's result (see Trees Are Containers).
- ~~Loop construct~~ → `Until(...)` is sugar for end-of-container `Check(...)` +
  `goback(all)`; relative bounded jumps, arbitrary goto deferred (see
  Validation and Flow Control).
- ~~Memory history~~ → `m.prev` rewinds (current-path log); named slots
  latest-only with overwrite; full history via `m.raw.calls` and logs (see
  Memory Model).
- ~~Tool-call round-trips~~ → auto loop by default: the prompt executes tool
  calls, feeds results back, and keeps going until the model answers without
  calls; `disableAuto()` + `Check(...)`/`goback()` for deliberate one-action
  steps (see Per-step tools and `docs/auto-tool-loop.md`).
- ~~`.tool()`/`.tools()` naming~~ → direct call is `Call(...)` (see Per-step
  tools).
