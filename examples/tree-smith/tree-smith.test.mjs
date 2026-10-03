// tree-smith smoke tests — mock models only, no network.
//
// The nine tests cover the smith's whole loop:
//   1. happy path — author → define → invoke, and the generated tree runs
//      in place with its call args seeded (it reads m.task);
//   2. eval-error repair — a source that doesn't evaluate goes back to the
//      author with the compiler complaint in m.error;
//   3. reference repair — unknown tool names (including the smith's own
//      plumbing, which generated trees may not touch) never reach the
//      registry and repair the same way;
//   4. run-time failure → re-invoke — a generated tree that exhausts its own
//      retry budget comes back as an isError tool result, and the smith
//      re-invokes it (bounded by goback(1, max(2)));
//   5. imports — a generated tree composes a helper tree with From(...) and
//      remaps its inputs through the memory() seed;
//   6. reuse — a later smith run composes a tree the earlier run defined,
//      by its registered name, again with a seeded input;
//   7. authoring with tools — the author inspects real data (sql_query)
//      before it writes, and the result is fed back into its next round;
//   8. draft test-runs — the author compiles into the draft slot, runs it,
//      reads the output, and only then answers with the final source;
//   9. data pipelines — a generated query→map tree keeps the query rows as
//      live objects (filter in Memory, Each over m.item) and never routes
//      the rows through a model thread.
//
// Run:  node examples/tree-smith/tree-smith.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import grandma, { Tree } from '../../src/index.mjs';
import { scripted, mockRuntime, tool } from '../../tests/helpers.mjs';
import { smith, SURFACE, aliasFor, RUN_TOOL } from './tree-smith.mjs';

// The runtime's tool-call shape, as the model emits it.
const tc = (name, args, id = name) => ({
  id,
  function: { name, arguments: JSON.stringify(args ?? {}) },
});

// The same runtime wiring entry.mjs uses for a real run, but with a scripted
// mock model and inline demo tools. One `run_<slot>` entry per SURFACE.slots.
function makeRuntime(handler, { task = 'say hello', extraTools = {} } = {}) {
  const slotEntries = Object.fromEntries(SURFACE.slots.map((slot) => [`run_${slot}`, {
    description: `Run the tree defined in slot '${slot}' (alias '${aliasFor(slot)}'); args seed its initial memory.`,
    parameters: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] },
    tree: aliasFor(slot),
  }]));
  return mockRuntime(handler, {
    models: { strong: { model: 'mock', handler } },
    memory: { task },
    tools: {
      echo: tool(async (a) => `echo: ${a.text}`),
      clock: tool(async () => '2026-09-30T12:00:00Z'),
      sql_query: tool(async () => [
        { id: 2, name: 'Bob Kahn', company: 'Harbr Group', phone: '' },
        { id: 3, name: 'Cyd Charisse', company: 'Harbr Group', phone: null },
      ]),
      ...slotEntries,
      ...extraTools,
    },
  });
}

// A valid authored tree: one auto-loop prompt that calls `echo` and answers
// with the result. It reads m.task, so a green run also proves the invoke
// args were seeded into the generated tree's scope.
const GOOD_SOURCE = [
  '```js',
  'const pattern = Tree(',
  "  name('echoer'),",
  "  Needs('task'),",
  "  Tools('echo'),",
  '  Prompt(m => `Call echo with ${JSON.stringify({ text: m.task })} then answer with its result.`),',
  ');',
  '```',
].join('\n');

test('authors, defines, and runs a tree in place', async () => {
  const handler = scripted([
    GOOD_SOURCE,                                                        // author
    { content: '', tool_calls: [tc(RUN_TOOL, { task: 'say hello' })] }, // invoke round
    { content: '', tool_calls: [tc('echo', { text: 'say hello' })] },   // generated round 1
    { content: 'done: say hello' },                                     // generated round 2
  ]);
  const runtime = makeRuntime(handler);
  const emitted = [];
  runtime.onEmit = (v) => emitted.push(v);

  const { result } = await grandma.knit(smith, runtime);

  assert.equal(result.name, 'echoer');
  assert.equal(result.alias, aliasFor('live'));
  assert.equal(result.result, 'done: say hello');
  assert.ok(Tree.has(aliasFor('live')), 'the slot alias is registered');

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].defined, 'echoer');
  assert.equal(emitted[0].alias, aliasFor('live'));

  // author, invoke, generated round 1 (echo call), generated round 2 (answer)
  assert.equal(handler.calls.length, 4);
  // The generated prompt was seeded with the invocation args.
  assert.ok(handler.calls[2].messages.some((m) => String(m.content).includes('say hello')));
  // The generated tree's own tool round-trip reached it.
  assert.ok(handler.calls[3].messages.some((m) => String(m.content).includes('echo: say hello')));
});

