# Pitfalls

The mistakes trees invite, each with the symptom you'll see, why it happens,
and the fix. Most of these surface as a *silent* wrong result rather than an
error — pair this with [`debugging-a-run.md`](debugging-a-run.md) to find them.

## Chaining the old API

**Symptom:** `Tree(...): every argument must be an element`.

The fluent chain (`.prompt()`, `.branch()`, `.model()`) is gone. Elements are
**arguments**, and the order of the arguments is the execution order:

```js
// ✗
Tree(name('x')).model('strong').prompt('p', …)

// ✓
Tree(name('x'), Model('strong'), Prompt('p', …), Return(…))
```

## `Branch(when(cond, subtree))`

**Symptom:** `Branch() expects a single tree argument`.

The subtree was passed *inside* `when(...)`:

```js
// ✗  Branch(when(cond, subtree))
// ✓  Branch(when(cond), subtree)
```

Same shape for `Prompt`/`Check`/`Until`: the gate is `when(cond)`, a separate
argument — never the condition wrapping the payload.

## A directive leaking past where you meant it

**Symptom:** a prompt runs with the wrong model, or is *offered tools it should
not have* — the model calls one it shouldn't.

`Model(...)` / `Tools(...)` are **directives: last match wins along the
execution path**, and they apply from where they appear onward. A `Tools(...)`
placed on a shared container offers those tools to *every* prompt in it,
including ones that should be pure text. Scope the directive to the subtree
that needs it:

```js
// ✗  the whole turn is offered the SQL tool
Tree(Tools('sql_query'), Prompt('draft_sql', …), Prompt('summarize', …))

// ✓  only the drafting prompt sees it
Tree(
  Branch(Tree(Tools('sql_query'), Prompt('draft_sql', …))),
  Prompt('summarize', …),
)
```

## Asking a prompt to count, filter, or format

**Symptom:** the model miscounts, mis-sorts, or formats inconsistently; the run
is slow and non-deterministic for no reason.

Prompts are for **reading free text, choosing among ambiguous options, and
writing prose**. Everything else — parse, filter, sort, rank, dedupe, count,
join, format, decide — is code in a callback.

```js
// ✗  a whole model round to pick the first row with no phone
Prompt('pick', (m) => [{ role: 'user', content: `Pick one: ${JSON.stringify(m.rows)}` }])

// ✓  Array.prototype, free and correct
Memory('pick', (m) => m.rows.find((r) => !r.phone) ?? null)
```

See [`authoring.md`](authoring.md) — "Tools fetch; code decides".

## Shadowing a parent slot

**Symptom:** a child "updates" a slot and the parent never sees the change (or
reads a stale value).

`Memory(name, fn)` writes the slot in the **current** scope. From a child, that
creates a *new* slot; the parent's copy is untouched. To reach an owning slot
up the chain, use the update form:

```js
// parent declares:
Memory('page_budget', () => 7)
// child must WRITE the owner's slot:
Memory(update(), 'page_budget', (m) => m.page_budget + 10)   // ✓
// not:
Memory('page_budget', (m) => m.page_budget + 10)             // ✗ a local shadow
```

Symptom in the log: a `record { op: 'memory' }` in the child where you expected
`memoryUpdate`. See [`values-flow.md`](values-flow.md#memory-declare-vs-update).

## Referencing an auto-named child

**Symptom:** `m.branch.X` is `undefined`, or a `Needs('parent#2')` warning at
build time.

Unnamed children get build-time auto-names `${parent}#${k}` and **renumber when
you insert a sibling**. If you read a child's result, give it a name:

```js
// ✗  depends on it being the 2nd prompt
Prompt('…'), Prompt('…')  // then m.branch['x#2']
// ✓
Prompt('outline', '…')    // then m.branch.outline
```

## Gating on a prose prompt without forcing a format

**Symptom:** the branch never runs, even though the model's answer was clearly
"yes".

A `** if …` needs a **boolean**, but a bare `--` prompt has no output
constraint. A small model answers "Yes, it mentions John" and the truthiness
test fails. **Force the format** in the prompt (`Answer ONLY "yes" or "no"`)
and normalize (e.g. `isYes`). See `examples/notation/README.md`, *Known
gotcha*.

## Expecting `Emit` to carry state or pause it

**Symptom:** the conversation log is empty, or the run doesn't wait.

`Emit` is a **side-effect-free leaf** — it fires `onEmit` and continues; it
cannot write a memory slot. If a message must also be remembered, compute the
value once, emit it, and append it to the slot in the same step:

```js
Emit((m) => ({ text: format(m) })),
Memory(update(), 'conversation', (m) => append(m.conversation, format(m))),
```

A pause is `Human(name)`, not an emit.

## Building a parallel module instead of extending the existing subtree

**Symptom:** two trees read the same pages / hit the same tools; the run is
slower and the two drift.

When the data you need is already in hand inside a subtree (a page walk, a loop
that reads records), **extend that subtree** rather than spinning up a sibling
that repeats the work. One pass gets several jobs — a walk that already reads
pages can also read the partners on them.

## Loops with no exit and no cap

**Symptom:** `flow { type: 'exhausted' }`; the loop ran straight to its `max`.

`Until(cond, max(n))` needs a condition that can actually become true — a step
that makes progress. If the body can't change the value the condition reads,
you get `max` iterations and a throw. Prefer a condition over a fixed count,
and keep `max` as the guard, not the plan.

## Patching the `.mjs` without the `.md`

**Symptom:** the sketch and the code disagree; the next translator regenerates
old behavior.

The `.md` notation is the **source of truth**; the `.mjs` is its translation.
Change the sketch first, then regenerate — see [`spec-parity.md`](spec-parity.md)
and [`authoring.md`](authoring.md).

## Over-guarding

**Symptom:** noise like `m.rows ?? []`, `Array.isArray(m.x)`, `|| {}` on every
read.

Slots are initialized by `Memory(...)` or the runtime injection; their shape is
predictable within a tree. Trust it. Guard the *inputs you don't control*, not
your own slots.

## See also

- [`values-flow.md`](values-flow.md) — the model these pitfalls violate.
- [`debugging-a-run.md`](debugging-a-run.md) — the symptoms, in the log.
- [`authoring.md`](authoring.md) — code-first, and the build errors.
