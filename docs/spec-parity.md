# Spec parity: the tree's header comment is the spec

A grandma-kat tree is **one file**. Its leading comment block is the notation
sketch — the spec for its behavior — and the elements below it are the
execution. The rule is simple and non-negotiable:

> **Change the header and the code on the same edit. A tree whose header no
> longer describes the code is a defect, not a note to leave.**

Git is the version history. There is no parallel `.spec.md`, no draft copy,
and no snapshot file: those just create two artifacts that drift.

## What a tree file looks like

```
patterns/<name>.prod.mjs     a pattern (the trunk, reusable trees)
app/<name>/tree.prod.mjs     an app tree
```

Both are single modules whose top comment block carries the notation:

```js
// <name> — one sentence saying what the tree is for.
//
//   !! input
//   ++ conversation: []
//   ()
//   || -- step: …
//   || -> fetch: some_tool
//   ()
//
// (prose about why the tree is shaped this way)

import { Tree, ... } from "grandma-kat";

export default Tree(...);
```

Every `Tree(...)` in the file is built from that block, one element per
notation line, in order.

## The file's header, and the `## Guide` host contract

The comment block is the *behavior*. `## Guide` is not part of the tree file:
it is **caller-facing usage text** in the app's `README.md`, read by hosts that
register trees as tools. Write it for that reader, and nobody else:

- **When to call** — the trigger, in the caller's words.
- **What to pass** — each `Needs(...)` slot and what it means.
- **What to do with the result** — e.g. "relay the returned `text`".
- **Boundaries** — when *not* to call it, or what not to do by hand instead.

Do **not** put the tree's own implementation or authoring philosophy in it. A
line like "write the tree in code, not prompts" is for the tree's prompts and
code, not its caller; in `## Guide` it is noise the caller cannot act on. Do not
restate the short description either. Keep the section short: it rides in the
caller's prompt on every turn.

KAT itself never reads `## Guide` — it is a host convention, honored by hosts
that expose trees as tools and ignored by those that do not.

## The app README, and the tree header

An app carries two documents, and they answer different questions:

- the **tree file's header** — how the tree is built: the notation block, the
  modes, the prompts, the guards. The source of truth for the tree's *behavior*.
- `README.md` — what the app is: its tools, data model, config, run commands,
  and how it is wired into a host. The source of truth for the app *around* the
  tree, plus the caller-facing `## Guide`.

They overlap only where the tree meets the app, and that overlap is where they
rot. The README is **not** a second copy of the tree: reference the header
instead of restating its modes, prompts, steps or guard values. A restated tree
drifts silently — a real one kept describing a `lookup` mode long after the
tree had none, because nothing checks prose the way the header sits beside the
code it describes.

One source of truth per fact: tree facts live in the header, app facts in the
README, and where they touch the README points.

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
| `**` … `***`? | `Branch(when(cond)?, SUBTREE)` — a bare `**` is **unconditional** (`Branch(SUBTREE)`, no `when`); **ends by dedent; a `***` at the opener's depth is an optional explicit closer** |
| `## NAME: path` | import + `Branch(importedTree)` / `From("NAME", …)` |
| `\|\|` | a child of the enclosing block |
| `()` … `() goto NAME until COND (max n)` | `Branch(… Until(goto("NAME"), cond, max(n)))` |
| `<<` / `>>` | `Emit(fn)` / `Human("NAME")` |

A `**` branch ends by **dedent**: at the first line whose `|` depth returns to
the opener's. A `***` written at that depth is an **optional** explicit
closer (like `@@`, a `**` block may omit it). `()` loops keep their
`() goto`/`() until` closer — it carries the loop's data, so it is required.
Single-line branch forms (`--`, `##`) take no closer.

## Translating (the recipe)

1. **One notation line → one element, in order.** The file is
   `Tree(...)` with the elements as arguments, position for position.
2. **Every chunk keeps an inline comment citing its notation line.** The
   file should be readable *without* scrolling back to the header:

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
3. **Expand the bare text.** A `--` prompt's body and a `**` condition (when
   present — a bare `**` has none) are *seeds*: expand them into real
   prompts/conditions, forcing the answer format the rest of the tree depends on
   (see the notation README).
4. **Name only what you reference.** Unnamed subtrees are fine; the runtime
   auto-names and registers them. Name a subtree when the sketch names it or
   the parent reads its result.

## The parity audit

Periodically — and before trusting a tree — check **both directions**, against
concrete markers, not vibes:

**Header → code** (is every notation line implemented?):
- For each `!!`, `++`, `--`, `->`, `#->`, `@@`, `**`, `()`, `<<`, `>>` line, is
  there a corresponding element in the file (find its inline comment)?
- Does every `**` branch end at the right `|` depth (by dedent, or at an explicit `***`)?

**Code → header** (is every code step in the sketch?):
- Walk the elements; each should name a notation line in its comment. Any
  element with no sketch line is **code ahead of the spec**.
- Any slot written in code but not declared (`++`) in the sketch is a gap.

**Then close the gap in one pass.** Enumerate honestly — including places where
the *code* is right and the *header* is stale — then update them in the same
edit, and re-run the audit. A gap you can name is a to-do; a gap you paper over
becomes a lie.

## A checklist you can run

- [ ] The header's first line matches the exported tree name and the file's location.
- [ ] Element order matches the notation order (including `Needs` at the top).
- [ ] Every `**` ends at its opener's depth (dedent, or an optional `***`); every `()` has its `() goto … until …`.
- [ ] Declared slots (`++`) vs updated slots (`++` / `++!`) match `Memory(name, …)`
      vs `Memory(update(), name, …)` in the code.
- [ ] Every `** if COND` maps to a `when(cond)` on the same element; a bare `**` maps to `Branch(SUBTREE)` with no `when`.
- [ ] Every `m.branch.X` / `Needs("X")` in code has a named `X` in the sketch.
- [ ] Every element cites a notation line (no orphan code).
- [ ] The header still describes the code you just changed.

## Where this is enforced

KAT cannot enforce it — the header is a comment. This workspace's convention
*does*: the taste file treats a stale doc as a defect to fix, not a note to
leave, and a spec that has drifted behind the code is closed up in the same
change that touched the code. The BOB harness's `scripts/spec-lint.ts` reads the
header of every `*.prod.mjs` tree.

## See also

- [`../examples/notation/README.md`](../examples/notation/README.md) — the
  authoritative notation spec and the translation rules.
- [`../examples/notation/notation.md`](../examples/notation/notation.md) — a
  worked line→element example.
