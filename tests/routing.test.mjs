// Two routing guarantees:
//   1. A tree entered as a TOOL is a capability boundary — it sees only its own
//      Tools(), never the invoker's. A From()-attached subtree keeps inheriting.
//   2. Goto() targets can be qualified by tree name: "tree/slot",
//      "pattern|app/tree" (that tree's entry Human), while a bare slot name
//      keeps the legacy nearest-frame behavior.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import kat, { Tree, name, Tools, Prompt, Human, Call, Goto, Return, Branch, From, registerTree } from '../src/index.mjs';
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

test('Goto("pattern/host") reaches the host tree entry Human', async () => {
  const sub = Tree(name('sub'), Goto('pattern/host', () => 'from-sub'), Return(() => 'sub-done'));
  registerTree(sub);
  const host = Tree(
    name('host'),
    Call('run', 'sub', () => ({})),
    Human('entry'),
    Return((m) => m.entry),
  );
  const rt = mockRuntime(scripted([{ content: 'x' }]), { tools: { sub: treeTool('sub') } });

  const out = await kat.knit(host, rt);
  assert.equal(out.result, 'from-sub', 'the entry slot was armed by the qualified Goto');
});

test('Goto("host/entry") targets a specific slot; a bare slot stays legacy', async () => {
  const bySlot = Tree(name('sub_a'), Goto('host/entry', () => 'slot-hit'), Return(() => 'x'));
  registerTree(bySlot);
  const hostA = Tree(name('host'), Call('run', 'sub_a', () => ({})), Human('entry'), Return((m) => m.entry));
  const outA = await kat.knit(hostA, mockRuntime(scripted([{ content: 'x' }]), { tools: { sub_a: treeTool('sub_a') } }));
  assert.equal(outA.result, 'slot-hit');

  const legacy = Tree(name('sub_b'), Goto('entry', () => 'legacy-hit'), Return(() => 'x'));
  registerTree(legacy);
  const hostB = Tree(name('host'), Call('run', 'sub_b', () => ({})), Human('entry'), Return((m) => m.entry));
  const outB = await kat.knit(hostB, mockRuntime(scripted([{ content: 'x' }]), { tools: { sub_b: treeTool('sub_b') } }));
  assert.equal(outB.result, 'legacy-hit');
});
