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

`Model(...)` is **positional: it applies from where it appears until the next
`Model()`** in that tree. A later `Model()` does not retroactively change an
earlier prompt. `Tools(...)` is **last-match-wins along the execution path**
and also applies from where it appears onward; a `Tools(...)` placed on a
shared container offers those tools to *every* prompt in it, including ones
that should be pure text. Scope the directive to the subtree that needs it:

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

Prompts are for **decisions and semantic lookups** (which record / page / link
is meant, what the text means), ambiguous choices, and prose. Counting,
filtering by a known predicate, sorting, formatting, dedupe, validation and
verification are code in a callback. Do not ask a prompt to count or format;
do not encode a semantic lookup as a matcher.

```js
// ✗  a whole model round to pick the first row with no phone
Prompt('pick', (m) => [{ role: 'user', content: `Pick one: ${JSON.stringify(m.rows)}` }])

// ✓  Array.prototype, free and correct — a mechanical filter
Memory('pick', (m) => m.rows.find((r) => !r.phone) ?? null)
```

See [`authoring.md`](authoring.md) — "The model decides; code verifies".

## Trusting a prompt instruction to hold an invariant

**Symptom:** a rule the prompt states flatly — "never repeat a zero-match
query", "never write without a plan" — is violated anyway, and the wrong result
ships.

A prompt **steers**; it does not **guard**. Prose lowers the odds of a bad move,
but for anything that must *never* happen, enforce it in code: detect the
offending state and rewind (or reject) with the reason, the way a self-healing
`Check`+`goto` does.

```js
// ✗  the rule lives only in the system prompt; the model repeats it anyway
`…If a PREVIOUS selection matched ZERO, never repeat that statement.`

// ✓  the same rule as a guard: a repeated statement is an error that rewinds
Check((m) => !repeatsZero(m) || (m.round ?? 0) >= ROUNDS, goto('draft', max(ROUNDS)))
```

## Letting a write tool guess its record

**Symptom:** re-running a save creates a second contact, or an "email match"
renames the wrong person. The tool looked helpful by matching id → email → name.

A write tool should update the **id** it is given, or create with an explicit
`create: true`. Resolution belongs to the caller: read the candidates, let the
model pick (see below), then pass the id. Matching inside the tool hides the
decision — and a company name is the worst key: "Acme", "Acme Ltd." and "Acme
Corporation" are the same company; a legal suffix or a trade name defeats exact
match on the first try. Key companies on their website / registrable domain,
then distinctive name tokens, and keep the stored name.

The tool still **verifies** the write: the id exists, the target is not the row
itself, an email already stored on another contact is refused, `create: true`
is explicit.

## Promising behavior the tool does not implement

**Symptom:** the prompt says "match by exact name, then by its website"; the
tool only matches name/email; the model follows the prompt, no match happens,
and a duplicate is created.

The prompt and the tool are one contract. Describe only behavior the tool
implements — or, if the model is meant to do a read first, say that and give it
the read tool. Test the boundary: a name variant, a missing website, an
ambiguous match.

## Encoding a semantic lookup as a deterministic matcher

**Symptom:** a hand-written matcher, fuzzy-name score, or growing rule table
tries to cover "Acme" vs "Acme Ltd.", "Jon" vs "John", a page title vs a nav
label — and still guesses wrong.

Decisions and semantic lookups are model work: hand the model the candidates
(or a read tool) and an output schema; let it choose. Keep code for verifying
the choice (the id exists, the domain matches, the total adds up) and for
mechanical filters ("rows with no phone"). A deterministic function is excellent
at checking a decision and terrible at making one.

## Hard-coding a natural-language allowlist

**Symptom:** a legal user reply is classified as "not clear" because a `Set` of
expected phrases ("yes", "ok", "go ahead", …) missed the one they typed —
"go on then", "yeah do that", "affirmative". Adding the missing phrase fixes
that report and leaves the next one broken.

Classifying prose is model judgement, not enumeration. An allowlist can never
cover paraphrase, register, locale, typos, punctuation, or multi-clause replies,
and every miss is a silent, arbitrary-looking misclassification. It also freezes
the vocabulary into code, far from the prompt that needs it.

```js
// ✗  code pretends to decide what "agreement" means
const BARE_AFFIRMATIONS = new Set(["yes", "ok", "go ahead", ...])
const isAffirmation = (text) => BARE_AFFIRMATIONS.has(normalize(text))
```

```js
// ✓  give the model the utterance and the context; state the rule once
// system: A bare affirmation inherits the action offered in the immediately
//         preceding assistant message. Do not widen beyond that offer.
// user:   Immediately preceding assistant message: "… Say go and I'll do it."
//         User request (verbatim): "go on then"
```

Keep code for **verification**: the selected action matches the offer, the
provenance quote is verbatim, the write went through. Do not keep it for
deciding whether a phrase belongs to a semantic category. See
[`authoring.md`](authoring.md) — "The model decides; code verifies".

## Static policy embedded in a per-run message

**Symptom:** the invariant instructions, the output schema, and the per-run
payload share one user message, so a prefix cache never hits.

