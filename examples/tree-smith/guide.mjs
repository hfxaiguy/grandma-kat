// guide.mjs — the instructions the smith hands the authoring model.
//
// The authoring prompt is the heart of the example: a model that has never
// seen grandma-kat must be able to write a valid pattern from this alone.
// So it carries the element surface, the memory model, the rules that
// actually trip up LLM authors (gates need clean booleans, a check must
// return exactly true, Needs is not for sibling outputs, every loop needs
// max()), the importing/remapping idiom, the data-pipeline rules (query
// results stay live), the authoring workbench (explore with tools, test-run
// in the draft slot), the input contract, and the inventory of models/tools
// the finished tree may reference.
//
// FACTORY_NAMES (compile.mjs) is the single source of truth for the
// "in scope" list — the same names the evaluator binds. SURFACE supplies the
// models/tools sections, so the reward (guide text) and the constraint
// (validateDef) can never drift apart.

import { FACTORY_NAMES } from './compile.mjs';

const FACTORY_LIST = FACTORY_NAMES.join(', ');

function renderModels(models) {
  return Object.entries(models)
    .map(([id, description]) => `- ${id} — ${description}`)
    .join('\n');
}

function renderTools(tools) {
  return Object.entries(tools)
    .map(([id, spec]) => `- ${id} — ${spec.description} parameters: ${JSON.stringify(spec.parameters)}`)
    .join('\n');
}

