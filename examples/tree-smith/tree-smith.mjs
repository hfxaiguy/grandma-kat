// tree-smith — a tree that writes and executes trees on the fly.
//
// THE SHAPE (three moves):
//
//   1. author  — a strong model writes a complete grandma-kat pattern (JS
//                source) for the requested task, from the guide in guide.mjs.
//                It is not blind: it may inspect real data with the tools
//                below, and test-run candidates in the draft slot
//                (define_draft -> run_draft) before answering. This phase is
//                its OWN subtree, because Tools() rules resolve innermost-
//                tree-first and last-match-within-a-tree wins — the authoring
//                offer would otherwise be shadowed by the invoke offer.
//   2. define  — Register('define_tree') evaluates that source into a tree
//                definition, statically checks its tool/model references,
//                and re-registers the slot alias around it. Any failure
//                comes back as { error } and the repair Check sends the
//                author back to fix the source (goback inside the subtree).
//   3. invoke  — the host declares one static tree-tool entry per slot
//                (run_live -> 'generated:live'); the model calls it and the
//                runner resolves the alias at call time, running the fresh
//                definition IN PLACE — same run, same log, same pause/resume
//                machinery as the smith itself.
//
// WHY THE ALIAS: Tools(...) whitelists are validated when knit() starts, so
// a per-generated-tree tool name would be rejected wholesale. One static
// entry pointed at one registry alias keeps validation green while the
// definition under the alias changes on every define. `define_tree` re-uses
// the public API for this: Tree(name(alias), Branch(def)) registers the
// wrapper in the process registry the moment the name element is applied
// (src/tree.mjs), and resolveTreeTool reads the alias at call time.
//
// WHY THE MODEL CALLS run_live (instead of Call(...)): the prompt tool loop
// converts subtree failures into isError results (src/knit.mjs), which the
// invoke Check can turn into feedback — a Call() to a tree tool throws
// through and would kill the smith instead. So the defined tree failing is
// recoverable; re-invoking is bounded by goback(1, max(2)).
//
// SLOTS: one live definition per slot at a time (the alias is overwritten by
// each successful define), but a slot can be invoked any number of times.
// Two are declared here: 'live' (what the smith promotes and invokes) and
// 'draft' (the author's workbench — define_draft + run_draft). Add more
// names to SURFACE.slots and the host's entry loop follows automatically.
// See README.md.

import { Tree, name, Branch, Prompt, Call, Check, Register, Return, Tools,
         Needs, Model, Emit, goback, max, disableAuto, parameters } from '../../src/index.mjs';
import { renderAuthorPrompt } from './guide.mjs';
import { evaluatePattern, validateDef } from './compile.mjs';

// The promoted slot: the smith's invoke round targets `run_live`, and the
// host declares that entry once, pointing at 'generated:live'.
export const DEFAULT_SLOT = 'live';
// The author's workbench: test-runs happen here so a failed experiment can
// never overwrite a good 'live' definition.
export const DRAFT_SLOT = 'draft';
export const aliasFor = (slot) => `generated:${slot}`;
export const RUN_TOOL = `run_${DEFAULT_SLOT}`;

// What the smith is allowed to use — and what the authoring model is told
// about. One source of truth: the guide's inventory, the static validation,
// and the host's demo-tool registry (entry.mjs) all read this.
export const SURFACE = {
  models: {
    strong: 'the example model configured by entry.mjs',
  },
  tools: {
    echo: {
      description: 'Echo the given text back.',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    },
    clock: {
      description: 'Current UTC time as an ISO string.',
      parameters: { type: 'object', properties: {} },
    },
    sql_query: {
      description: 'Run a read-only SQL query against the demo database (a `contacts` table: id, name, company, phone) and return the rows.',
      parameters: { type: 'object', properties: { sql: { type: 'string', description: 'a SELECT statement' } }, required: ['sql'] },
    },
  },
  slots: [DEFAULT_SLOT, DRAFT_SLOT],
};

// Tools the authoring phase may call: the data surface it can inspect, plus
// the draft workbench (define + run) so it can test its candidate before
// answering. Author-only by construction: compile.mjs validates generated
// trees against SURFACE.tools, which does not contain these names.
export const AUTHOR_TOOLS = ['define_draft', `run_${DRAFT_SLOT}`, ...Object.keys(SURFACE.tools)];