Put the invariant contract — tool semantics, output schema, allowed actions —
in the **system** message, byte-identical across runs. Put the per-run material
(one JSON record, one page, one query) in the **user** message. The stable
prefix is the cache; the variable suffix is the work.

## A receipt that claims a write that didn't land

**Symptom:** "Saved / Noted / Linked" is emitted even though the write was
skipped or failed; the caller re-reads the database to find out.

Compose every receipt from the tool result, or say it failed. If a save was
skipped because a required value was missing (no company name, no target id),
emit that. A success-shaped summary that hides a no-op is worse than an error.

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

## Reading a value produced inside a child branch

**Symptom:** a slot read from the parent is `undefined` (or a stale earlier
value), and a downstream gate silently takes the wrong path.

`m.branch.X` resolves **upward** — current scope, then parent, to the root — and
a completed branch stores its result in its *parent's* memory. It does **not**
reach down: a value a `Call`/`Memory` produced *inside* a child subtree is not
in the parent's `m.branch`. Capture it where the parent can see it — declare the
slot at the owning scope and `Memory(update(), …)` it from the child — or read it
inside the child.

```js
// the child subtree runs Call('count', …)
// ✗  parent: m.branch.count is undefined
// ✓  child:  Memory(update(), 'count', (m) => countOf(m.branch.count))
//    parent: Memory('count', () => null)   → read m.count
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

## The same facts inlined in two prompts

**Symptom:** one prompt behaves as if the data changed — it filters on a field
that never existed and matches nothing — while a sibling prompt that "knows the
same thing" works fine.

When two prompts must agree on a body of facts (a schema, how records are
stored, a set of rules), inlining the text in both is drift waiting to happen:
you fix the copy in front of you, and the other silently rots. Extract **one**
constant and interpolate it into every prompt that needs it.

```js
// ✗  two hand-typed copies; the one you didn't touch goes stale
Prompt('draft_query',     () => [{ role: 'system', content: SCHEMA }])
Prompt('draft_selection', () => [{ role: 'system', content: SCHEMA }])

// ✓  one source, interpolated
const STORAGE_RULES = `…`
Prompt('draft_query',     () => [{ role: 'system', content: `…${STORAGE_RULES}` }])
Prompt('draft_selection', () => [{ role: 'system', content: `…${STORAGE_RULES}` }])
```

The loops may differ; the facts must not.

## Loops with no exit and no cap

**Symptom:** `flow { type: 'exhausted' }`; the loop ran straight to its `max`.

`Until(cond, max(n))` needs a condition that can actually become true — a step
that makes progress. If the body can't change the value the condition reads,
you get `max` iterations and a throw. Prefer a condition over a fixed count,
and keep `max` as the guard, not the plan.

## Patching the code without its header

**Symptom:** the tree's header and its elements disagree; the next reader (or
translator) regenerates old behavior.

The header comment is the **spec**, and the code sits directly below it. Change
them together — see [`spec-parity.md`](spec-parity.md) and
[`authoring.md`](authoring.md).

## Over-guarding

**Symptom:** noise like `m.rows ?? []`, `Array.isArray(m.x)`, `|| {}` on every
read.

Slots are initialized by `Memory(...)` or the runtime injection; their shape is
predictable within a tree. Trust it. Guard the *inputs you don't control*, not
your own slots.

## A name-referenced tree that was never imported

**Symptom:** `tree 'X' is not registered and loadTree did not provide it`,
thrown *mid-run* — at the first hook fire or `From(...)`, never at build time.

`Hook(onEmit(), 'goal_on_emit')` and `From('trunk_turn')` reference their tree
by **string**. A named `Tree(name('goal_on_emit'), …)` self-registers in KAT's
build-time registry only when its defining module is **evaluated** — importing
it for any reason is enough. If nothing imports the module and the host's
`loadTree` cannot resolve the name, the reference fails the first time it is
used, because references resolve lazily.

Check it directly: `Tree.has('goal_on_emit')` is `false` before the module is
imported and `true` after.

Fixes, in order of preference:

1. Make the **host import the defining module** (its pinned prod, when one
   exists) so the names self-register — the same way `trunk_step.mjs` is
   imported to make `trunk_turn` resolvable.
2. Provide `runtime.loadTree(name)` that maps the name to its module.
3. Last resort: import the module **for its side effect** from the tree that
   references it. This couples a pinned tree to whatever version gets imported,
   so prefer 1 or 2 when pinning matters.

**Discovery gotcha.** A host that derives a pattern's name from its first
comment line must see `// <name>.mjs — description`. A directory prefix
(`// patterns/<name>.mjs — …`) yields a name containing `/`, which name-safety
filters reject — so the file is **silently skipped and never imported**. That is
one common way a needed module goes unloaded and the error above appears.

## See also

- [`values-flow.md`](values-flow.md) — the model these pitfalls violate.
- [`debugging-a-run.md`](debugging-a-run.md) — the symptoms, in the log.
- [`authoring.md`](authoring.md) — code-first, and the build errors.
