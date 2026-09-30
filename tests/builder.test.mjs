import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Tree, when, update, goback, max, calls, parameters, Name, Model, Tools, Needs, Human, Prompt, Memory, Register, Branch, Map, Call, Check, Emit, Return, Until } from '../src/index.mjs';

test('definitions are immutable: building never mutates shared trees', () => {
  const sub = Tree(Name('sub'), Prompt(m => 'x'));
  const frozen = JSON.stringify(sub);
  const parent = Tree(Name('p'), Branch(sub), Prompt(m => 'y'));
  const sibling = Tree(Name('p'), Branch(sub), Prompt(m => 'z'));

  assert.equal(JSON.stringify(sub), frozen, 'the shared subtree is untouched');
  assert.equal(parent.children.length, 2);
  assert.equal(sibling.children.length, 2);
  assert.notEqual(parent.children[1].prompt, sibling.children[1].prompt);
  assert.equal(parent.children[0].tree, sub, 'the branch holds the subtree by reference');
});

test('Name() validates names', () => {
  assert.throws(() => Tree(Name('has#hash')), /reserved/);
  assert.throws(() => Tree(Name('')), /non-empty/);
});

test('Branch() accepts an unnamed tree', () => {
  assert.doesNotThrow(() => Tree(Name('p'), Branch(Tree(Name('c'), Prompt(m => 'x')))));
  // An unnamed tree is just Tree(...) without Name().
  const b = Tree(Name('parent'), Branch(Tree(Prompt(m => 'x'))));
  assert.equal(b.children[0].name, null);
  assert.equal(b.children[0].tree.name, null);
  // knit() assigns the name at build time (covered in runner.test.mjs).
});

test('bare function in condition slot throws "did you mean when()?"', () => {
  assert.throws(
    () => Tree(Name('a'), Prompt(m => 'x', m => 'y')),
    /did you mean when\(\)?/);
  assert.throws(
    () => Tree(Name('a'), Model(m => true, 'cheap')),
    /did you mean when\(\)?/);
  // single-arg function is the value, not a condition — fine
  assert.doesNotThrow(() => Tree(Name('a'), Prompt(m => 'x')));
  assert.doesNotThrow(() => Tree(Name('a'), Until(m => true)));
});

test('when() works anywhere among the arguments', () => {
  const t1 = Tree(Name('a'), Prompt(when(m => true), m => 'x'));
  assert.equal(typeof t1.children[0].gate, 'function');

  const t2 = Tree(Name('a'), Prompt('named', when(m => true), m => 'x'));
  assert.equal(t2.children[0].name, 'named');
  assert.equal(typeof t2.children[0].gate, 'function');

  const t3 = Tree(Name('a'), Prompt('named', m => 'x', when(m => true)));
  assert.equal(t3.children[0].name, 'named');
  assert.equal(typeof t3.children[0].gate, 'function');
});