export function renderAuthorPrompt({ task, error, surface }) {
  const failure = error
    ? `\n## Previous attempt failed\n${error}\nFix the problem and output the complete corrected source.\n`
    : '';
  return `You are writing a grandma-kat pattern: a small JavaScript program that
grandma.knit() executes as a tree of LLM steps.

Your code runs as a function body with these factories already in scope
(do not import anything — the list is exact):
${FACTORY_LIST}
Do not use export. Define \`const pattern = Tree(...)\`.

## How a tree runs
- Tree(...elements) builds ONE tree; children run top to bottom, in order.
- The tree's value is its LAST executed child's output.
- Nest pieces as subtrees: Branch(Tree(name('x'), ...)); reuse a tree that is
  registered by name with From('x', ...) (see "Importing trees"). A subtree's
  value is its last executed child's output too.
- A named tree is a pure container: all doing lives in children.

## Elements
- name('id')            register the tree under a name (sub-branches may stay anonymous)
- Needs('x', ...)       declare inputs given to this tree; checked when it starts
- Model('name')         model for steps from here on (default: inherit; last rule wins)
- Tools('t', ...)       tools the model may call from here on (default: none)
- Branch([when(g),] subtree)          attach a subtree (gate at the attachment site)
- From([when(g),] 'name'[, memory(m => ({ ... }))])  attach a registered tree (see below)
- Prompt([name,] fn)    one LLM call; fn(m) -> string | message[] ({role, content}[])
- Call([name,] tool, argsOrFn)        one direct tool call, no LLM
- Check(fn, goback(n, max(k [, msg])))  validate; fn -> true | feedback string | false
- Until(cond, max(k))   loop: re-run the tree's children until cond(m) is true
- Memory([when(g),] 'slot', (m, cur) => v)  write a slot (produces no output)
- Memory(update(), 'slot', fn)        update an existing slot (may live in an ancestor)
- Return([when(g),] m => v)           stop early with v (null/undefined = continue)
- Each('slot', m => [...], subtree)   run subtree per element; m.item = element
- when(cond)            gate marker; may sit anywhere among an element's arguments
- goback(n), max(k)     retry budget: goback(n) re-runs the n children before the Check

## Importing trees — From('name', memory(seed)) — and input remapping
- From('name') attaches the tree registered under 'name' exactly like a
  branch; the value the import exports lands under its own name
  (m.branch.<name>).
- To pass the inputs the import expects, give From a memory() marker:
  memory(fn) receives the call-site memory view and returns the slots to
  write into the imported tree's own scope at entry. That one line IS the
  remap — do not hand-roll it with extra Memory() steps or a Branch wrapper:
    From('reader', memory(m => ({ sql_res: m.sql_res })))
- The seeded slots satisfy the import's Needs('...'), shadow any same-named
  ancestor slot for that subtree, and leak nothing to your other steps.
  memory(m => ({ ...m })) snapshots everything visible to the call site.
- The name must already be registered when the import builds: build helper
  trees into consts with name('helper') earlier in your source, or reuse a
  tree the process already built. An unregistered name is a build error.
- Imports are positional steps and gateable:
  From(when(m => m.needs_help), 'helper', memory(m => ({ input: m.task })))
- Imported trees answer to this same surface — their Tools()/Model()
  references are validated together with yours.

## Data pipelines — keep query results structured
- Tool results are stored AS-IS: a query tool's rows are live objects in the
  slot your Call wrote (e.g. m.branch.q.rows), never a JSON string.
- Do the plumbing in JS: filter or shape with Memory(...) functions, then
  map with Each('out', m => m.branch.q.rows, subtree). Inside the subtree
  the current row is m.item — the live object — so pass it straight into an
  import seed (From('helper', memory(m => ({ row: m.item })))) or read its
  fields in prompts.
- Never JSON.parse or JSON.stringify tool results, and never round-trip a
  result set through a model prompt when the tree can read it directly. A
  prompt only ever sees text, and only what you choose to put in it — so
  pass the model a row, a count, or a summary, not the whole table.

## Exploring data and test-running your candidate
You are not authoring blind. During this step you can, and should:
- Inspect real data with the tools listed below BEFORE you write — schemas,
  field names, sample rows, result shapes. Reads only; a few targeted calls
  is plenty (be economical).
- Test your candidate before answering:
  1. define_draft({ source }) — compiles your current source into the draft
     slot. The result names the definition, or tells you exactly why it was
     rejected (fix the source and try again).
  2. run_draft({ task: "<the real task>" }) — runs that draft exactly like
     the real invocation and returns its output, or its error.
  Revise and repeat a couple of times, then output the FINAL source. The
  smith re-defines it itself and runs it for real; the draft slot is just
  your workbench.
- Test runs execute with this same tool surface: read-only during
  experiments, small samples, and no Human() in a draft.
- define_draft / run_draft are authoring helpers — never use them inside
  the pattern you write.

## Reading state — the memory view \`m\`
- m.task, m.anything   a slot by name (yours or an ancestor's; nearest wins)
- m.branch.x           the value a named child/Prompt exported
- m.prev               previous siblings' values, most recent first (m.prev[0] = the one just before)
- m.raw.branch.x / m.raw.prev[i]   full records: {content, reasoning, toolCalls, toolResults}
- m.error              feedback from the last failed Check; re-run prompts read it
                       with \${m.error ?? ''}

## Rules that bite
1. Prompts are functions of memory: Prompt(m => \`...\${m.task}...\`) — look
   values up at run time.
2. If you reference a step later, name it and read m.branch.<name>;
   otherwise leave it anonymous and use m.prev[0].
3. Check(fn): return exactly \`true\` to pass (a passing check contributes
   NOTHING to m.prev). A returned string fails with that feedback (it lands
   in m.error); anything else fails generically — so a truthy expression is
   a bug: write \`cond ? true : 'what was wrong'\`, never \`cond && 'message'\`
   (that returns the message and fails).
4. goback(n) re-runs the n children before the check — always bound it:
   goback(1, max(3)). Exhaustion fails the tree loudly. Until(cond, max(k))
   is the whole-container version. A retried prompt only learns what went
   wrong if it reads \${m.error ?? ''} — make every prompt that can be
   retried include it.
5. Gates are explicit: when(m => ...). Config rules (Model, Tools, Until) are
   last-match-wins — defaults first, exceptions after (the reverse of pattern
   matching). Doing elements (Prompt/Branch/From/Check/Call/Memory/Return/Each)
   all run, in order.
6. Gate on a clean boolean: if a gate depends on an LLM answer, make that
   prompt answer ONLY "yes"/"no" and normalize in the condition:
   when(m => /^yes/i.test(String(m.prev[0]).trim())).
7. Needs('task') is how your tree receives its input — the runner seeds it.
   Never declare Needs for values an earlier step in YOUR tree produces;
   read those defensively (m.branch.x ?? ''). An imported tree's Needs are
   satisfied by your From('name', memory(...)) seed.
8. Use only tool names from the list below in Tools(...)/Call(...) (or
   Register(...) your own inline). A Prompt with Tools(...) loops
   automatically until the model stops calling tools; add disableAuto()
   for a step that must act once per pass: Prompt(disableAuto(), fn).
9. Memory(...) is side-effect only. Return(...) stops the tree only when it
   returns a non-null value, and that value becomes the tree's output.
10. Keep every loop bounded — every goback and Until needs max(k).

## Models available
${renderModels(surface.models)}
(omit Model(...) to inherit one)

## Tools available
${renderTools(surface.tools)}
(You may also Register(...) your own tools inline.)

## Input contract
Your tree is invoked once with { "task": <string> } — declare Needs('task'),
read m.task, and make the tree's final output the answer.
${failure}
## Output
Reply with ONLY one \`\`\`js code block containing the complete pattern source.
No prose around it.`;
}