test('a source that does not evaluate repairs back through the author', async () => {
  const BAD_SOURCE = [
    '```js',
    "const pattern = Tree(Promt(() => 'x'));",
    '```',
  ].join('\n');

  const handler = scripted([
    BAD_SOURCE,                                                         // author (typo)
    GOOD_SOURCE,                                                        // author (repaired)
    { content: '', tool_calls: [tc(RUN_TOOL, { task: 'say hello' })] }, // invoke round
    { content: '', tool_calls: [tc('echo', { text: 'say hello' })] },   // generated round 1
    { content: 'done: say hello' },                                     // generated round 2
  ]);

  const { result } = await grandma.knit(smith, makeRuntime(handler));

  assert.equal(result.result, 'done: say hello');
  // The second authoring call received the compiler complaint.
  assert.ok(handler.calls[1].messages.some((m) => String(m.content).includes('Promt')));
});

test('unknown tool references repair before anything runs', async () => {
  const UNKNOWN_TOOL_SOURCE = [
    '```js',
    'const pattern = Tree(',
    "  name('navigator'),",
    "  Tools('navigate'),",
    "  Prompt(() => 'go'),",
    ');',
    '```',
  ].join('\n');

  const PLUMBING_SOURCE = [
    '```js',
    'const pattern = Tree(',
    "  name('recursor'),",
    `  Tools('${RUN_TOOL}'),`,
    "  Prompt(() => 'go'),",
    ');',
    '```',
  ].join('\n');

  const handler = scripted([
    UNKNOWN_TOOL_SOURCE,                                                // author (bad tool)
    PLUMBING_SOURCE,                                                    // author (plumbing name)
    GOOD_SOURCE,                                                        // author (repaired)
    { content: '', tool_calls: [tc(RUN_TOOL, { task: 'say hello' })] }, // invoke round
    { content: '', tool_calls: [tc('echo', { text: 'say hello' })] },   // generated round 1
    { content: 'done: say hello' },                                     // generated round 2
  ]);

  const { result } = await grandma.knit(smith, makeRuntime(handler));

  assert.equal(result.result, 'done: say hello');
  // The unknown tool was reported together with the inventory.
  assert.ok(handler.calls[1].messages.some((m) =>
    String(m.content).includes("unknown tool 'navigate'") && String(m.content).includes('echo')));
  // The smith's plumbing is off-limits to generated trees (no recursion).
  assert.ok(handler.calls[2].messages.some((m) =>
    String(m.content).includes(`unknown tool '${RUN_TOOL}'`)));
});

test('a generated tree that fails at run time is re-invoked', async () => {
  // This tree calls `echo` once, then checks the result and retries once.
  // The first invocation fails both attempts (the tool throws) and exhausts
  // the inner budget, which surfaces as an isError tool result; the smith
  // re-invokes, and the fresh run succeeds.
  const FLAKY_SOURCE = [
    '```js',
    'const pattern = Tree(',
    "  name('flaky'),",
    "  Needs('task'),",
    "  Tools('echo'),",
    '  Prompt(disableAuto(), \'go\', () => \'Call echo with {"text": "hi"}.\'),',
    "  Check(m => !m.raw.branch.go.toolResults[0].isError || 'echo failed', goback(1, max(1))),",
    ');',
    '```',
  ].join('\n');

  let echoCalls = 0;
  const flakyEcho = tool(async (a) => {
    echoCalls += 1;
    if (echoCalls <= 2) throw new Error(`flaky echo ${echoCalls}`);
    return `echo: ${a.text}`;
  });

  const handler = scripted([
    FLAKY_SOURCE,                                                         // author
    { content: '', tool_calls: [tc(RUN_TOOL, { task: 'say hello' })] },  // invoke #1
    { content: '', tool_calls: [tc('echo', { text: 'hi' })] },           // generated attempt 1
    { content: '', tool_calls: [tc('echo', { text: 'hi' })] },           // generated retry
    { content: '', tool_calls: [tc(RUN_TOOL, { task: 'say hello' })] },  // invoke #2
    { content: 'recovered', tool_calls: [tc('echo', { text: 'hi' })] },  // generated rerun — succeeds
  ]);

  const { result } = await grandma.knit(smith, makeRuntime(handler, {
    extraTools: { echo: flakyEcho },
  }));

  assert.equal(result.result, 'recovered');
  assert.equal(echoCalls, 3); // two failures, then success on the second invocation
});

