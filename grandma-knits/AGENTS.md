# Grandma KAT

**Grandma Knits Agent Trees** ("Grandma KAT" for short) — LLM/Threads
tooling: a factory-builder library for composing LLM execution units
("Steps") with nesting, memory, and reuse.

**Status: design phase.** This document captures design decisions and
considerations. Nothing is implemented yet.

## Packaging

- Standalone JS subpackage: ES modules, own `package.json`, own
  `node_modules/` — same pattern as `browser-mcp/`.
- Package name: `grandma-kat` (full name: "Grandma Knits Agent Trees").

## Core Design: Step Factory

- The basic unit is a `Step`. Steps chain together; steps can have substeps.
- `Step` is a **factory**: chained builder methods define the step; the
  output is a function (the executable step).

```js
Step
  .name('step_id')                                  // register into a global registry for reuse
  .step(Step.name('navigate').prompt(...))          // attach a substep
  .prompt(memory => `current memory: ${memory.step.navigate}`)
```

- `.name(id)` — names the step into a global registry so it can be reused
- `.step(child)` — attaches a substep (composition/nesting)
- `.prompt(fn)` — defines the LLM prompt; `fn` receives memory and returns
  the prompt string
- Memory is keyed by step name (`memory.step.navigate`) — a parent step
  reads what its substeps produced (see Memory Model below)

### API style: substeps as arguments (chosen)

```js
Step.name('a').step(Step.name('b').prompt(...))
```

Rejected alternative — substeps as chained blocks:

```js
Step.name('a').step.runif(cond).prompt().step ...
```

Reasons:

- Nesting is unambiguous — parentheses make the hierarchy explicit.
- Reuse is natural — assign a step to a variable, drop it into multiple
  parents.
- The chained-block style can't distinguish sibling vs nested substeps
  without an `.end()` / `.back()` mechanism, which gets ugly.

### Conditions (proposed, unconfirmed)

`.runif(cond)` lives on the step itself, so the condition travels with the
step when it is reused:

```js
.step(Step.name('x').runif(cond).prompt(...))
```

## Memory Model: Scope Chain (chosen)

**Memory is a scope chain.** Every step owns a memory — a set of name →
value bindings. Memories form a tree mirroring the step tree: each memory is
linked to its parent's memory.

**Reads resolve upward.** When a step asks for a name, the engine checks its
own memory first; if absent, it asks the parent, then the grandparent, up to
the root. **The nearest binding wins** — same as variable scoping in nested
functions, JS prototype chains, or React context.

**Writes flow up one level.** When a step completes, its result is stored in
its *parent's* memory under the step's name. A parent's memory is thus an
ordered record of what its children have produced so far, visible to all
later descendants. The root memory holds the thread's initial inputs.

Consequences:

- **Shadowing is free** — two steps named `draft` in different branches
  don't collide; each resolves to the nearest one up its own chain. Step
  names are scoped, not global.
- **Sibling isolation** — a step can't see another step's internal state,
  only what completed steps exported to their shared parent.
- **Deep reads need no wiring** — a grandchild reads the root's values
  without the middle layer passing anything through.
- **Local vs exported** — a step's own memory holds its internals (tool
  round-trips, per-iteration state); what it exports upward is its final
  result. Leaf steps start empty and read mostly from ancestors.
- **Misses** — lookup reaching the root with no hit yields `undefined`, or a
  loud error if the name was declared in `.needs()`.
- **Loops** — each `.until()` iteration's children overwrite their slot in
  the parent's memory, so iteration N sees iteration N−1's results (the
  retry-with-verification requirement). Accumulated history, if adopted,
  hangs off this (see Open Questions).

Interactions:

- `memory.step.navigate` reads "the result of the step named `navigate`",
  resolved by the chain walk; nearest scope holding that name wins.
- `.needs()` validation becomes precise: an input is valid if a producing
  step exists among the preceding siblings, or the preceding siblings of any
  ancestor (loops make this "possibly absent" — inputs need an optional
  notion).

This resolves the memory-scope question: neither a global registry nor
strict parent/child — tree-scoped with upward resolution.

## YAML vs JS: JS chosen (for now)

Target authors: **LLMs write, humans edit.**

Why JS over YAML:

- Prompts are **functions of memory**. YAML can only hold strings, which
  would require a template engine plus an expression language for conditions
  (the GitHub Actions / Ansible model — no type checking, typos like
  `${memory.step.navigte}` fail at runtime instead of in the editor).
- JS-in-YAML is technically possible — custom `!js` tags (js-yaml / the
  `yaml` package both support custom tags) or eval'd code strings in literal
  blocks (`|`) — but practically worse: eval security, tooling dies at the
  string boundary (no highlighting/linting/autocomplete), runtime errors
  with stack traces pointing into `new Function` instead of the source file.
- LLMs write patterned JS fluently; YAML's approachability advantage matters
  less when the authors are LLMs.
