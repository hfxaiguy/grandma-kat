# tree-smith — a tree that writes and executes trees on the fly

A self-extending agent: give it a task, and it asks a strong model to write a
complete grandma-kat pattern for that task, compiles the source into a tree
definition, and runs it — **in place**, meaning the generated tree executes
inside the smith's own run: same run id, same call log, same `m.prev` /
`m.raw` bookkeeping, same pause/resume machinery.

This is the "trees as tools" seam (docs/ → trees-as-tools in the main
README) plus one trick — a registry alias — that lets a *static* tool entry
point at a *freshly written* definition.

## The three moves

```
tree-smith
  ├── authoring (its own subtree, so its tool offer is scoped)
  │     ├── author   — Prompt('author')   the model writes a pattern (guide.mjs);
  │     │                                  it may inspect data with tools and
  │     │                                  test-run candidates in the draft slot
  │     ├── check / Call define / check   — compile into 'live'; failures repair
  │     │                                  through the author via m.error
  │     ├── emit     — Emit(...)           host sees { defined, alias, source }
  │     └── return   — Return(...)         exports { source, name, alias }
  ├── invoke         — Prompt('invoke')    the model calls run_live …
  ├── check          — Check(...)          … subtree failures → feedback → re-invoke
  └── return         — Return(...)         { source, name, alias, result }
```

- **Author** — `guide.mjs` is the whole game: the element surface, the
  memory model, the rules that actually trip up LLM authors (gates need clean
  booleans, a check must return exactly `true`, `Needs(...)` is not for
  sibling outputs, every loop needs `max(...)`), the import/remapping idiom,
  the data-pipeline rules (query results stay live), the authoring
  workbench, the input contract, and the inventory of
  models/tools the finished tree may reference. The inventory is rendered
  from `SURFACE` (`tree-smith.mjs`), so the prompt and the static validation
  can't drift.
- **Define** — `Register('define_tree')` (an inline tool, no runtime entry
  needed) evaluates the source with the element factories injected as
  `new Function` parameters. Build errors and unknown tool/model names come
  back as `{ error }`; the following `Check` turns that into `m.error` and
  `goback(3, max(3))` sends the author back to fix the source. On success it
  wraps the definition — `Tree(name(alias), Branch(def))` — which registers
  the wrapper under the slot alias the moment the `name` element is applied
  (`src/tree.mjs`).
- **Invoke** — the model calls the host-declared `run_live` tool (a single
  `disableAuto()` round). The runner resolves `generated:live` at call time
  (`resolveTreeTool` → `loadNamedTree` → registry fallback) and executes the
  fresh definition as an in-place subtree, with the call args seeding its
  scope — which is why the generated tree can declare `Needs('task')`.

## Why the alias (and not a new tool name per tree)

`Tools(...)` whitelists are validated at `knit()` start against the runtime
registry — a tree referencing a name that doesn't exist yet is rejected
wholesale, before anything runs. So the *name* must be static even though the
*definition* is dynamic. One host entry (`run_live`) + one registry alias
(`generated:live`) + one re-registration per define gives you exactly that.

## Authoring with tools — explore, then test-run

The author isn't writing blind. The authoring subtree runs with its own tool
offer (`AUTHOR_TOOLS`):

- **Inspect real data before writing.** Every tool in `SURFACE.tools` is
  offered to the author prompt, including the demo `sql_query` (read-only,
  in-memory `contacts` table). The guide tells the model to check schemas,
  field names, and sample rows first — a few targeted queries.
- **Test-run candidates in the draft slot.** Two author-only helpers:
  `define_draft({ source })` compiles the current source into the `draft`
  alias (rejection reasons come straight back), and `run_draft({ task })`
  runs it exactly like the real invocation. The author revises until the
  test run looks right, then answers with the final source; the smith
  re-defines it into `live` and runs it for real.

Both of these use the same machinery as the smith itself: the author prompt's
tool round-trips are just the auto tool loop (`max(12)` bounds it — the loop
throws when exceeded), and `run_draft` is an ordinary model-called tree tool,
so its failures come back as recoverable `isError` results.

Two structural details worth knowing:

- **Why `authoring` is its own subtree.** `Tools()` rules resolve
  *innermost-tree-first*, and within one tree level **last match wins
  regardless of position** — so two tool rules in one tree would shadow each
  other globally (the validator even warns). Scoping a phase to a different
  tool offer means giving it its own tree level (a `Branch`), which is what
  this example does.
- **Why `define_draft` exists separately from `define_tree`.** A register
  can't tell which phase called it, so a dedicated tool that *always*
  targets `draft` makes it impossible for an experiment to clobber the
  promoted `live` definition.

Safety rails: test runs execute with the same registry as the real run, so
keep experiments read-only (the demo `sql_query` is SELECT-only by
construction), keep samples small, and don't put `Human()` in a draft.

## Slot semantics