test('a generated tree can import a helper tree, remapping its inputs', async () => {
  // Two trees in one source: the helper declares the input it expects; the
  // main tree names it and hands it a remap via From(..., memory(...)).
  const COMPOSED_SOURCE = [
    '```js',
    'const helper = Tree(',
    "  name('helper_echo'),",
    "  Needs('input'),",
    '  Prompt(m => `helper saw: ${m.input}`),',
    ');',
    '',
    'const pattern = Tree(',
    "  name('composer'),",
    "  Needs('task'),",
    "  Prompt('prep', m => `prep: ${m.task}`),",
    "  From('helper_echo', memory(m => ({ input: m.branch.prep }))),",
    ');',
    '```',
  ].join('\n');

  const handler = scripted([
    COMPOSED_SOURCE,                                                    // author
    { content: '', tool_calls: [tc(RUN_TOOL, { task: 'say hello' })] }, // invoke
    { content: 'prep: say hello' },                                     // composer prep
    { content: 'helper saw: prep: say hello' },                         // the import
  ]);

  const { result } = await grandma.knit(smith, makeRuntime(handler));

  assert.equal(result.name, 'composer');
  assert.equal(result.result, 'helper saw: prep: say hello');
  // The import's prompt ran on the remapped slot, not the outer task.
  assert.ok(handler.calls[3].messages.some((m) =>
    String(m.content).includes('helper saw: prep: say hello')));
});

test('a later generated tree can reuse one an earlier run defined', async () => {
  // Run 1 defines a reusable tree under its own name (name() registers it).
  const REUSABLE_SOURCE = [
    '```js',
    'const pattern = Tree(',
    "  name('reusable_echo'),",
    "  Needs('task'),",
    '  Prompt(m => `reused: ${m.task}`),',
    ');',
    '```',
  ].join('\n');

  const first = scripted([
    REUSABLE_SOURCE,
    { content: '', tool_calls: [tc(RUN_TOOL, { task: 'say hello' })] },
    { content: 'reused: say hello' },
  ]);
  const run1 = await grandma.knit(smith, makeRuntime(first));
  assert.equal(run1.result.result, 'reused: say hello');
  assert.ok(Tree.has('reusable_echo'), "the run-1 definition is still registered");

  // Run 2 authors a fresh tree that imports the registered one by name,
  // seeding the input it expects — no re-definition, no slot juggling.
  const REUSER_SOURCE = [
    '```js',
    'const pattern = Tree(',
    "  name('reuser'),",
    "  Needs('task'),",
    "  From('reusable_echo', memory(m => ({ task: m.task }))),",
    ');',
    '```',
  ].join('\n');

  const second = scripted([
    REUSER_SOURCE,
    { content: '', tool_calls: [tc(RUN_TOOL, { task: 'again' })] },
    { content: 'reused: again' },
  ]);
  const run2 = await grandma.knit(smith, makeRuntime(second));

  assert.equal(run2.result.name, 'reuser');
  assert.equal(run2.result.result, 'reused: again');
  // The import saw the seeded task (run 2's invocation args), not run 1's.
  assert.ok(second.calls[2].messages.some((m) => String(m.content).includes('again')));
});

