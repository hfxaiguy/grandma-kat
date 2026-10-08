// Two routing guarantees:
//   1. A tree entered as a TOOL is a capability boundary — it sees only its own
//      Tools(), never the invoker's. A From()-attached subtree keeps inheriting.
//   2. Goto() targets can be qualified by tree name: "tree/slot",
//      "pattern|app/tree" (that tree's entry Human), while a bare slot name
//      keeps the legacy nearest-frame behavior.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import kat, { Tree, name, Tools, Register, Prompt, Human, Call, Goto, Return, Branch, From, registerTree, readFromMemoryOnce, Emit, Memory, update, Until, goto, max } from '../src/index.mjs';
import { scripted, mockRuntime, tool } from './helpers.mjs';

const fn = (n) => ({ type: 'function', function: { name: n, arguments: '{}' } });
const treeTool = (name) => ({ description: `${name} tree`, parameters: { type: 'object', properties: {} }, tree: name });

test("a tree invoked as a tool sees only its own tools (no inheritance)", async () => {
  const sub = Tree(name('sub'), Prompt('reply', () => [{ role: 'user', content: 'SUBQ' }]),
    Return((m) => m.branch.reply));
  registerTree(sub);
  const host = Tree(
    name('host'),
    Tools('host_tool', 'sub'),
    Prompt('act', () => [{ role: 'user', content: 'HOSTQ' }]),
    Return((m) => m.branch.act),
  );
  const handler = scripted([
    { tool_calls: [fn('sub')] }, // host prompt calls the sub tree tool
    { content: 'sub done' },     // sub prompt answers
    { content: 'host done' },    // host prompt answers after the tool result
  ]);
  const rt = mockRuntime(handler, {
    tools: { host_tool: tool(async () => 'x'), sub: treeTool('sub') },
  });

  await kat.knit(host, rt);

  const hostCall = handler.calls.find((c) => c.messages.some((m) => m.content === 'HOSTQ'));
  const subCall = handler.calls.find((c) => c.messages.some((m) => m.content === 'SUBQ'));
  assert.ok(hostCall, 'the host prompt ran');
  assert.ok(subCall, 'the sub prompt ran as a tool');
  assert.ok(hostCall.tools.some((t) => t.function.name === 'host_tool'), 'host sees its own tool');
  assert.ok(hostCall.tools.some((t) => t.function.name === 'sub'), 'host sees the tree tool');
  assert.deepEqual(
    subCall.tools.map((t) => t.function.name),
    [],
    'sub inherits nothing across the tool boundary',
  );
});

test('a From()-attached subtree inherits the parent tools (explicit composition)', async () => {
  const child = Tree(name('child'), Prompt('reply', () => [{ role: 'user', content: 'CHILDQ' }]),
    Return((m) => m.branch.reply));
  registerTree(child);
  const host = Tree(
    name('host'),
    Tools('host_tool'),
    From('child'),
    Return(() => 'ok'),
  );
  const handler = scripted([{ content: 'child done' }, { content: 'host done' }]);
  const rt = mockRuntime(handler, { tools: { host_tool: tool(async () => 'x') } });

  await kat.knit(host, rt);

  const childCall = handler.calls.find((c) => c.messages.some((m) => m.content === 'CHILDQ'));
  assert.ok(childCall, 'the attached child prompt ran');
  assert.ok(childCall.tools.some((t) => t.function.name === 'host_tool'), 'child inherits host_tool via From()');
});

test('Goto("host/entry", seed) seeds memory; Human(readFromMemoryOnce()) reads it', async () => {
  const sub = Tree(name('sub'), Goto('host/entry', () => ({ entry: 'from-sub' })), Return(() => 'sub-done'));
  registerTree(sub);
  const host = Tree(
    name('host'),
    Call('run', 'sub', () => ({})),
    Human('entry', readFromMemoryOnce()),
    Return((m) => m.entry),
  );
  const rt = mockRuntime(scripted([{ content: 'x' }]), { tools: { sub: treeTool('sub') } });

  const out = await kat.knit(host, rt);
  assert.equal(out.result, 'from-sub', 'the seeded entry slot was read from memory');
});

test('a bare slot stays the legacy one-shot arm', async () => {
  const legacy = Tree(name('sub_b'), Goto('entry', () => 'legacy-hit'), Return(() => 'x'));
  registerTree(legacy);
  const hostB = Tree(name('host'), Call('run', 'sub_b', () => ({})), Human('entry'), Return((m) => m.entry));
  const outB = await kat.knit(hostB, mockRuntime(scripted([{ content: 'x' }]), { tools: { sub_b: treeTool('sub_b') } }));
  assert.equal(outB.result, 'legacy-hit');
});

test('readFromMemoryOnce() reads a fresh value from ANY source, not just a Goto seed', async () => {
  // The freshness token is the slot write itself, so a Memory/update write (or
  // a From(..., memory) seed) delivers too — Goto is not special.
  const tree = Tree(
    name('seeded_by_memory'),
    Memory('entry', () => 'init'),
    Memory(update(), 'entry', () => 'from-memory'),
    Human('entry', readFromMemoryOnce()),
    Return((m) => m.entry),
  );
  const out = await kat.knit(tree, mockRuntime(scripted([{ content: 'x' }])));
  assert.equal(out.result, 'from-memory', 'the newest Memory write is read');
});

test('readFromMemoryOnce() re-pauses on a loop rewind (the notice is one-shot)', async () => {
  const host3 = Tree(
    name('host3'),
    Memory('n', () => 0),
    Call('seed', 'sub_loop', () => ({})),
    Human('entry', readFromMemoryOnce()),
    Memory(update(), 'n', (m) => (m.n ?? 0) + 1),
    Until(goto('entry'), () => false, max(3)),
  );
  const sub = Tree(name('sub_loop'), Goto('host3/entry', () => ({ entry: 'seeded' })), Return(() => 'x'));
  registerTree(sub);
  const rt = mockRuntime(scripted([{ content: 'x' }]), {
    tools: { sub_loop: treeTool('sub_loop') },
    logger: `/tmp/opencode/loop-${Date.now()}.db`,
  });
  const first = await kat.knit(host3, rt);
  assert.equal(first.status, 'waiting', 'the loop paused after the seeded pass');
  assert.equal(first.humanSlot, 'entry');
});

test('a Goto inside a model-called tree-backed register unwinds (control flow, not a tool error)', async () => {
  // The register's tree ends in a Goto; called from a prompt's tool loop it
  // must unwind like a Call()'s Goto, not be swallowed as a tool error.
  const jumper = Tree(
    name('jumper'),
    Goto('host/start_input', () => ({ start_input: 'yielded' })),
  );
  const host = Tree(
    name('host'),
    Register('jump', 'jump to the host entry', jumper),
    Prompt('ask', () => [{ role: 'user', content: 'go' }], {
      tools: ['jump'],
    }),
    Human('start_input', readFromMemoryOnce()),
    Return((m) => 'host got: ' + String(m.start_input ?? '')),
  );
  const rt = mockRuntime(scripted([
    { content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'jump', arguments: '{}' } }] },
  ]));

  const out = await kat.knit(host, rt);
  assert.equal(out.status, undefined, 'the run completed at the host entry');
  assert.match(String(out.result), /host got: yielded/, 'the goto unwound to the host frame');
});