test('markers validate their arguments', () => {
  assert.throws(() => when('not a fn'), /function/);
  assert.throws(() => goback(0), /positive integer/);
  assert.throws(() => goback(1.5), /positive integer/);
  assert.throws(() => goback(1, 'nope'), /max\(/);
  assert.throws(() => max(0), /positive integer/);
  assert.throws(() => max(3, 'nope'), /function/);
  assert.doesNotThrow(() => goback(1, max(3)));
});

test('Check() defaults to goback(1) with default max', () => {
  const t = Tree(Name('a'), Prompt(m => 'x'), Check(m => true));
  const check = t.children[1];
  assert.equal(check.kind, 'check');
  assert.equal(check.flow.n, 1);
  assert.equal(check.flow.max.count, 3);
});

test('Until() parses condition and max', () => {
  const t = Tree(Name('a'), Prompt(m => 'x'), Until(m => true, max(5)));
  const untilChild = t.children[1];
  assert.equal(untilChild.kind, 'until');
  assert.equal(untilChild.max.count, 5);
  assert.throws(() => Tree(Name('a'), Prompt(m => 'x'), Until('nope')), /function/);
});

test('Needs() dedupes', () => {
  const t = Tree(Name('a'), Needs('x', 'y', 'x'));
  assert.deepEqual(t.needs, ['x', 'y']);
});

test('Register() validates its arguments', () => {
  const ok = Tree(Name('r1'), Register('lookup', 'Find a person', () => 'x'));
  assert.equal(ok.registers.length, 1);
  assert.equal(ok.registers[0].name, 'lookup');
  assert.equal(ok.registers[0].description, 'Find a person');
  assert.deepEqual(ok.registers[0].parameters, { type: 'object', properties: {} });

  assert.throws(() => Tree(Name('r2'), Register('', 'd', () => 'x')), /tool name/);
  assert.throws(() => Tree(Name('r2'), Register('has#hash', 'd', () => 'x')), /reserved/);
  assert.throws(() => Tree(Name('r2'), Register('n', '', () => 'x')), /description/);
  assert.throws(() => Tree(Name('r2'), Register('n', 'd', 'not a fn')), /tool function/);
  assert.throws(
    () => Tree(Name('r2'), Register(when(() => true), 'n', 'd', () => 'x')),
    /declarations/);
  assert.throws(() => Tree(Name('r2'), Register('n', 'd', () => 'x', { bogus: 1 })), /unexpected argument/);
  assert.throws(() => Tree(Name('r2'), Register('n', 'd', () => 'x', parameters([]))), /JSON-schema/);
  assert.throws(() => Tree(Name('r2'), Register('n', 'd', () => 'x', calls(''))), /non-empty/);
  assert.throws(
    () => Tree(Name('r2'), Register('n', 'd', () => 'x', parameters({}), parameters({}))),
    /only appear once/);
  const marked = Tree(Name('r2'), Register(
    'n', 'd', () => 'x', calls('sql_query'), parameters({ type: 'object', properties: { q: { type: 'string' } } })));
  assert.deepEqual(marked.registers[0].calls, ['sql_query']);
  assert.deepEqual(marked.registers[0].parameters, { type: 'object', properties: { q: { type: 'string' } } });
});

test('registers are absent until used and never shared', () => {
  const base = Tree(Name('r3'), Prompt(m => 'x'));
  assert.ok(!('registers' in base), 'a def that never registers keeps its exact JSON shape');
  const withTool = Tree(Name('r3'), Prompt(m => 'x'), Register('lookup', 'Find a person', () => 'x'));
  assert.equal(base.registers, undefined, 'the earlier definition is untouched');
  assert.equal(withTool.registers.length, 1);
  const withTwo = Tree(
    Name('r3'), Prompt(m => 'x'),
    Register('lookup', 'Find a person', () => 'x'),
    Register('other', 'Another', () => 'y'));
  assert.equal(withTool.registers.length, 1);
  assert.equal(withTwo.registers.length, 2);
});

test('prompt options validate', () => {
  assert.throws(() => Tree(Name('a'), Prompt(m => 'x', { bogus: 1 })), /unknown option/);
  assert.throws(() => Tree(Name('a'), Prompt(m => 'x', { tools: 'nope' })), /array of strings/);
  assert.doesNotThrow(() => Tree(Name('a'), Prompt(m => 'x', { tools: [] })));
});

test('registry: Tree.from() retrieves named trees', () => {
  Tree(Name('registered'), Prompt(m => 'x'));
  assert.equal(Tree.has('registered'), true);
  const t = Tree.from('registered');
  assert.equal(t.name, 'registered');
  // The registry holds the latest definition built under that name.
  assert.equal(t.children.length, 1);
  assert.throws(() => Tree.from('nonexistent'), /no tree registered/);
});

test('Call() parses tool name and args', () => {
  const t = Tree(Name('a'), Call('navigate', m => ({ url: 'x' })));
  const call = t.children[0];
  assert.equal(call.kind, 'call');
  assert.equal(call.tool, 'navigate');
  assert.equal(call.name, null);
  assert.throws(() => Tree(Name('a'), Call()), /tool name/);
});

test('Call() supports optional name', () => {
  const t = Tree(Name('a'), Call('get_page', 'exec_js', () => ({ code: '1' })));
  const c = t.children[0];
  assert.equal(c.kind, 'call');
  assert.equal(c.name, 'get_page');
  assert.equal(c.tool, 'exec_js');

  const g = Tree(Name('b'), Call(when(m => true), 'get_page', 'exec_js', () => ({ code: '2' })));
  const gc = g.children[0];
  assert.equal(gc.name, 'get_page');
  assert.equal(gc.tool, 'exec_js');
  assert.equal(typeof gc.gate, 'function');
});

test('Memory() parses name and fn', () => {
  const t = Tree(Name('a'), Prompt(m => 'x'), Memory('tried', (m, cur) => [...cur ?? [], m.prev[0]]));
  const mem = t.children[1];
  assert.equal(mem.kind, 'memory');
  assert.equal(mem.name, 'tried');
  assert.equal(typeof mem.fn, 'function');
  assert.equal(mem.gate, null);
});

test('Memory() supports when() gate', () => {
  const t = Tree(Name('a'), Prompt(m => 'x'), Memory(when(m => true), 'tried', (m, cur) => cur ?? []));
  const mem = t.children[1];
  assert.equal(mem.kind, 'memory');
  assert.equal(mem.name, 'tried');
  assert.equal(typeof mem.gate, 'function');
});

test('Memory() validates arguments', () => {
  assert.throws(() => Tree(Name('a'), Memory()), /slot name/);
  assert.throws(() => Tree(Name('a'), Memory('x')), /function/);
  assert.throws(() => Tree(Name('a'), Memory('has#hash', m => m)), /reserved/);
});

test('Memory(update(), name, fn) parses as a memoryUpdate leaf', () => {
  const t = Tree(Name('a'), Prompt(m => 'x'), Memory(update(), 'tried', (m, cur) => [...cur, m.prev[0]]));
  const mem = t.children[1];
  assert.equal(mem.kind, 'memoryUpdate');
  assert.equal(mem.name, 'tried');
  assert.equal(typeof mem.fn, 'function');
  assert.equal(mem.gate, null);
});

test('Memory(name, update(), fn) parses as a memoryUpdate leaf too', () => {
  const t = Tree(Name('a'), Prompt(m => 'x'), Memory('tried', update(), (m, cur) => cur));
  assert.equal(t.children[1].kind, 'memoryUpdate');
  assert.equal(t.children[1].name, 'tried');
});

test('Memory(update(), …) supports the when() gate', () => {
  const t = Tree(Name('a'), Prompt(m => 'x'), Memory(when(m => true), update(), 'tried', (m, cur) => cur));
  const mem = t.children[1];
  assert.equal(mem.kind, 'memoryUpdate');
  assert.equal(typeof mem.gate, 'function');
});

test('Memory(update(), when(…), …) also gates — markers go anywhere', () => {
  const t = Tree(Name('a'), Prompt(m => 'x'), Memory(update(), when(m => true), 'tried', (m, cur) => cur));
  const mem = t.children[1];
  assert.equal(mem.kind, 'memoryUpdate');
  assert.equal(typeof mem.gate, 'function');
});

test('Memory(update(), …) validates arguments', () => {
  assert.throws(() => Tree(Name('a'), Memory(update())), /slot name/);
  assert.throws(() => Tree(Name('a'), Memory(update(), 'x')), /fn must be a function/);
  assert.throws(() => Tree(Name('a'), Memory(update(), 'has#hash', m => m)), /reserved/);
  // update() may sit anywhere among the arguments.
  const t = Tree(Name('a'), Prompt(m => 'x'), Memory('tried', update(), (m, cur) => cur));
  assert.equal(t.children[1].kind, 'memoryUpdate');
});

test('Return() parses fn', () => {
  const t = Tree(Name('a'), Prompt(m => 'x'), Return(m => 'done'));
  const ret = t.children[1];
  assert.equal(ret.kind, 'return');
  assert.equal(typeof ret.fn, 'function');
  assert.equal(ret.gate, null);
});

test('Return() supports when() gate', () => {
  const t = Tree(Name('a'), Return(when(m => true), m => 'done'));
  const ret = t.children[0];
  assert.equal(ret.kind, 'return');
  assert.equal(typeof ret.gate, 'function');
});

test('Return() validates arguments', () => {
  assert.throws(() => Tree(Name('a'), Return()), /function/);
  assert.throws(() => Tree(Name('a'), Return('not a fn')), /function/);
});

test('Map() parses name, arrayFn, and tree', () => {
  const sub = Tree(Name('rate'), Prompt(m => `rate ${m.item}`));
  const t = Tree(Name('a'), Map('rated', m => m.branch.items, sub));
  const map = t.children[0];
  assert.equal(map.kind, 'map');
  assert.equal(map.name, 'rated');
  assert.equal(typeof map.arrayFn, 'function');
  assert.equal(map.tree.name, 'rate');
  assert.equal(map.gate, null);
});

test('Map() supports when() gate', () => {
  const sub = Tree(Name('rate'), Prompt(m => `rate ${m.item}`));
  const t = Tree(Name('a'), Map(when(m => true), 'rated', m => [], sub));
  const map = t.children[0];
  assert.equal(map.kind, 'map');
  assert.equal(typeof map.gate, 'function');
});

test('Map() validates arguments', () => {
  const sub = Tree(Name('rate'), Prompt(m => 'x'));
  assert.throws(() => Tree(Name('a'), Map()), /collection name/);
  assert.throws(() => Tree(Name('a'), Map('x')), /array/);
  assert.throws(() => Tree(Name('a'), Map('x', m => [], null)), /expected a Tree/);
  assert.doesNotThrow(() => Tree(Name('a'), Map('x', m => [], Tree(Prompt(m => 'y')))));
  assert.throws(() => Tree(Name('a'), Map('has#hash', m => [], sub)), /reserved/);
});

test('Emit() parses fn', () => {
  const t = Tree(Name('a'), Emit(m => ({ text: 'hi' })));
  const e = t.children[0];
  assert.equal(e.kind, 'emit');
  assert.equal(typeof e.fn, 'function');
  assert.equal(e.gate, null);
});

test('Emit() supports when() gate', () => {
  const t = Tree(Name('a'), Emit(when(m => true), m => 'hi'));
  const e = t.children[0];
  assert.equal(e.kind, 'emit');
  assert.equal(typeof e.gate, 'function');
});

test('Emit() validates arguments', () => {
  assert.throws(() => Tree(Name('a'), Emit()), /function/);
  assert.throws(() => Tree(Name('a'), Emit('not a fn')), /function/);
});