// Evaluate + validate + re-register one slot alias. Shared by the two
// compiler registers below; every failure is a value the author can read.
function compileInto(slot, source) {
  try {
    const def = evaluatePattern(String(source));
    if (!def || def.kind !== 'tree') {
      return { error: 'the source must assign Tree(...) to `pattern`' };
    }
    const problems = validateDef(def, SURFACE);
    if (problems.length) return { error: problems.join('\n') };
    // Wrap the fresh definition and register it under the slot alias. The
    // wrapper's only child is the definition itself, so the extra level is
    // invisible: the wrapper exports its child's value.
    Tree(name(aliasFor(slot)), Branch(def));
    return { value: { slot, alias: aliasFor(slot), name: def.name ?? null, children: def.children.length } };
  } catch (err) {
    return { error: err.message };
  }
}

export const smith = Tree(
  name('tree-smith'),
  Needs('task'),
  Model('strong'),

  // The compilers as inline tools. Success stores { value: { slot, alias,
  // name, children } }; failure stores { error }, which the authoring
  // subtree's Check turns into m.error for the next attempt.
  Register('define_tree', 'Compile grandma-kat source into a slot alias',
    (m, args) => {
      const slot = String(args.slot ?? DEFAULT_SLOT);
      if (!SURFACE.slots.includes(slot)) {
        return { error: `unknown slot '${slot}' — declared slots: ${SURFACE.slots.join(', ')}` };
      }
      return compileInto(slot, args.source);
    },
    parameters({ type: 'object', required: ['source'],
      properties: {
        source: { type: 'string', description: 'complete pattern source; defines const pattern = Tree(...)' },
        slot: { type: 'string', description: `slot to define into (default '${DEFAULT_SLOT}')` },
      } })),

  // Author-only twin that always targets the draft slot — a separate tool so
  // the author can never overwrite the promoted 'live' definition by
  // accident while experimenting.
  Register('define_draft', 'Compile source into the draft slot (authoring workbench, test-runs only)',
    (m, args) => compileInto(DRAFT_SLOT, args.source),
    parameters({ type: 'object', required: ['source'],
      properties: {
        source: { type: 'string', description: 'complete pattern source; defines const pattern = Tree(...)' },
      } })),

  // ── move 1+2: the authoring subtree ────────────────────────────────────
  // Its own tree level so its Tools() offer (data + draft workbench) is not
  // shadowed by the invoke offer below: tool rules resolve innermost-tree-
  // first, last-match-within-a-tree. The registers declared above are
  // inherited downward, so Call('define', 'define_tree') and the author's
  // define_draft/run_draft all resolve here.
  Branch(Tree(
    name('authoring'),
    // Explore before writing; test-run candidates in the draft slot; bound
    // the rounds (the auto tool loop throws when max() is exceeded).
    Tools(...AUTHOR_TOOLS),
    Prompt('author', max(12), m => renderAuthorPrompt({ task: m.task, error: m.error, surface: SURFACE })),
    Check(m => /\bTree\s*\(/.test(String(m.prev[0])) || 'Output must define Tree(...) — no prose.',
      goback(1, max(3))),

    // Define for real (into 'live'). A rejected definition re-runs children
    // 0–2 (author, its check, define) with the compiler complaint in m.error.
    Call('define', 'define_tree', m => ({ source: m.branch.author })),
    Check(m => !m.branch.define.error
        || `Definition rejected:\n${m.branch.define.error}\nFix the source and output it in full.`,
      goback(3, max(3))),

    // Give the host a look at what was authored + defined (audit trail).
    Emit(m => ({ defined: m.branch.define.value.name ?? m.branch.define.value.alias,
                 alias: m.branch.define.value.alias,
                 source: m.branch.author })),

    // The subtree's export is what the invoke phase needs to report.
    Return(m => ({ source: m.branch.author,
                   name: m.branch.define.value.name ?? null,
                   alias: m.branch.define.value.alias })),
  )),

  // ── move 3: invoke ─────────────────────────────────────────────────────
  // The model calls the slot entry; the runner resolves the alias to the
  // definition the authoring subtree just built and runs it in place as a
  // subtree, seeded with the call args (so the generated tree's
  // Needs('task') resolves from its own invocation).
  Tools(RUN_TOOL),
  Prompt('invoke', disableAuto(),
    m => `Call the tool ${RUN_TOOL} exactly once with {"task": ${JSON.stringify(m.task)}}.`),
  Check(m => {
    const tr = m.raw.branch.invoke?.toolResults?.[0];
    if (!tr) return `You did not call ${RUN_TOOL} — call it exactly once.`;
    if (tr.isError) return `The generated tree failed: ${String(tr.result)}`;
    return true;
  }, goback(1, max(2))),

  // The smith's output: the source, the definition's name, and what the
  // generated tree produced.
  Return(m => ({ source: m.branch.authoring.source,
                 name: m.branch.authoring.name,
                 alias: m.branch.authoring.alias,
                 result: m.raw.branch.invoke.toolResults[0].result })),
);
