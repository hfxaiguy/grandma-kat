# Line notation for grandma-kat trees

A tiny, line-oriented way to sketch a grandma-kat tree before (or instead of)
writing the builder chain by hand. Each **line** is one **chunk** of the tree —
a single leaf, or (in the case of a branch) a node whose children are the
indented lines that follow it.

This notation is a *plan*, not a compiler. It trades away the JS builder's
full power for one thing: you can read the whole control flow top-to-bottom
in a text file, and a human (or an LLM) can translate it into a `Tree`
without tracking method boundaries.

## The symbols

| Symbol | Example | Means | Maps to (builder) | Text rule |
|---|---|---|---|---|
| `++` | `++ memory: mem_global` | declare a memory slot / session seed | runtime `memory:` seed or `.memory(name, fn)` | name literal; value is data |
| `<<` | `<< output_msg: "Hi"` | non-blocking output | `.emit(m => ({ text: ... }))` | `"..."` verbatim |
| `>>` | `>> human: input_1` | pause, ask the human for input | `.human("input_1")` | slot name literal |
| `!!` | `!! input` | require a memory slot (declared input) | `.needs("input")` | name literal; slot must be seeded by the caller |
| `--` | `-- prompt: does X ...?` | ask the model | a named `.branch()` wrapping `.prompt()` | text **expanded** into a full prompt |
| `**` | `** branch: if X is true, run:` or `**` | conditional or unconditional subtree | `.branch(when(cond), Tree.name(...))` or `.branch(Tree.name(...))` | condition text **expanded** when present |
| `\|\|` | `\|\| prompt: ...` | child of the `**`/`()` block above | whatever the indented kind says | — |
| `()` | `()` … `()` | loop — repeat the enclosed body | a named `.branch()` whose trailing `.until(cond, max)` rewinds to the branch top | the closing `()` carries the exit condition |

## The four rules

### 1. One line = one chunk

A chunk is either a single builder method call, or a `**` branch node plus its
children. Multiple builder calls that conceptually do one thing can live in
one chunk, but the notation keeps it to one line for readability.

### 2. Lines reference each other by name

A `--` prompt or `**` condition can refer to the result of an earlier chunk by
its **slot name** — the name after `>>`, `++`, or the branch name the
translator gives a `--` prompt. Any branch, prompt, grouping block, or loop
without an explicit name receives a stable translator-generated name; explicit
names always win. Example: `** branch: if above is true` means
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
`run:` line or an opening `()` opens a level; every following `||` line is a
child of it.

```
-- prompt: is X a person?          (level 0)
** branch: if yes, run:            (level 0, opens level 1)
|| prompt: what info about X?      (level 1 — child of the branch)
```

A bare `**` opens an unconditional grouping level. A `()` loop opens a level
too; the body is the `||` lines between the opening
`()` and the closing `()`:

```
()                                 (level 0, opens level 1)
|| -- use the tool for each ...    (level 1 — loop body)
|| << emit the update output       (level 1 — loop body)
() until there are no more tool calls left   (level 0, closes the loop)
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
- `!! NAME` → `.needs("NAME")`. The tree declares the slot as a required input:
  knitting without it seeded in `runtime.memory` throws. Unlike `>>`, no pause
  happens — the value must already be present.
- `-- prompt: BODY` → a **named branch wrapping a `.prompt()`**, so the result
  is referenceable by name (`m.branch.<name>`). If no name is written, assign
  a stable translator-generated name. The BODY is expanded into
  `[{ system }, { user: <referenced memory + BODY + a strict answer-format
  instruction> }]`.
- `** branch: if COND run:` → `.branch(when(m => EXPAND(COND)), SUBTREE)`.
  The COND is expanded into a predicate over the referenced slot. If COND
  says "above is true", bind it to the preceding `--` prompt's named result
  and normalize with a helper like `isYes`.
- Bare `**` → an unconditional named grouping branch. Assign a stable
  translator-generated name when none is written, then translate it as
  `.branch(Tree.name("<name>").branch(SUBTREE))`.
- `|| KIND ...` → a child of the enclosing branch, at the matching depth.
- `()` … `()` → a **named branch containing a loop**. The opening `()` becomes
  `.branch(Tree.name("<name>"))`; assign a stable generated name if the loop
  has no explicit name. The `||` body runs once per pass; the closing
  `()` becomes a trailing `.until(cond, max(...))` that rewinds to the branch
  top while the condition fails. The closing `()`'s text ("until there are no
  more tool calls left") is the condition, expanded into a predicate — for a
  tool-calling loop that's `!m.raw.branch.main_prompt?.toolCalls?.length`,
  bounded by `max(12)`. Children placed **after** the `.until()` (i.e. after
  the closing `()`) run exactly once, when the loop exits.

## Known gotcha this notation forces you to face

A bare `--` prompt has **no output constraint**, but a `** if above is true`
decision needs a boolean. The translator **must** add a strict answer-format
instruction to the `--` prompt (e.g. `Answer ONLY "yes" or "no"`) and a
normalizer (e.g. `isYes`) on the condition — otherwise a small model's prose
answer ("Yes, it mentions John Doe") fails the `yes/no` test and the branch
silently never runs. See the `person-scan` example for the concrete fix.