A **slot** is our name for the alias + static-entry pattern — it's not a
framework feature. The example declares two: **`live`** (the smith promotes
and invokes it) and **`draft`** (the author's workbench).

- **One live definition per slot.** Each successful define overwrites what
  the alias points at. Calls that already ran are unaffected; subsequent
  calls see the new definition (resolution happens per call).
- **Unlimited invocations.** `run_live` can be called any number of times
  (by the model, or via `Call('…', 'run_live', …)`); every call runs in a
  fresh child scope seeded from its args.
- **More slots = more static names, chosen up front.** Add any name to
  `SURFACE.slots` and the host's loop declares `run_<slot>` →
  `generated:<slot>` too. `define_tree` takes an optional `slot` arg; the
  smith's invoke round targets the default.
- **Slots are process-global.** The registry is module-level: two concurrent
  `knit()` runs sharing a slot alias clobber each other. Sequential runs are
  fine; concurrent hosts should namespace slots per run.
- **Not a library — but names persist.** Named generated definitions stay
  registered in the process, so a later generated source can *compose* them
  by name with `From('name', memory(…))` (see _Reuse_ below). Calling one as
  a **model tool** is the part that needs its own slot — or a recursive
  `grandma.knit()` wrapper (separate run/log).

## Reuse: composing with `From(...)` — and input remapping

A generated tree can import trees that are already registered: helper trees
it declares itself, or trees an earlier smith run defined (named definitions
stay in the process registry).

```js
const helper = Tree(
  name('helper_echo'),
  Needs('input'),
  Prompt(m => `helper saw: ${m.input}`),
);

const pattern = Tree(
  name('composer'),
  Needs('task'),
  Prompt('prep', m => `prep: ${m.task}`),
  From('helper_echo', memory(m => ({ input: m.branch.prep }))),
);
```

`From('name')` is the attach element for registered trees — it resolves the
name at build time and builds the same branch record as `Branch(def)` — and
it takes the input remap directly: `memory(fn)` receives the call-site
memory view and returns the slots to write into the import's own scope at
entry. That is how the helper's `Needs('input')` gets satisfied. The seeded
slots shadow same-named ancestor slots for that subtree and leak nothing to
siblings; the seed is re-applied on resume. `memory(m => ({ ...m }))`
snapshots the call site into the import.

Two things this replaces: hand-rolling the remap with extra `Memory(...)`
steps before the import, and wrapping the attach in `Branch(...)` — `From`
is the element for exactly this. The import is positional and gateable
(`From(when(m => …), 'name', memory(…))`), and an unregistered name is a
build-time error, so the tree must already exist when the source is
evaluated. Imported trees answer to the same surface as the importer —
`validateDef` walks them too.

## Error handling — two repair loops, one bound each

- **Build/reference errors** (source doesn't evaluate; unknown tool/model;
  an unregistered `From` name; a name the smith reserves for itself) never
  reach the registry. The `Check` after define relays the message to the
  author via `m.error`, and `goback(3, max(3))` re-runs author → check →
  define inside the authoring subtree.
- **Run-time failures** of the generated tree come back as `isError` tool
  results — the prompt tool loop converts thrown subtree errors
  (`src/knit.mjs`), which is why the invoke step is a *model call* and not a
  `Call(...)`: a `Call` to a tree tool throws through and would kill the
  smith. `goback(1, max(2))` re-invokes; after that the smith fails loudly.
  (Turning a repeated run-time failure into a re-*author* is the deferred
  escalation feature — see the main README's flow-control section.)

## In place vs. isolated

The slot path runs the generated tree in the smith's run — pause/resume, the
call log, `m.raw`, all shared. If you'd rather isolate each generated run
(fresh run id and log, memory-in/memory-out), call a recursive
`grandma.knit(def, runtime)` from a plain `execute` tool instead — at the
cost of a separate log and having to surface pauses yourself.

## Safety

`new Function` executes model-authored code **unsandboxed**, with the full
privileges of the process. That is fine for this repo's trust model (the
examples are LLM-authored too, and you run them deliberately), but if the
authoring model or its inputs ever become untrusted, put the evaluation
behind `node:vm` with a frozen context or a subprocess — `vm` alone is
hygiene, not a security boundary. The `Emit` event gives the host the exact
source before it runs.

The demo `sql_query` is an in-memory database and SELECT-only by
construction — safe to let the model explore. A production query tool should
be a read replica or a restricted view for the same reason; the author's
test runs execute against the same registry as the real run.

## Files

| File | What it is |
|---|---|
| `tree-smith.mjs` | The pattern — three moves, `SURFACE`, `AUTHOR_TOOLS`, slot helpers |
| `guide.mjs` | `renderAuthorPrompt(...)` — the authoring instructions |
| `compile.mjs` | `evaluatePattern` + `validateDef` + factory list |
| `entry.mjs` | CLI wiring: one model, demo tools + `sql_query`, the slot entries |
| `tree-smith.test.mjs` | Mock-model tests (no network) |

## Running

```sh
# the tests (mock models, no network)
node examples/tree-smith/tree-smith.test.mjs

# a real run — from the repo root, with a model in grandma-kat.config.json
node examples/tree-smith/entry.mjs "find Harbr Group contacts without phone numbers"
```
