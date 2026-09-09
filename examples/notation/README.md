# Line notation for grandma-kat trees

A tiny, line-oriented way to sketch a grandma-kat tree before (or instead of)
writing the builder chain by hand. Each **line** is one **chunk** of the tree —
a single leaf, or (in the case of a branch) a node whose children are the
indented lines that follow it.

This notation is a *plan*, not a compiler. It trades away the JS builder's
full power for one thing: you can read the whole control flow top-to-bottom
in a text file, and a human (or an LLM) can translate it into a `Tree`
without tracking method boundaries.

## The five symbols

| Symbol | Example | Means | Maps to (builder) | Text rule |
|---|---|---|---|---|
| `++` | `++ memory: mem_global` | declare a memory slot / session seed | runtime `memory:` seed or `.memory(name, fn)` | name literal; value is data |
| `<<` | `<< output_msg: "Hi"` | non-blocking output | `.emit(m => ({ text: ... }))` | `"..."` verbatim |
| `>>` | `>> human: input_1` | pause, ask the human for input | `.human("input_1")` | slot name literal |
| `--` | `-- prompt: does X ...?` | ask the model | a named `.branch()` wrapping `.prompt()` | text **expanded** into a full prompt |
| `**` | `** branch: if X is true, run:` | conditional subtree | `.branch(when(cond), Tree.name(...))` | condition text **expanded** |
| `\|\|` | `\|\| prompt: ...` | child of the `**`/branch above | whatever the indented kind says | — |

## The four rules

### 1. One line = one chunk

A chunk is either a single builder method call, or a `**` branch node plus its
children. Multiple builder calls that conceptually do one thing can live in
one chunk, but the notation keeps it to one line for readability.

### 2. Lines reference each other by name

A `--` prompt or `**` condition can refer to the result of an earlier chunk by
its **slot name** — the name after `>>`, `++`, or the branch name the
translator gives a `--` prompt. Example: `** branch: if above is true` means
"the `--` prompt on the line just above returned yes". The translator binds
that forward-looking reference to the concrete slot (`m.branch.scan_input`).

### 3. `"..."` is literal; bare text is expanded

Text inside double quotes is emitted or used **verbatim**. Bare text (the
body of a `--` prompt, or a `**` condition) is a *seed*: the translator
expands it into the real prompt/condition using the tree's context — adding a
system prompt, injecting the referenced memory, and (critically for `--`)
forcing the answer format the rest of the tree depends on.

### 4. Nesting is the `|` prefix

Indentation is expressed as a `|`-prefix on the start of the line, not
whitespace. One `|` = one level deep, two `|||` = two, etc. A `**` branch
`run:` line opens a level; every following `||` line is a child of it.

```
-- prompt: is X a person?          (level 0)
** branch: if yes, run:            (level 0, opens level 1)
|| prompt: what info about X?      (level 1 — child of the branch)
```

## Translating this notation (for the translator / LLM author)

- `++ memory: NAME` → seed the **root scope** with `memory: { NAME: value }`
  in the runtime, or (inside a loop that needs to accumulate) a
  `.memory('NAME', ...)` write at the level where the value must persist.
- `<< label: "TEXT"` → `.emit(m => ({ text: "TEXT" }))`. The quoted string is
  the verbatim `text`. (grandma-kat's `.emit` fires `onEmit` and does not
  pause.)
- `>> human: NAME` → `.human("NAME")`. The reply is read back as
  `m.branch.NAME`.
- `-- prompt: BODY` → a **named branch wrapping a `.prompt()`**, so the result
  is referenceable by name (`m.branch.<name>`). Do not leave it anonymous:
  auto-names (`#1`) shift, and the notation references results *by name*. The
  BODY is expanded into `[{ system }, { user: <referenced memory + BODY + a
  strict answer-format instruction> }]`.
- `** branch: if COND run:` → `.branch(when(m => EXPAND(COND)), SUBTREE)`.
  The COND is expanded into a predicate over the referenced slot. If COND
  says "above is true", bind it to the preceding `--` prompt's named result
  and normalize with a helper like `isYes`.
- `|| KIND ...` → a child of the enclosing branch, at the matching depth.

## Known gotcha this notation forces you to face

A bare `--` prompt has **no output constraint**, but a `** if above is true`
decision needs a boolean. The translator **must** add a strict answer-format
instruction to the `--` prompt (e.g. `Answer ONLY "yes" or "no"`) and a
normalizer (e.g. `isYes`) on the condition — otherwise a small model's prose
answer ("Yes, it mentions John Doe") fails the `yes/no` test and the branch
silently never runs. See the `person-scan` example for the concrete fix.