test('the author inspects real data with tools before it writes', async () => {
  const handler = scripted([
    { content: '', tool_calls: [tc('sql_query', { sql: 'SELECT name, phone FROM contacts' })] }, // author explores
    GOOD_SOURCE,                                                                                 // author answers
    { content: '', tool_calls: [tc(RUN_TOOL, { task: 'say hello' })] },                          // invoke
    { content: '', tool_calls: [tc('echo', { text: 'say hello' })] },                            // generated round 1
    { content: 'done: say hello' },                                                              // generated round 2
  ]);

  const { result } = await grandma.knit(smith, makeRuntime(handler));

  assert.equal(result.result, 'done: say hello');
  // The query result was fed back into the author's next round.
  assert.ok(handler.calls[1].messages.some((m) => String(m.content).includes('Bob Kahn')));
  assert.equal(handler.calls.length, 5);
});

test('the author test-runs its candidate in the draft slot before answering', async () => {
  const DRAFT_SOURCE = [
    '```js',
    'const pattern = Tree(',
    "  name('draft_echo'),",
    "  Needs('task'),",
    '  Prompt(m => `draft echo: ${m.task}`),',
    ');',
    '```',
  ].join('\n');

  const handler = scripted([
    { content: '', tool_calls: [tc('define_draft', { source: DRAFT_SOURCE })] },     // author: compile draft
    { content: '', tool_calls: [tc('run_draft', { task: 'say hello' })] },           // author: test-run it
    'draft echo: say hello',                                                         // the draft's own prompt
    GOOD_SOURCE,                                                                     // author: final answer
    { content: '', tool_calls: [tc(RUN_TOOL, { task: 'say hello' })] },              // invoke
    { content: 'done: say hello' },                                                  // generated round 1
  ]);

  const { result } = await grandma.knit(smith, makeRuntime(handler));

  assert.equal(result.result, 'done: say hello');
  // The draft's output reached the author before it answered.
  assert.ok(handler.calls[3].messages.some((m) => String(m.content).includes('draft echo: say hello')));
  assert.equal(handler.calls.length, 6);

  // The experiment stayed in its slot: draft holds the draft tree, live holds
  // the promoted one.
  assert.ok(Tree.has(aliasFor('draft')));
  assert.equal(Tree.from(aliasFor('draft')).children[0].tree.name, 'draft_echo');
  assert.equal(Tree.from(aliasFor('live')).children[0].tree.name, 'echoer');
});

test('a generated pipeline maps query rows without serializing them', async () => {
  // The authored tree runs the query with a single disableAuto round, reads
  // the raw rows out of m.raw, filters in JS, and maps with Each — m.item is
  // the live row object. The rows never enter a model thread.
  const PIPELINE_SOURCE = [
    '```js',
    'const pattern = Tree(',
    "  name('query_and_map'),",
    "  Needs('task'),",
    "  Tools('sql_query'),",
    "  Prompt(disableAuto(), 'plan', m => `Call sql_query once to list Harbr Group contacts. Task: ${m.task}`),",
    "  Memory('rows', m => m.raw.branch.plan.toolResults[0].result),",
    "  Memory('missing', m => m.branch.rows.filter((r) => !r.phone)),",
    "  Each('mapped', m => m.branch.missing,",
    '    Tree(Prompt(m => `map ${m.item.name} (id ${m.item.id})`))),',
    "  Return(m => ({ count: m.branch.missing.length, mapped: m.branch.mapped })),",
    ');',
    '```',
  ].join('\n');

  const handler = scripted([
    PIPELINE_SOURCE,                                                                                 // author
    { content: '', tool_calls: [tc(RUN_TOOL, { task: 'say hello' })] }, // invoke round
    { content: '', tool_calls: [tc('sql_query', { sql: 'SELECT id, name, phone FROM contacts' })] }, // generated plan round
    'mapped: Bob Kahn',                                                                              // row 1
    'mapped: Cyd Charisse',                                                                          // row 2
  ]);

  const { result } = await grandma.knit(smith, makeRuntime(handler));

  assert.equal(result.name, 'query_and_map');
  assert.equal(result.result.count, 2);
  assert.deepEqual(result.result.mapped, ['mapped: Bob Kahn', 'mapped: Cyd Charisse']);
  assert.equal(handler.calls.length, 5);
  // The row objects reached the per-row prompts as live fields…
  assert.ok(handler.calls[3].messages.some((m) => String(m.content).includes('Bob Kahn')));
  // …and the raw rows never entered a model thread (no serialized `"phone"`).
  assert.ok(handler.calls.every((c) =>
    c.messages.every((m) => !String(m.content).includes('"phone"'))));
});
