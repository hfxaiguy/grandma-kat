# `person-scan` — the worked example

The same tree, first in the line notation, then translated to the JS element
form. This file shows line → chunk → the element it becomes and why.

## In the notation

```text
++ memory: mem_global
<< output_msg: "Hi. This is grandpa-bob"
>> human: input_1
-- prompt: does `input_1` contain information about a person
** branch: if above is true, run:
|| prompt: how many people and what kind of information is present in `input_1`
```

## Line-by-line translation

| Line | Chunk | Element | Notes |
|---|---|---|---|
| `++ memory: mem_global` | root session seed | runtime `memory: { mem_global }` | No value here, so it's seeded by the caller, not written in-tree. |
| `<< output_msg: "..."` | emit greeting | `Emit(m => ({ text: "Hi. This is grandpa-bob" }))` | Quoted → verbatim `text`. |
| `>> human: input_1` | pause | `Human("input_1")` | Reply read as `m.branch.input_1`. |
| `-- prompt: ...` | detect person | `Branch(Tree(name("scan_input"), Prompt(...)))` | Named branch so `**` can reference it; prompt expanded to force `yes/no`. |
| `** branch: if above is true` | gated branch | `Branch(when(m => isYes(m.branch.scan_input)), Tree(name("summarize_people"), …))` | "above" binds to `scan_input`. |
| `\|\| prompt: ...` | summarize | inner `Prompt(...)` | Child of `summarize_people`. |

## The translation decisions, spelled out

1. **`<<` is `Emit(...)`, not a tool call.** `output_msg` reads as grandma-kat's
   non-blocking output channel: fire `onEmit`, keep going. The quoted string
   is the whole `text`.

2. **`--` becomes a named branch, not a bare `Prompt(...)`.** The notation
   refers to results *by name*, and a top-level `Prompt(...)` is anonymous
   (`#1`). Wrapping it in `Tree(name("scan_input"), …)` gives the result a stable
   name the `**` condition can use.

3. **The `--` prompt is expanded, not literal.** The seed "does `input_1`
   contain information about a person" becomes a two-message prompt with a
   system role, the injected `input_1`, AND a `Answer ONLY "yes" or "no"`
   instruction — because the `**` condition needs a clean boolean.

4. **`if above is true` is normalized.** It binds to `scan_input`'s result and
   runs through `isYes`, a `/^\s*yes\b/i` helper, so "Yes, it mentions John"
   and "YES" both count. If the model says anything else, the branch is
   skipped silently (a branch whose gate is false just doesn't run).

5. **`mem_global` is a root seed, not a tree step.** It has no value in the
   example and nothing reads it, so it belongs in the runner's `memory:`
   argument — shown in the runner, absent from the self-contained tree.
