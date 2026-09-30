// The element surface — the executable spec: Tree(element, …) builds the same
// definitions the chain builds (byte for byte, so definition ids and host
// session hashes do not churn), and element-built trees knit like any other.
//
// Scripted against mock models — no live LLM.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import grandma, {
  Tree, Name, Model, Tools, Needs, Human, Prompt, Memory, Register, Branch,
  Map, Call, Check, Emit, Return, Until,
  when, max, update, calls, parameters, disableAuto, toolHookBefore, toolHookAfter,
  goback, goto,
} from '../src/index.mjs';
import { scripted, mockRuntime, tool } from './helpers.mjs';

// ── both front-ends build the same definition ──────────────────────────────

test('a kitchen-sink element tree equals the chain tree, structurally', () => {
  // Every function is defined once and reused on both sides: the definitions
  // hold live functions, so equality only holds for the same references.
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
  const subChain = Tree.name('sub').prompt('leaf', f.text);
  const subElement = Tree(Name('sub'), Prompt('leaf', f.text));

  const chain = Tree.name('sink')
    .model('strong')
    .model(when(f.cond), 'cheap')
    .tools('a', 'b')
    .tools(when(f.cond), 'c')
    .needs('input')
    .human('ask')
    .human(when(f.cond), 'gated_ask', f.context)
    .memory('slot', f.mem)
    .memory(update(), 'slot', f.memUpdate)
    .memoryUpdate('slot', f.memUpdate)
    .emit(f.emit)
    .call('t', 'tool', f.callArgs)
    .call('named', 'tool2', f.callArgs, { tools: ['a'] })
    .prompt('response', 'static text')
    .prompt(max(6), toolHookBefore(f.hook), toolHookAfter(f.hook), disableAuto(), 'p2', f.text, { tools: ['b'] })
    .check(f.check, flow)
    .register('lookup', 'find one', f.body, calls('echo'), parameters(schema))
    .branch(when(f.cond), subChain)
    .map('items', f.array, subChain)
    .return(f.give)
    .until(f.until, max(5))
    .until(goto('ask'), f.until, max(5));

  const elements = Tree(
    Name('sink'),
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
    Branch(when(f.cond), subElement),
    Map('items', f.array, subElement),
    Return(f.give),
    Until(f.until, max(5)),
    Until(goto('ask'), f.until, max(5)),
  );

  assert.deepStrictEqual(elements.def, chain.def);
});

test('a def without registers never grows the registers key', () => {
  const text = () => 'x';
  const chain = Tree.name('plain').prompt('p', text);
  const elements = Tree(Name('plain'), Prompt('p', text));
  assert.deepStrictEqual(elements.def, chain.def);
  assert.ok(!('registers' in elements.def));
});

test('element directives patch the definition', () => {
  const tree = Tree(Name('el_directives'), Model('cheap'), Tools('a', 'b'), Needs('input'));
  assert.ok(Tree.has('el_directives'), 'Name(...) registers the tree');
  assert.equal(Tree.from('el_directives').def, tree.def);
  assert.deepEqual(tree.def.models, [{ cond: null, value: 'cheap' }]);
  assert.deepEqual(tree.def.tools, [{ cond: null, value: ['a', 'b'] }]);
  assert.deepEqual(tree.def.needs, ['input']);
});

// ── the element surface fails loudly at build time ─────────────────────────

test('nonsense is rejected where it is written', () => {
  assert.throws(() => Tree(42), /must be an element/);
  assert.throws(() => Tree(Prompt('x', () => 'y'), 42), /must be an element/);
  assert.throws(() => Register('x', 'y', () => 1, when(() => true)), /registers are declarations/);
  assert.throws(() => Prompt(when(() => true), when(() => true), 'x', () => 'y'), /when\(\) may appear only once/);
  assert.throws(() => Branch(), /expects a single tree argument/);
  assert.throws(() => Model('a', 'b'), /expects a model name/);
  assert.throws(() => Name('bad#name'), /'#' is reserved/);
  assert.throws(() => Memory('slot'), /second argument must be a function/);
});

// ── element-built trees knit ───────────────────────────────────────────────

test('an element tree knots end to end (human → memory → emit → loop)', async () => {
  const dbPath = path.join(os.tmpdir(), `grandma-kat-elements-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  try {
    const emitted = [];
    const tree = Tree(
      Name('el_demo'),
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
    Name('el_prompt'),
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
    Name('el_reg'),
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
