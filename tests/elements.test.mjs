// The element surface — the executable spec: Tree(element, …) builds a tree
// definition, the record shapes are the contract (definition ids and host
// session hashes are computed over the def), and the trees knit end to end.
//
// Scripted against mock models — no live LLM.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import grandma, { Tree, name, Model, Tools, Needs, Human, Prompt, Memory, Register, Branch, Each, Call, Check, Emit, Return, Until, when, max, update, calls, parameters, disableAuto, toolHookBefore, toolHookAfter, goback, goto } from '../src/index.mjs';
import { scripted, mockRuntime, tool } from './helpers.mjs';

// ── the def shape is the contract ──────────────────────────────────────────
//
// Definition ids and host session hashes are computed over the def, so the
// record shapes below must not churn: no optional key appears unless used.

test('the kitchen sink builds one tree with the exact shape', () => {
  const f = {
    cond: () => true,
    text: () => 'hi',
    body: async () => ({ value: 'x' }),
    hook: () => null,
    mem: (m, cur) => cur ?? 1,
    memUpdate: (m, cur) => cur,
    emit: () => ({ text: 'hi' }),
    callArgs: () => ({}),
    array: () => [],
    check: () => true,
    until: () => true,
    give: () => null,
    context: () => null,
  };
  const schema = { type: 'object', properties: { q: { type: 'string' } } };
  const flow = goback(1, max(3));
  const sub = Tree(name('sub'), Prompt('leaf', f.text));

  const tree = Tree(
    name('sink'),
    Model('strong'),
    Model(when(f.cond), 'cheap'),
    Tools('a', 'b'),
    Tools(when(f.cond), 'c'),
    Needs('input'),
    Human('ask'),
    Human(when(f.cond), 'gated_ask', f.context),
    Memory('slot', f.mem),
    Memory(update(), 'slot', f.memUpdate),
    Memory(update(), 'slot', f.memUpdate),
    Emit(f.emit),
    Call('t', 'tool', f.callArgs),
    Call('named', 'tool2', f.callArgs, { tools: ['a'] }),
    Prompt('response', 'static text'),
    Prompt(max(6), toolHookBefore(f.hook), toolHookAfter(f.hook), disableAuto(), 'p2', f.text, { tools: ['b'] }),
    Check(f.check, flow),
    Register('lookup', 'find one', f.body, calls('echo'), parameters(schema)),
    Branch(when(f.cond), sub),
    Each('items', f.array, sub),
    Return(f.give),
    Until(f.until, max(5)),
    Until(goto('ask'), f.until, max(5)),
  );

  assert.deepEqual(tree.children.map((c) => c.kind), [
    'human', 'human', 'memory', 'memoryUpdate', 'memoryUpdate', 'emit', 'call',
    'call', 'prompt', 'prompt', 'check', 'branch', 'map', 'return', 'until', 'until',
  ]);
  assert.deepEqual(
    tree.models.map((r) => ({ gated: typeof r.cond === 'function', value: r.value })),
    [{ gated: false, value: 'strong' }, { gated: true, value: 'cheap' }],
  );
  assert.deepEqual(tree.tools.map((r) => r.value), [['a', 'b'], ['c']]);
  assert.deepEqual(tree.needs, ['input']);

  const plain = tree.children[8];
  assert.equal(plain.gate, null);
  assert.ok(!('auto' in plain), 'a plain prompt keeps its exact JSON shape');
  assert.deepEqual(plain.options, {});

  const configured = tree.children[9];
  assert.deepEqual(Object.keys(configured.auto), ['max', 'disabled', 'hooks']);
  assert.equal(configured.auto.max.count, 6);
  assert.equal(configured.auto.disabled, true);
  assert.equal(configured.auto.hooks.before[0].fn, f.hook);
  assert.deepEqual(configured.options, { tools: ['b'] });

  assert.equal(tree.children[3].gate, null, 'untouched children keep gate: null');
  assert.equal(tree.children[11].tree, sub, 'Branch holds the subtree by reference');
  assert.equal(tree.children[13].fn, f.give);
  assert.equal(tree.children[14].jumpType, null);
  assert.equal(tree.children[15].jumpType, 'goto');
  assert.equal(tree.children[15].jumpTarget, 'ask');

  assert.deepEqual(Object.keys(tree.registers[0]), ['name', 'description', 'parameters', 'calls', 'fn', 'position']);
  assert.equal(tree.registers[0].fn, f.body);
  assert.deepEqual(tree.registers[0].calls, ['echo']);
  assert.deepEqual(tree.registers[0].parameters, schema);
});

