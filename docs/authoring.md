# Writing trees: code first

A Grandma-KAT tree exists to **do work in JavaScript**. A prompt is one tool
among many — a way to get a judgement from a model — not the default step. The
strongest trees hand the model the decisions and keep the code for verification,
mechanics, and the invariants that must never break. Every extra prompt is a slow,
non-deterministic, unrepeatable round trip; every line of code is none of those.

## The model decides; code verifies

The default split is **judgement in a prompt, verification in code**.

- **The model decides** what a request refers to, which record / page / link is
  the one meant, whether a document is relevant, what a piece of text means, and
  how a multi-step job should be structured. Those are semantic lookups and
  choices; a hand-written matcher or rule table fails on the first legal suffix,
  typo, or paraphrase.
- **Code verifies** the chosen value: the id exists, the target belongs to the
  expected domain, the address clears the provenance bar, the write returned
  `ok`, the list item is deduped, the cap is respected — and owns the mechanics
  (normalize, count, sort, format, attach sources, guard invariants).

Deterministic functions are **excellent at checking a decision and terrible at
making one**. If you find yourself growing a matcher, a fuzzy-name heuristic, or
a rule table to work out what the caller meant, that is the signal to give the
model the candidates (or a read tool) and let it choose; keep the check in code.

## The rule

**Push judgement into the model and verification into code.** A prompt (with
tools) resolves the semantic questions; plain functions check the answer and do
the mechanics. Let a prompt do only what needs a model — and do not hand the
model what a loop or a comparison already knows.

| Do it in code | Reach for a prompt |
|---|---|
| verifying an id / target exists and is the right kind | resolving which record / page / link is meant |
| arithmetic, aggregation, shaping, formatting | reading free text into structure |
| dedupe, normalization, provenance, caps | choosing among genuinely ambiguous options |
| mechanical filters by a known predicate | classifying intent with no rule |
| shaping the verified material a prompt hands to a tool | writing prose for a human |

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
- **`Branch([when(cond)], tree)`** — attach a subtree. The gate is optional:
  `Branch(when(cond), tree)` branches on a value you computed; a bare
  `Branch(tree)` runs unconditionally (a grouping / sequence step).
  ```js
  Branch(when((m) => m.missingPhone.length > 0), huntTree) // gated
  Branch(huntTree)                                         // unconditional
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

## Tools fetch; the model decides; code verifies

A `Call(...)` gets data in. If the question is **mechanical** — "which rows have
no phone?", "which address is closest?" — compute it in code; `Array.prototype`
is faster, cheaper and correct every time. If the question is **semantic** —
"which of these three Acmes is the company?", "which link is the pricing page?"
— hand the model the candidates (or the read tool) and let it choose; a matcher
will guess.

Prompts that call tools are a real pattern (the **auto tool loop**). Prefer a
fixed `Call(...)` when the tool and its arguments are already known: a `Call`
cannot hallucinate a name, and costs no model round. When the choice of tool or
target **is** the work, use the model.

## A worked contrast

Mechanical filtering stays in code:

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

Semantic resolution goes to the model, then code verifies the choice:

```js
// ✗ a hand-written matcher misses "Acme Ltd." and "Acme Corporation"
const company = candidates.find((row) => row.name === 'Acme');

// ✓ the model reads the candidates + website and picks; code checks the id
Prompt('resolve', (m) => [
  { role: 'system', content: 'Choose the company these candidates describe. Return {"id": …} or {"id": null}.' },
  { role: 'user', content: `Website: ${m.website}\nCandidates: ${JSON.stringify(m.candidates)}` },
]),
Check((m) => contactExists(m.branch.resolve?.id) || 'unknown contact id — re-read the candidates'),
```

## Attach trees by name; capabilities don't cross a call

Two rules that keep a pinned tree isolated and least-privileged:

- **Reference trees by name, never by importing their module.** Attach with
  `From('tree')`, declare hooks with `Hook(trigger, 'tree')`, call tree tools by
  name. Import directly only your own non-tree code (`./src/*`) and
  `grandma-kat`. A relative `import … from '../other/tree.mjs'` binds that
  tree's *draft*, so a pinned snapshot silently follows draft edits.
- **Tools do not cross a tree-tool call.** A tree the model calls (or a
  `Call(...)` to a tree-backed tool) sees only its own `Tools()` — declare what
  it needs on the tree or prompt. Only a `From(...)`-attached subtree inherits
  the parent's tools. Unknown `Tools(...)` names are still listed up front by
  validation.

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
- [`docs/inspect-memory.md`](inspect-memory.md) — `inspect_memory`: a bounded
  view of a value the model holds only by a `ref://` handle or a slot name.
- [`docs/values-flow.md`](values-flow.md) — `m.branch` / `m.prev` / `m.raw`,
  and how values move between scopes.
- [`docs/pitfalls.md`](pitfalls.md) — the mistakes trees invite, with fixes.
- [`docs/debugging-a-run.md`](debugging-a-run.md) — reading the call log to
  find why a tree misbehaved.
- [`docs/spec-parity.md`](spec-parity.md) — keeping the `.md` sketch and the
  `.mjs` translation in sync.
- [`AGENTS.md`](../AGENTS.md) — the design decisions behind the element surface.
