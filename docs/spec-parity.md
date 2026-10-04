# Spec parity: the `.md` is the source of truth

A grandma-kat tree is authored **twice**: as a `.md` notation sketch (the
source of truth for *behavior*) and as the `.mjs` translation (the source of
truth for *execution*). The rule is simple and non-negotiable:

> **When the spec changes, change the `.md` first, then regenerate the `.mjs`
> from it — never hand-patch the code and leave the sketch behind.**

A `.mjs` with a `.md` beside it is a *translation*, not an original. Editing
the `.mjs` alone is how the two drift until neither can be trusted.

## What a paired file looks like

```
app/<name>/
  tree.spec.md # the notation sketch — behavior
  tree.mjs     # the translation — execution, with inline comments citing the spec
```

A pattern names the same pair with the tree: `patterns/<name>.spec.md` beside
`patterns/<name>.mjs`.

The `.md` carries a fenced block whose first line names the tree and its file:

````text
```text
## caller-list: app/caller-list/tree.mjs
!! input
...
```
````

Every `Tree(...)` in the `.mjs` is built from that block, one element per
notation line, in order. The `.mjs` header says so:

```js
// Generated from tree.spec.md, the source of truth for this tree's behavior.
```

## The file's prose, and the `## Guide` host contract

The fenced block is the *behavior*. The rest of the `.md` is prose about the
tree — `## The flow`, `## Requirements`, and so on — for humans and for the
authoring LLM. One prose section is a contract with the **host**: `## Guide`.

```md
## Guide

To send an email, call this tree with the request. …
After a send, relay the returned `text` — and nothing else.
```

`## Guide` is **caller-facing usage text**: the host reads it into the guidance
it gives the model that decides whether and how to call this tree as a tool
(a host that registers trees as tools — the BOB harness — parses the section and
injects it as tool guidance). Write it for that reader, and nobody else:

- **When to call** — the trigger, in the caller's words.
- **What to pass** — each `Needs(...)` slot and what it means.
- **What to do with the result** — e.g. "relay the returned `text`".
- **Boundaries** — when *not* to call it, or what not to do by hand instead.

Do **not** put the tree's own implementation or authoring philosophy in it. A
line like "write the tree in code, not prompts" is for the tree's prompts and
code, not its caller; in `## Guide` it is noise the caller cannot act on. A host
may derive the tool's short description from elsewhere in the file (the BOB
harness uses the first prose paragraph), so don't restate it here. Keep the
section short: it rides in the caller's prompt on every turn.

KAT itself never reads `## Guide` — it is a host convention, honored by hosts
that expose trees as tools and ignored by those that do not.

## The notation, in one breath

The symbols are defined once, authoritatively, in
[`../examples/notation/README.md`](../examples/notation/README.md). Do not
re-document them here — the short map:

| Notation | Element |
|---|---|
| `!! NAME` | `Needs("NAME")` |
| `++ NAME` / `++! NAME` | `Memory("NAME", fn)` / `Memory(update(), "NAME", fn)` |
| `-- prompt:` | `Branch(Tree(name(…), Prompt(…)))` |
| `-> NAME: TOOL` | `Call("NAME", "TOOL", argsFn)` |
| `#-> NAME: "desc"` | `Register("NAME", "desc", fn, calls(…), parameters(…))` |
| `?? check:` | `Check(fn, goto("NAME", max(k)))` |
| `@@ NAME: array` | `Each("NAME", m => m.array, SUBTREE)` |
| `**` … `***` | `Branch(when(cond)?, SUBTREE)` — **closed by `***` at the opener's depth** |
| `## NAME: path` | import + `Branch(importedTree)` / `From("NAME", …)` |
| `\|\|` | a child of the enclosing block |
| `()` … `() goto NAME until COND (max n)` | `Branch(… Until(goto("NAME"), cond, max(n)))` |
| `<<` / `>>` | `Emit(fn)` / `Human("NAME")` |

The **`***` closer** is new: a `**` branch ends at the `***` written at the
same `|` depth as its opener. `()` loops keep their `() goto`/`() until`
closer. Single-line branch forms (`--`, `##`) take no closer.

## Translating (the recipe)

1. **One notation line → one element, in order.** The `.mjs` is
   `Tree(...)` with the elements as arguments, position for position.
2. **Every chunk keeps an inline comment citing its notation line.** The
   generated `.mjs` should be readable *without* the `.md`:

   ```js
   //   ** if the batch has rows
   , Branch(
       when((m) => (m.batch_rows ?? []).length > 0),
       Tree(
         //   @@ upsert_rows: batch_rows
         Each("upsert_rows", (m) => m.batch_rows, Tree(
           //   -> save_row: upsert_contact one row …
           Call("save_row", "upsert_contact", (m) => rowArgs(m)),
         )),
       ),
     )
   ```
3. **Expand the bare text.** A `--` prompt's body and a `**` condition are
   *seeds*: expand them into real prompts/conditions, forcing the answer format
   the rest of the tree depends on (see the notation README).
4. **Name only what you reference.** Unnamed subtrees are fine; the runtime
   auto-names and registers them. Name a subtree when the sketch names it or
   the parent reads its result.
5. **Keep the header comment** saying the file is generated from its `.md`.

## The parity audit

Periodically — and before trusting a tree — check **both directions**, against
concrete markers, not vibes:

**Spec → code** (is every notation line implemented?):
- For each `## <name>: <path>` header, does the file exist and export that tree?
- For each `!!`, `++`, `--`, `->`, `#->`, `@@`, `**`, `()`, `<<`, `>>` line, is
  there a corresponding element in the `.mjs` (find its inline comment)?
- For each `**` is there a matching `***` at the right depth in the sketch?

**Code → spec** (is every code step in the sketch?):
- Walk the `.mjs` elements; each should name a notation line in its comment.
  Any element with no sketch line is **code ahead of the spec**.
- Any slot written in code but not declared (`++`) in the sketch is a gap.

**Then close the gap in one pass.** Enumerate honestly — including places where
the *code* is right and the *sketch* is stale — then update the `.md` (usually)
or the `.mjs`, and re-run the audit. A gap you can name is a to-do; a gap you
paper over becomes a lie.

## A checklist you can run

- [ ] `## <name>: <path>` header matches the file and the exported tree name.
- [ ] Element order matches the notation order (including `Needs` at the top).
- [ ] Every `**` has a `***`; every `()` has its `() goto … until …`.
- [ ] Declared slots (`++`) vs updated slots (`++` / `++!`) match `Memory(name, …)`
      vs `Memory(update(), name, …)` in the code.
- [ ] Every `** if COND` maps to a `when(cond)` on the same element.
- [ ] Every `m.branch.X` / `Needs("X")` in code has a named `X` in the sketch.
- [ ] Every `.mjs` element cites a notation line (no orphan code).
- [ ] The header comment still says "generated from `<file>.md`".

## Where this is enforced

KAT cannot enforce it — the `.md` is prose. This workspace's convention *does*:
the taste file treats a stale doc as a defect to fix, not a note to leave, and a
spec that has drifted behind the code is closed up in the same change that
touched the code.

## See also

- [`../examples/notation/README.md`](../examples/notation/README.md) — the
  authoritative notation spec and the translation rules.
- [`../examples/notation/notation.md`](../examples/notation/notation.md) — a
  worked line→element example.
- [`pitfalls.md`](pitfalls.md#patching-the-mjs-without-the-md) — the drift this
  page prevents.