test('a def without registers never grows the registers key', () => {
  const text = () => 'x';
  const bare = Tree(name('plain'), Prompt('p', text));
  const tooled = Tree(name('plain'), Prompt('p', text), Register('lookup', 'd', () => 'x'));
  assert.ok(!('registers' in bare), 'a def that never registers keeps its exact JSON shape');
  assert.equal(tooled.registers.length, 1);
});

test('element directives patch the definition', () => {
  const tree = Tree(name('el_directives'), Model('cheap'), Tools('a', 'b'), Needs('input'));
  assert.ok(Tree.has('el_directives'), 'name(...) registers the tree');
  assert.equal(Tree.from('el_directives'), tree);
  assert.deepEqual(tree.models, [{ cond: null, value: 'cheap' }]);
  assert.deepEqual(tree.tools, [{ cond: null, value: ['a', 'b'], position: 0 }]);
  assert.deepEqual(tree.needs, ['input']);
});

// ── the element surface fails loudly at build time ─────────────────────────

test('nonsense is rejected where it is written', () => {
  assert.throws(() => Tree(42), /must be an element/);
  assert.throws(() => Tree(Prompt('x', () => 'y'), 42), /must be an element/);
  assert.throws(() => Register('x', 'y', () => 1, when(() => true)), /registers are declarations/);
  assert.throws(() => Prompt(when(() => true), when(() => true), 'x', () => 'y'), /when\(\) may appear only once/);
  assert.throws(() => Branch(), /expects a single tree argument/);
  assert.throws(() => Model('a', 'b'), /expects a model name/);
  assert.throws(() => name('bad#name'), /'#' is reserved/);
  assert.throws(() => Memory('slot'), /second argument must be a function/);
});

// ── element-built trees knit ───────────────────────────────────────────────

test('an element tree knots end to end (human → memory → emit → loop)', async () => {
  const dbPath = path.join(os.tmpdir(), `grandma-kat-elements-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  try {
    const emitted = [];
    const tree = Tree(
      name('el_demo'),
      Memory('seen', () => []),
      // The loop lives inside a branch so the seed above runs once.
      Branch(Tree(
        Human('input'),
        Memory(update(), 'seen', (m, cur) => [...(cur ?? []), String(m.input)]),
        Emit((m) => ({ text: `echo:${m.input} [${(m.seen ?? []).join('|')}]` })),
        Until(() => false, max(50)),
      )),
    );
    const rt = { ...mockRuntime(scripted([]), { logger: dbPath }), onEmit: (v) => emitted.push(v) };

    const first = await grandma.knit(tree, rt);
    assert.equal(first.status, 'waiting', 'paused at the human leaf');

    const second = await grandma.resume(first.continuation, { ...rt, humanInput: { input: 'hello' } });
    assert.equal(second.status, 'waiting', 'looped back to the human leaf');
    assert.equal(emitted.at(-1).text, 'echo:hello [hello]', 'the update wrote the slot');

    const third = await grandma.resume(second.continuation, { ...rt, humanInput: { input: 'again' } });
    assert.equal(third.status, 'waiting');
    assert.equal(emitted.at(-1).text, 'echo:again [hello|again]', 'the slot accumulates across pauses and loops');
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
});

test('an element Prompt runs the model and records its branch result', async () => {
  const handler = scripted(['42']);
  const tree = Tree(
    name('el_prompt'),
    Prompt('ask', () => 'what is the answer?'),
    Memory('answer', (m) => m.branch.ask),
  );
  const { memory } = await grandma.knit(tree, mockRuntime(handler));
  assert.equal(memory.answer, '42');
  assert.equal(handler.calls.length, 1);
});

test('element Register + Call resolve calls(...) at knit start', async () => {
  const seen = [];
  const tree = Tree(
    name('el_reg'),
    Register(
      'echo_it',
      'echo it back',
      async (m, args, tools) => ({ value: await tools.echo({ q: args.q }) }),
      calls('echo'),
    ),
    Call('got', 'echo_it', () => ({ q: 'hi' })),
    Memory('result', (m) => m.branch.got),
  );
  const { memory } = await grandma.knit(tree, mockRuntime(scripted([]), {
    tools: { echo: tool(async (args) => { seen.push(args); return `echo:${args.q}`; }) },
  }));
  assert.deepEqual(seen, [{ q: 'hi' }]);
  assert.deepEqual(memory.result, { value: 'echo:hi' });
});