- What LLM authors need most is **validation**: the builder should fail
  loudly at build time on hallucinated methods or references to nonexistent
  step names.

Escape hatch: a YAML authoring layer can compile down to the JS builder
later, if non-code tooling ever needs to read thread structure.

## Design Discussion (Open)

The following points are under active discussion — proposals and tradeoffs,
not settled decisions.

### Skippable steps

A step should be skippable (`.skipif(cond)` / `.runif(cond)`). Open: what do
downstream steps see when a producer was skipped?

1. Error (fail loudly)
2. Dependent step is skipped too (cascade, GitHub Actions style)
3. Dependent runs with `memory.step.A === undefined` (permissive)

Leaning: required inputs by default + explicit "optional" marker; missing
required input due to a skip either errors or cascades. Interacts with
loops (below).

### Prompt shapes

`.prompt()` accepts `string | message[] | (memory) => string | message[]`.
Typed message arrays (roles: system/user/assistant/tool) matter because
tool-call round-trips are better expressed as proper role-typed messages
than flattened into one string.

### Tool call steps

A step can be a direct tool call, no LLM. Proposed mental model: **a step is
a named producer of a memory slot** — LLM prompt, tool call, or plain
function are just mechanisms for producing the value.

- `.tool(name, argsFn)` — named tool resolved from a **runtime-provided
  registry**, keeping grandma-kat decoupled from MCP (`browser-mcp` or
  anything else supplies tools at run time).

### Defined inputs

Steps declare what they expect in memory: `.needs('draft', 'navigate')`.
Motivation: this is the **validation story for LLM authors**.

- Build-time check: every declared input has a producing step somewhere in
  the thread (fail loudly on hallucinated names).
- Scoped memory: the prompt fn receives only declared inputs, not the whole
  soup — smaller context, fewer bad references.
- Readable dataflow for human editors.

Wrinkle: can't validate "producer appears *before* consumer" at build time,
because loops deliberately violate that — inputs need an "optional / may not
exist yet" notion.

### Loopable steps

Use case: prompt → verification prompt → loop back or finish. On the second
pass, the verification step's output now exists in memory and should be
visible to the first step.

**Structured loops (`.until`) vs arbitrary goto.** Goto turns the step tree
into a graph — spaghetti-prone, hard to validate. The retry-with-verification
pattern doesn't need it; it's exactly *a parent re-running its substeps*:

```js
Step.name('draft-and-verify')
  .step(Step.name('draft')
    .prompt(m => `Write the thing. ${m.step.verify ?? ''}`))
  .step(Step.name('verify')
    .needs('draft')
    .prompt(m => `Verify: ${m.step.draft}`))
  .until(m => m.step.verify === 'pass', { max: 3 })
```

`.until()` on the parent = do-while over its children. Stays a tree,
trivially validatable. Reserve `.goto()` for later if a real case demands it.

