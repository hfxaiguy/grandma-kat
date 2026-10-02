# Writing trees: code first

A Grandma-KAT tree exists to **do work in JavaScript**. A prompt is one tool
among many — a way to get a judgement from a model — not the default step. The
strongest trees keep the model on a short leash: it reads, decides or writes,
and ordinary code does everything else. Every extra prompt is a slow,
non-deterministic, unrepeatable round trip; every line of code is none of those.

## The rule

**Push the work into code.** Parse, filter, sort, rank, dedupe, count, join,
format, validate and decide in plain functions. Let a prompt do only what needs
a model.

| Do it in code | Reach for a prompt |
|---|---|
| arithmetic, aggregation, shaping | reading free text into structure |
| choosing the max / first / matching row | choosing among genuinely ambiguous options |
| building tool arguments | writing prose for a human |
| deciding a branch on a computed value | classifying intent with no rule |

## Where the code goes

Every callback is an ordinary function — that is where the logic lives.

- **`Call([name], tool, argsFn)`** — build the arguments in `argsFn`.
  ```js
  Call('rows', 'sql_query', (m) => ({
    path: 'contacts.db',
    query: `SELECT id, phone FROM profiles WHERE id IN (${m.ids.join(',')})`,
  }))
  ```
- **`Memory(name, fn)` / `Memory(update(), name, fn)`** — compute the value.
  ```js
  Memory('missingPhone', (m) => m.branch.rows.rows.filter((r) => !r.phone))
  ```
- **`Branch(when(cond), tree)`** — branch on a value you computed.
  ```js
  Branch(when((m) => m.missingPhone.length > 0), huntTree)
  ```
- **`Return(fn)`** — shape the exported value.
  ```js
  Return((m) => ({ ok: true, picked: m.missingPhone[0] ?? null }))
  ```
- **Helpers above the tree.** Pure functions defined before
  `const pattern = Tree(...)` keep the flow readable and the logic testable.
  ```js
  const rank = (rows) => [...rows].sort((a, b) => b.score - a.score);
  ```

## Tools fetch; code decides

A `Call(...)` gets data in; the tree's code decides what it means. Do not hand
the same data to a prompt just to have it repeated, counted, compared or
filtered — `Array.prototype` will be faster, cheaper and correct every time.

Prompts that call tools are a real pattern (the **auto tool loop**), but prefer
a fixed `Call(...)` when the tool and its arguments are known: a `Call` cannot
hallucinate a tool name or arguments, and it costs no model round.

## A worked contrast

Asking a model to pick from data it was handed:

```js
// ✗ slow, non-deterministic, and the model may miscount
Call('rows', 'sql_query', () => ({ path: 'contacts.db', query: 'SELECT id, phone FROM profiles' })),
Prompt('pick', (m) => [
  { role: 'user', content: `Pick one with no phone: ${JSON.stringify(m.branch.rows.rows)}` },
]),
Return((m) => m.branch.pick),
```

Doing it in code:

```js
// ✓ deterministic, free, testable
const missingPhone = (rows) => rows.filter((row) => !row.phone);
const firstOrNull = (rows) => rows[0] ?? null;

const pattern = Tree(
  name('pick_unphoned'),
  Model('strong'), // still required: see "no model resolvable" below
  Call('rows', 'sql_query', () => ({ path: 'contacts.db', query: 'SELECT id, phone FROM profiles' })),
  Memory('candidates', (m) => missingPhone(m.branch.rows.rows)),
  Return((m) => firstOrNull(m.candidates)),
);
```

The model is declared — a tree with several runtime models and no `Model(...)`
in scope fails to knit — but never called.

## Common build errors, and what they mean

`knit()` validates the whole tree **before the first model call**, so most
mistakes surface immediately, with the path to the offending node:

- **`Tree(...): every argument must be an element`** — the old chain form
  (`.prompt()`, `.branch()`, `.model()`) is gone. Write the elements:
  `Tree(name('x'), Model('strong'), Prompt(...), Return(...))`.
- **`references unknown tool 'x'`** — a `Tools(...)` or `Call(...)` name is not
  in the runtime registry. Check the spelling; a **tree tool** must be
  registered and resolvable through the host's `loadTree` hook.
- **`no model resolvable: no Model() rules anywhere and no runtime default`** —
  no `Model(...)` is in scope for some prompt, and the runtime has zero or more
  than one model. Add `Model('<name>')` on the tree (or an ancestor).
- **`Model('x') references a model not in runtime models (available: …)`** —
  use a name the host actually provides; the error lists them.
- **`Branch() expects a single tree argument`** — the subtree was passed to
  `when(...)` instead of to `Branch(...)`. Write
  `Branch(when(cond), subtree)`, **not** `Branch(when(cond, subtree))`.
- **`tree 'x' needs 'y', but … it is not in the injected memory`** — a
  `Needs('y')` declaration nothing produces. Seed `y` (injected memory or a
  producing sibling) or drop the declaration.

## See also

- [`examples/notation/README.md`](../examples/notation/README.md) — the
  line-notation sketch layer you write a tree in first (`//` comments run to
  the end of the line; `##` and `#->` are chunks, never comments).
- [`docs/auto-tool-loop.md`](auto-tool-loop.md) — how a prompt calls tools.
- [`docs/values-flow.md`](values-flow.md) — `m.branch` / `m.prev` / `m.raw`,
  and how values move between scopes.
- [`docs/pitfalls.md`](pitfalls.md) — the mistakes trees invite, with fixes.
- [`docs/debugging-a-run.md`](debugging-a-run.md) — reading the call log to
  find why a tree misbehaved.
- [`docs/spec-parity.md`](spec-parity.md) — keeping the `.md` sketch and the
  `.mjs` translation in sync.
- [`AGENTS.md`](../AGENTS.md) — the design decisions behind the element surface.
