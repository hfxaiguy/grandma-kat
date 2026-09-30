# Grandma-KAT: element surface over a record IR — notation first

> Status: **Phases 1–2 landed on this branch (`element-surface`)** — the record
> IR, the element surface, and the notation spec are in; `npm test` is
> 162/162 green. Phases 3–4 (host protocol, app conversion) are not started.
> Working copy of this plan lives at
> `~/.commandcode/plans/grandma-kat-elements-prototype.md` (openable via
> `/plans`).

## Decisions locked in this conversation

- **Surface**: element literal —
  `Tree(name("x"), Model("strong"), Prompt(...), Register(...), Branch(...), Until(...))`.
  Markers ride inside elements: `when(cond)`, `max(n)`, `calls(...)`,
  `parameters(...)`, `toolHookBefore/After(...)`, `update()`. Condition is
  always explicit (`when(cond)`); argless `when()` is rejected — no implicit
  default gate.
- **`Model("strong")` is a positioned directive element** — model rules apply
  from where they appear (gateable, last match wins up the execution path),
  never a tree header.
- **Records are the canonical IR**: one validation/construction path. The
  chain becomes a compatibility front-end that keeps only its positional
  grammar; record shapes are unchanged, so def JSON — and therefore
  definition ids and host session hashes — must not churn. (Lowering elements
  onto chain methods is explicitly rejected: it re-enters the grammar it
  abolishes and blocks ever deleting the chain.)
- **Direct export**: trees become `export default Tree(...)` importing KAT by
  bare specifier. Workspace resolution via a root `package.json` `file:`
  dependency — one `node_modules` symlink, so loader and trees share **one KAT
  instance** (markers/builder are instance-branded Symbols; two instances
  fail loudly).
- **Notation first**: the `#->` spec is updated before any app tree converts.
- Prototype stays inside KAT; app conversion only after the spec and shape
  freeze.

## Phase 1 — Notation spec (the gate)

`grandma-kat/examples/notation/README.md`:

- Add the element translation section: each chunk kind maps to an element with
  the same field vocabulary the records use (`name`, `description`,
  `calls(...)`, `parameters(...)`, `when(cond)`, `max(n)`, `update()`), so the
  translator knows field names, not positional grammar.
- State the record model's three member classes the notation already implies:
  declarations (`++`, `#->`), steps, and directives (`Model`/`Tools`).
- Update the `## NAME: PATH` rule for direct export: import its default tree
  and `.branch` it; the factory form remains the dependency-free fallback.
- Keep the `<<` buttons section as is.

Deliverable: reviewed spec text; no code changes yet.

## Phase 2 — KAT: record IR + element form (prototype)

Files: `src/records.mjs` (new), `src/tree.mjs`, `src/index.mjs`,
`tests/elements.test.mjs` (new).

- `records.mjs`: field-validating constructors returning the exact current
  child shapes — steps `Prompt, Register, Memory, Human, Emit, Call, Check,
  Branch, Each, Return, Until`; directives `name, Model, Tools, Needs`.
- `tree.mjs`: extract each chain method's parse/validate into the record
  constructors (same error strings, same def shape, `registers` carve-out and
  copy-on-write untouched). Chain methods shrink to grammar → record → append.
  `Tree` becomes callable: `Tree(...elements)` applies each in order — steps
  push children, directives patch def arrays, `Model` stays in `d.models`
  with its gate.
- `index.mjs`: export the element constructors.
- `tests/elements.test.mjs`: chain-built and element-built trees compare
  structurally identical (comparator: non-function fields deep-equal,
  functions by **reference identity** — `JSON.stringify` alone is not enough);
  one behavioral knit of an element-built mini-tree. Existing suites must
  pass unchanged.

## Phase 3 — Host protocol + resolution

- `grandma-workspace/package.json` (new): `"grandma-kat":
  "file:/home/love/Documents/Code/grandma-kat"` + install; switch KAT imports
  (tests first) to bare `grandma-kat`.
- `grandpa-bob-bot/src/pattern-loader.ts`: accept a built default —
  `typeof mod.default === "function" ? mod.default(ctx) : mod.default` — and
  add the missing `update`, `calls`, `parameters` to `ctx`/`PatternContext`
  so factory-form trees aren't stale.
- `AGENTS.md` (KAT and workspace): write down the single-instance rule — every
  KAT import must resolve to the same real path.

## Phase 4 — App tree conversion (only after review)

One tree at a time, each landing with its suite green:
`app/caller-list/tree.mjs` → element form + `export default Tree(...)`, then
`app/contacts/tree.mjs`, then `patterns/trunk.mjs`. Factory-form trees keep
working throughout.

## Non-goals

- No `knit.mjs` semantic changes; no notation compiler (tagged-template /
  source-of-truth option) in this pass; the chain is not deleted.

## Verification

```sh
cd /home/love/Documents/Code/grandma-kat && node --test tests/
cd /home/love/grandma-workspace/app/caller-list && node --test
cd ../contacts && node --test
cd /home/love/grandma-workspace && node --test patterns/trunk.test.mjs
cd /home/love/Documents/Code/grandpa-bob-bot && npm run typecheck && npm run test:trees
```

- The KAT def-equality test is the go/no-go for the IR extraction; a failed
  comparison means the two front-ends silently diverge.
- Loader smoke: knitting one app tree through `pattern-loader` covers the
  non-function default path.