**Memory semantics: latest vs history.** Overwrite semantics give the loop
requirement for free (iteration 2 sees iteration 1's `memory.step.verify`).
But retry loops often want all previous attempts ("here's what failed
before"). Proposal: `memory.step.verify` = latest, `memory.step.verify.history`
= every iteration (matches the root spec's append-only logging model).

**Safety:** loops get a mandatory `max` (or low default cap) — LLM-authored
loops without bounds burn tokens forever.

### Per-step model

Each step can run with a different model: `.model(...)` on any step, with
inheritance down the tree — step → parent step → root → runtime default.
Build-time validation: every step must resolve to a model before execution
(matches the root spec's model-inheritance rule).

Use case: cheap/small model for simple classification steps (the "yes/no"
checks in `find-listings`), stronger model for synthesis — cost/latency
optimization per step.

Open: what does the argument reference?

- **Provider name** (`'local'`, `'huggingface'`) — pulls baseURL + API key +
  model from `threads.config.json`. One source of truth.
- **Raw model ID** — overrides the model on the current provider. More
  flexible, but allows broken provider/model combos.
- Could be split into `.provider()` / `.model()` — but for LLM authors, one
  obvious way is better.

### Per-step tools

Each prompt step defines which tools are available to its LLM call:
`.tools('navigate', 'click')` — a whitelist of names from the runtime
registry, sent as function-calling schemas. Default: no tools; no implicit
inheritance to substeps (explicit is better for validation).

Open questions:

1. **Naming collision** — `.tool(name, argsFn)` ("this step *is* a tool
   call") vs `.tools(...)` ("this step's LLM *has* tools") differ by one
   letter with opposite meanings; LLM authors will confuse them. Proposal:
   rename the direct-call step to `.call('navigate', m => ({ url: ... }))`.
2. **Tool-call round-trips** — when the LLM responds with tool calls, who
   runs them?
   - **Option A: agentic loop inside the step.** Engine executes tool calls,
     feeds results back, repeats until a final answer (matches the root
     spec's `response_is_tool_call → retry` model). Convenient, but a hidden
     `.until()` — same open questions apply (max rounds? history?).
   - **Option B: explicit.** The LLM *selects* a call; the engine
     materializes it as a `.call()` step execution; the result lands in
     memory; flow control stays visible in the tree. More verbose, but
     inspectable and consistent with "steps as producers."
3. **Validation timing** — `.needs()` validates at build time, but tools
   come from the runtime registry, so tool names can only be checked at run
   start. Should fail loudly before the first LLM call.

### Conditional rules everywhere (proposed)

Every builder method takes an optional condition as its first argument,
wrapped in `when()` (syntax chosen — see gotcha #1):
`.model(when(run_if), model)`, `.prompt(when(run_if), prompt_fn)`,
`.step(when(run_if), child)`, `.until(when(run_if), check)`. Each call
appends a `(condition, value)` rule to a per-method rule list; rules are
evaluated lazily at the point of use, against memory.

Unconditional calls stay bare: `.prompt(m => ...)`. A `when()` marker is a
distinct type, so the builder rejects a bare function in the condition slot
at build time with "did you mean `when()`?" — loud, specific errors for the
mistake LLM authors will make.

**Semantics: last match wins (conditional assignment).** Rules apply in
declared order; each matching rule overwrites the previous value.
`.model('x').model('y')` → `'y'` — same as normal builder setters, each with
a gate. The override pattern puts defaults first:

```js
.model('cheap-model')                                                   // default first
.model(when(m => m.step.plan.complexity === 'high'), 'strong-model')    // conditional override

.prompt(`Write the thing.`)                              // base case
.prompt(when(m => m.step.verify), m => `Revise: ${m.step.verify}`)      // retry override
```

Ordering convention: **general first, specific later** — the reverse of
pattern matching (specific first) and the reverse of the root spec's
first-match-wins conditions. Chosen because it matches normal builder/setter
intuition (later calls overwrite). Must be documented loudly: LLM authors
may import either convention by habit.

**Two flavors of methods:**

- *Selective* — one value is chosen: `.model()`, `.prompt()`, `.until()`.
  Last matching rule wins.
- *Accumulative* — every matching rule applies independently:
  `.step(cond, child)` attaches the child iff the condition matches. No
  overriding; authors must not expect switch-like behavior.

Defaults when no rule matches: `.model()` → inherit from parent; `.step()` →
child not attached (this largely subsumes `.skipif` / `.runif` as separate
concepts); `.until()` → no loop; `.prompt()` → error (a step with nothing to
say is a bug).

**Gotchas / validation:**

1. *Condition syntax: `when()` wrapper (chosen).* Conditions are wrapped:
   `.prompt(when(m => m.step.verify), m => ...)`; unconditional calls pass
   the value bare. The marker is a distinct type, so the builder can reject
   a bare function in the condition slot at build time ("did you mean
   `when()`?"). Rejected alternative: enforced 2-arity
   (`.prompt(true, m => ...)`) — uniform for generators (the SQL
   `WHERE 1=1` trick), but the noise tax lands on the common unconditional
   case, and `.until(true, check)` is actively misleading since both slots
   are `memory => boolean`. Bonus: `when()` can later grow labels,
   `when(cond, 'retry case')`, so logs can name which rule matched.
2. *Shadowed rules* — a conditional rule followed by an unconditional rule
   is dead code (the unconditional one always overwrites it). Build-time
   warning.
3. *Attachment-site vs step-owned conditions* — `.step(when(cond), child)`
   puts the condition at the attachment site, which doesn't travel with
   reuse. Could coexist with step-owned gates (AND-ed together), at the cost
   of one more rule to explain. (Open.)
4. *Dynamic trees* — conditional attachment means `.needs()` can only check
   "a producer exists among potentially attached steps"; runtime
   missing-input handling follows skip semantics (see Open Questions).

### Unified lifecycle (proposed)

Every step gets the same lifecycle: **skip-check → collect declared inputs →
produce value (prompt / tool / substeps) → store in memory under its name →
loop-check**. One uniform shape keeps behavior predictable for LLM writers
and the engine simple.

## Open Questions

1. **Factory output** — is `Step.name('x').prompt(...)` itself the
   executable function, or is there a `.build()` / `.run()` finalizer?
2. **Execution order** — do substeps always run before the parent's prompt?
   Sequential in declared order?
3. **Skip semantics** — error vs cascade vs permissive when a declared
   input's producer was skipped?
4. **Loop construct** — structured `.until()` on the parent vs arbitrary
   `.goto()` (or both)?
5. **Memory history** — latest-only vs latest + `.history` accumulation
   across loop iterations?

Resolved:

- ~~Memory scope~~ → tree-scoped with upward resolution (see Memory Model).
- ~~Condition syntax~~ → `when()` wrapper (see Conditional rules, gotcha #1).
