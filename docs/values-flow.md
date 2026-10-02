# How values flow

A tree is a container; every child produces a value, and the tree under it
exports one. This page is the map: where a value lands, how to read it back,
and the two addressing schemes (`m.branch.X` by name, `m.prev[i]` by position).

Read it with [`../AGENTS.md`](../AGENTS.md) § *Trees Are Containers*, §
*`m.prev`* and § *Memory Model: Scope Chain* open beside it.

## The three ways to read a value

| Address | Holds | Use when |
|---|---|---|
| `m.branch.X` | the **clean value** of the branch named `X` (nearest up the scope chain) | you know *which* child produced it |
| `m.prev[i]` | completed siblings' values, **most-recent-first** (`[0]` is the child that just finished) | you want "the one before me" |
| `m.raw.branch.X` / `m.raw.prev[i]` | the **record**: `{ content, reasoning, toolCalls, toolResults, calls }` | you need what the model actually said / its tool round-trips, including dead outputs |

`m.branch.X` and `m.prev[i]` hold **strings** — safe to interpolate into a
prompt. Everything else lives under `m.raw`.

## What each leaf produces

| Step | Its value |
|---|---|
| `Prompt(...)` | the model's text answer |
| `Call(name, tool, args)` | the tool result |
| `Memory(name, fn)` / `Memory(update(), name, fn)` | the value it wrote |
| `Emit(fn)` | the emitted object (`{ text, ... }`); side-effect-free, does not pause |
| `Human(name)` | the human's reply (read as `m.branch.name`) |
| `Each(name, arrayFn, tree)` | per-item results collected under `m.branch.name` |
| `Branch(when?, subtree)` | the value its **last executed child** produced (see below) |

## Where a result lands

When a branch completes, its result is stored in its **parent's memory under
the branch's name**. The parent's memory is therefore an ordered record of what
its children produced so far, readable by every later descendant.

- **Reads resolve upward.** A name is looked up in the current scope, then the
  parent, then up to the root; **the nearest binding wins**.
- **Siblings are isolated.** A branch sees only what *completed* siblings
  exported to the shared parent — never another branch's internals.
- **Deep reads need no wiring.** A grandchild reads a root value directly.

## Naming: if you reference it, you name it

A prompt with no `name(...)` gets a **build-time** auto-name `${parent}#${k}`
(`k` = its 1-based position among that parent's prompt children). `#` is
reserved, so auto-names can never collide with author names.

Consequences:

- A gated-out prompt **keeps its number**; loop iterations **reuse** the same
  slot (overwrite semantics) — so auto-names survive gating and looping.
- Inserting a prompt renumbers every later one. That is why the contract is
  **"if you reference it, you name it"**: reading `m.branch['parent#2']` or
  `Needs('parent#2')` is fragile. Give that subtree an explicit `name(...)`.

Name a subtree when the parent reads its result, or when the sketch names it;
otherwise leave it unnamed — `knit()` auto-names it and registers it so resume
can find it.

## Memory: declare vs update

Two forms, and they are not interchangeable:

```js
Memory("budget", () => 7)                 // DECLARE / overwrite in the CURRENT scope
Memory(update(), "budget", (m) => m.budget + 10)  // WRITE the NEAREST owning slot, up the chain
```

- `Memory(name, fn)` **owns** the slot in the scope where it appears. Declare a
  slot in the scope that owns it (usually the root).
- `Memory(update(), name, fn)` writes to the **nearest ancestor that already
  owns** that name — the way a child updates a parent's slot without moving it.

If a child instead **re-declares** the name, it creates a *new* slot in the
child's scope; the parent's copy is never touched (and the parent reads a stale
value). That is the classic shadowing bug — see
[`pitfalls.md`](pitfalls.md#shadowing-a-parent-slot).

## What a branch exports

A `Branch(...)` exports the value of its **last executed child** — unless a
`Return(...)` fires first. So bookkeeping after your useful result flips what
the branch exports:

```js
// exports the memory write? No — it exports `cache`, the last child.
Branch(Tree(
  name("fetch"),
  Call("rows", "sql_query", () => ({ path: "c.duckdb", query: "SELECT …" })),
  Memory("cache", (m) => m.branch.rows),   // ← now this is the exported value
))
```

Pin the exported value with an explicit `Return`:

```js
, Return((m) => m.branch.rows)   // export the fetch result, not the bookkeeping
```

`Return(fn)` / `Return(when(cond), fn)`:

- **non-`null` value** → push to `m.prev`, record it, and **stop** the tree;
  remaining children are skipped and the tree exports that value.
- **`null` / `undefined`** → a no-op; the tree continues and the return
  occupies **no** position in `m.prev`.

## `m.prev` is dense and execution-relative

`m.prev` is the log of the **current execution path**, not declaration order or
full history:

- **Gated-out siblings occupy no position** — if a `Branch(when(false), …)`
  doesn't run, the next child is still `m.prev[0]`.
- **Rewinds reset it to the jump point.** `goback()` / `Until(...)` rewind
  `m.prev` along with execution, so positional indices stay stable across
  retries.

That last point is why dead outputs vanish from memory but stay in the
**log** and in `m.raw` — see [`debugging-a-run.md`](debugging-a-run.md).

## A small worked tree

```js
# notation
# -- outline: write an outline
# -> rows: sql_query
# ++ cached: the rows
# -- draft: write from the outline
# ** if cached is non-empty
# || -- review: critique the draft
# ***

const tree = Tree(
  name("pipeline"),
  Model("strong"),
  Needs("task"),
  Prompt("outline", (m) => [{ role: "user", content: `Outline: ${m.task}` }]),
  Call("rows", "sql_query", () => ({ path: "c.duckdb", query: "SELECT id FROM t" })),
  Memory("cached", (m) => m.branch.rows.rows),
  Prompt("draft", (m) => [{ role: "user", content: `Draft from:\n${m.branch.outline}` }]),
  Branch(when((m) => m.cached.length > 0), Tree(
    Prompt("review", (m) => [{ role: "user", content: `Critique:\n${m.branch.outline}` }]),
  )),
);
```

Reading the same tree from a fourth child:

- `m.branch.outline` → `outline`'s text (by name).
- `m.branch.rows` → the SQL result.
- `m.cached` → the slot (`Memory` wrote it into this scope).
- `m.prev[0]` → whatever completed most recently (`review` if its gate was
  true, else `draft`).
- `m.raw.branch.outline.content` → the raw model text behind `m.branch.outline`.

## See also

- [`pitfalls.md`](pitfalls.md) — the mistakes this model invites.
- [`debugging-a-run.md`](debugging-a-run.md) — how to see a value's history.
- [`../AGENTS.md`](../AGENTS.md) — the decisions behind the scope chain.
