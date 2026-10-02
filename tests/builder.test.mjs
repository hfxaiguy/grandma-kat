import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Tree, when, update, goback, max, calls, parameters, name, Model, Tools, Needs, Human, Prompt, Memory, Register, Branch, Each, Call, Check, Emit, Return, Until, description, optional } from '../src/index.mjs';

test('definitions are immutable: building never mutates shared trees', () => {
  const sub = Tree(name('sub'), Prompt(m => 'x'));
  const frozen = JSON.stringify(sub);
  const parent = Tree(name('p'), Branch(sub), Prompt(m => 'y'));
  const sibling = Tree(name('p'), Branch(sub), Prompt(m => 'z'));

  assert.equal(JSON.stringify(sub), frozen, 'the shared subtree is untouched');
  assert.equal(parent.children.length, 2);
  assert.equal(sibling.children.length, 2);
  assert.notEqual(parent.children[1].prompt, sibling.children[1].prompt);
  assert.equal(parent.children[0].tree, sub, 'the branch holds the subtree by reference');
});

test('name() validates names', () => {
  assert.throws(() => Tree(name('has#hash')), /reserved/);
  assert.throws(() => Tree(name('')), /non-empty/);
});

test('Branch() accepts an unnamed tree', () => {
  assert.doesNotThrow(() => Tree(name('p'), Branch(Tree(name('c'), Prompt(m => 'x')))));
  // An unnamed tree is just Tree(...) without name().
  const b = Tree(name('parent'), Branch(Tree(Prompt(m => 'x'))));
  assert.equal(b.children[0].name, null);
  assert.equal(b.children[0].tree.name, null);
  // knit() assigns the name at build time (covered in runner.test.mjs).
});

test('bare function in condition slot throws "did you mean when()?"', () => {
  assert.throws(
    () => Tree(name('a'), Prompt(m => 'x', m => 'y')),
    /did you mean when\(\)?/);
  assert.throws(
    () => Tree(name('a'), Model(m => true, 'cheap')),
    /did you mean when\(\)?/);
  // single-arg function is the value, not a condition — fine
  assert.doesNotThrow(() => Tree(name('a'), Prompt(m => 'x')));
  assert.doesNotThrow(() => Tree(name('a'), Until(m => true)));
});

test('when() works anywhere among the arguments', () => {
  const t1 = Tree(name('a'), Prompt(when(m => true), m => 'x'));
  assert.equal(typeof t1.children[0].gate, 'function');

  const t2 = Tree(name('a'), Prompt('named', when(m => true), m => 'x'));
  assert.equal(t2.children[0].name, 'named');
  assert.equal(typeof t2.children[0].gate, 'function');

  const t3 = Tree(name('a'), Prompt('named', m => 'x', when(m => true)));
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
  const t = Tree(name('a'), Prompt(m => 'x'), Check(m => true));
  const check = t.children[1];
  assert.equal(check.kind, 'check');
  assert.equal(check.flow.n, 1);
  assert.equal(check.flow.max.count, 3);
});

test('Until() parses condition and max', () => {
  const t = Tree(name('a'), Prompt(m => 'x'), Until(m => true, max(5)));
  const untilChild = t.children[1];
  assert.equal(untilChild.kind, 'until');
  assert.equal(untilChild.max.count, 5);
  assert.throws(() => Tree(name('a'), Prompt(m => 'x'), Until('nope')), /function/);
});

test('Needs() declares one input per call, merged across calls', () => {
  const t = Tree(name('a'), Needs('x'), Needs('y'), Needs('x'));
  assert.deepEqual(t.needs, ['x', 'y']);
  assert.throws(() => Tree(name('a'), Needs('x', 'y')), /one input per call/);
});

test('Needs() carries a description per slot', () => {
  const t = Tree(name('a'), Needs('input', description('the user message')), Needs('company', description('an optional company')));
  assert.deepEqual(t.needs, ['input', 'company']);
  assert.deepEqual(t.needsDescriptions, { input: 'the user message', company: 'an optional company' });

  // No marker: the def keeps its exact old shape (no needsDescriptions key).
  assert.equal('needsDescriptions' in Tree(name('a'), Needs('x')), false);
});

test('Needs() marks a slot optional', () => {
  const t = Tree(name('a'), Needs('input', description('the message')), Needs('tone', optional(), description('voice')));
  assert.deepEqual(t.needs, ['input', 'tone']);
  assert.deepEqual(t.needsOptional, ['tone']);
  assert.deepEqual(t.needsDescriptions, { input: 'the message', tone: 'voice' });

  // Markers may appear in either order after the name.
  assert.deepEqual(Tree(name('a'), Needs('tone', description('voice'), optional())).needsOptional, ['tone']);

  // No marker: the def keeps its exact old shape (no needsOptional key).
  assert.equal('needsOptional' in Tree(name('a'), Needs('x')), false);
  // Repeated Needs() calls merge their optional lists.
  const merged = Tree(name('m'), Needs('a', optional()), Needs('b', optional()));
  assert.deepEqual(merged.needs, ['a', 'b']);
  assert.deepEqual(merged.needsOptional, ['a', 'b']);
});

test('Needs() validates optional placement', () => {
  assert.throws(() => Tree(name('a'), Needs(optional())), /must follow/);
  assert.throws(() => Tree(name('a'), Needs('x', optional(), optional())), /already optional/);
});

test('Needs() validates description placement', () => {
  assert.throws(() => Tree(name('a'), Needs(description('whoops'))), /must follow/);
  assert.throws(
    () => Tree(name('a'), Needs('x', description('one'), description('two'))),
    /already has a description/,
  );
  assert.throws(() => Tree(name('a'), Needs('x', description(''))), /non-empty/);
  assert.throws(() => Tree(name('a'), Needs('x', 42)), /expects one name/);
});

test('Register() validates its arguments', () => {
  const ok = Tree(name('r1'), Register('lookup', 'Find a person', () => 'x'));
  assert.equal(ok.registers.length, 1);
  assert.equal(ok.registers[0].name, 'lookup');
  assert.equal(ok.registers[0].description, 'Find a person');
  assert.deepEqual(ok.registers[0].parameters, { type: 'object', properties: {} });

  assert.throws(() => Tree(name('r2'), Register('', 'd', () => 'x')), /tool name/);
  assert.throws(() => Tree(name('r2'), Register('has#hash', 'd', () => 'x')), /reserved/);
  assert.throws(() => Tree(name('r2'), Register('n', '', () => 'x')), /description/);
  assert.throws(() => Tree(name('r2'), Register('n', 'd', 'not a fn')), /tool function/);
  assert.throws(
    () => Tree(name('r2'), Register(when(() => true), 'n', 'd', () => 'x')),
    /declarations/);
  assert.throws(() => Tree(name('r2'), Register('n', 'd', () => 'x', { bogus: 1 })), /unexpected argument/);
  assert.throws(() => Tree(name('r2'), Register('n', 'd', () => 'x', parameters([]))), /JSON-schema/);
  assert.throws(() => Tree(name('r2'), Register('n', 'd', () => 'x', calls(''))), /non-empty/);
  assert.throws(
    () => Tree(name('r2'), Register('n', 'd', () => 'x', parameters({}), parameters({}))),
    /only appear once/);
  const marked = Tree(name('r2'), Register(
    'n', 'd', () => 'x', calls('sql_query'), parameters({ type: 'object', properties: { q: { type: 'string' } } })));
  assert.deepEqual(marked.registers[0].calls, ['sql_query']);
  assert.deepEqual(marked.registers[0].parameters, { type: 'object', properties: { q: { type: 'string' } } });
});

test('registers are absent until used and never shared', () => {
  const base = Tree(name('r3'), Prompt(m => 'x'));
  assert.ok(!('registers' in base), 'a def that never registers keeps its exact JSON shape');
  const withTool = Tree(name('r3'), Prompt(m => 'x'), Register('lookup', 'Find a person', () => 'x'));
  assert.equal(base.registers, undefined, 'the earlier definition is untouched');
  assert.equal(withTool.registers.length, 1);
  const withTwo = Tree(
    name('r3'), Prompt(m => 'x'),
    Register('lookup', 'Find a person', () => 'x'),
    Register('other', 'Another', () => 'y'));
  assert.equal(withTool.registers.length, 1);
  assert.equal(withTwo.registers.length, 2);
});

test('prompt options validate', () => {
  assert.throws(() => Tree(name('a'), Prompt(m => 'x', { bogus: 1 })), /unknown option/);
  assert.throws(() => Tree(name('a'), Prompt(m => 'x', { tools: 'nope' })), /array of strings/);
  assert.doesNotThrow(() => Tree(name('a'), Prompt(m => 'x', { tools: [] })));
});

test('registry: Tree.from() retrieves named trees', () => {
  Tree(name('registered'), Prompt(m => 'x'));
  assert.equal(Tree.has('registered'), true);
  const t = Tree.from('registered');
  assert.equal(t.name, 'registered');
  // The registry holds the latest definition built under that name.
  assert.equal(t.children.length, 1);
  assert.throws(() => Tree.from('nonexistent'), /no tree registered/);
});

test('Call() parses tool name and args', () => {
  const t = Tree(name('a'), Call('navigate', m => ({ url: 'x' })));
  const call = t.children[0];
  assert.equal(call.kind, 'call');
  assert.equal(call.tool, 'navigate');
  assert.equal(call.name, null);
  assert.throws(() => Tree(name('a'), Call()), /tool name/);
});

test('Call() supports optional name', () => {
  const t = Tree(name('a'), Call('get_page', 'exec_js', () => ({ code: '1' })));
  const c = t.children[0];
  assert.equal(c.kind, 'call');
  assert.equal(c.name, 'get_page');
  assert.equal(c.tool, 'exec_js');

  const g = Tree(name('b'), Call(when(m => true), 'get_page', 'exec_js', () => ({ code: '2' })));
  const gc = g.children[0];
  assert.equal(gc.name, 'get_page');
  assert.equal(gc.tool, 'exec_js');
  assert.equal(typeof gc.gate, 'function');
});

test('Memory() parses name and fn', () => {
  const t = Tree(name('a'), Prompt(m => 'x'), Memory('tried', (m, cur) => [...cur ?? [], m.prev[0]]));
  const mem = t.children[1];
  assert.equal(mem.kind, 'memory');
  assert.equal(mem.name, 'tried');
  assert.equal(typeof mem.fn, 'function');
  assert.equal(mem.gate, null);
});

test('Memory() supports when() gate', () => {
  const t = Tree(name('a'), Prompt(m => 'x'), Memory(when(m => true), 'tried', (m, cur) => cur ?? []));
  const mem = t.children[1];
  assert.equal(mem.kind, 'memory');
  assert.equal(mem.name, 'tried');
  assert.equal(typeof mem.gate, 'function');
});

test('Memory() validates arguments', () => {
  assert.throws(() => Tree(name('a'), Memory()), /slot name/);
  assert.throws(() => Tree(name('a'), Memory('x')), /function/);
  assert.throws(() => Tree(name('a'), Memory('has#hash', m => m)), /reserved/);
});

test('Memory(update(), name, fn) parses as a memoryUpdate leaf', () => {
  const t = Tree(name('a'), Prompt(m => 'x'), Memory(update(), 'tried', (m, cur) => [...cur, m.prev[0]]));
  const mem = t.children[1];
  assert.equal(mem.kind, 'memoryUpdate');
  assert.equal(mem.name, 'tried');
  assert.equal(typeof mem.fn, 'function');
  assert.equal(mem.gate, null);
});

test('Memory(name, update(), fn) parses as a memoryUpdate leaf too', () => {
  const t = Tree(name('a'), Prompt(m => 'x'), Memory('tried', update(), (m, cur) => cur));
  assert.equal(t.children[1].kind, 'memoryUpdate');
  assert.equal(t.children[1].name, 'tried');
});

test('Memory(update(), …) supports the when() gate', () => {
  const t = Tree(name('a'), Prompt(m => 'x'), Memory(when(m => true), update(), 'tried', (m, cur) => cur));
  const mem = t.children[1];
  assert.equal(mem.kind, 'memoryUpdate');
  assert.equal(typeof mem.gate, 'function');
});

test('Memory(update(), when(…), …) also gates — markers go anywhere', () => {
  const t = Tree(name('a'), Prompt(m => 'x'), Memory(update(), when(m => true), 'tried', (m, cur) => cur));
  const mem = t.children[1];
  assert.equal(mem.kind, 'memoryUpdate');
  assert.equal(typeof mem.gate, 'function');
});

test('Memory(update(), …) validates arguments', () => {
  assert.throws(() => Tree(name('a'), Memory(update())), /slot name/);
  assert.throws(() => Tree(name('a'), Memory(update(), 'x')), /fn must be a function/);
  assert.throws(() => Tree(name('a'), Memory(update(), 'has#hash', m => m)), /reserved/);
  // update() may sit anywhere among the arguments.
  const t = Tree(name('a'), Prompt(m => 'x'), Memory('tried', update(), (m, cur) => cur));
  assert.equal(t.children[1].kind, 'memoryUpdate');
});

test('Return() parses fn', () => {
  const t = Tree(name('a'), Prompt(m => 'x'), Return(m => 'done'));
  const ret = t.children[1];
  assert.equal(ret.kind, 'return');
  assert.equal(typeof ret.fn, 'function');
  assert.equal(ret.gate, null);
});

test('Return() supports when() gate', () => {
  const t = Tree(name('a'), Return(when(m => true), m => 'done'));
  const ret = t.children[0];
  assert.equal(ret.kind, 'return');
  assert.equal(typeof ret.gate, 'function');
});

test('Return() validates arguments', () => {
  assert.throws(() => Tree(name('a'), Return()), /function/);
  assert.throws(() => Tree(name('a'), Return('not a fn')), /function/);
});

test('Each() parses name, arrayFn, and tree', () => {
  const sub = Tree(name('rate'), Prompt(m => `rate ${m.item}`));
  const t = Tree(name('a'), Each('rated', m => m.branch.items, sub));
  const map = t.children[0];
  assert.equal(map.kind, 'map');
  assert.equal(map.name, 'rated');
  assert.equal(typeof map.arrayFn, 'function');
  assert.equal(map.tree.name, 'rate');
  assert.equal(map.gate, null);
});

test('Each() supports when() gate', () => {
  const sub = Tree(name('rate'), Prompt(m => `rate ${m.item}`));
  const t = Tree(name('a'), Each(when(m => true), 'rated', m => [], sub));
  const map = t.children[0];
  assert.equal(map.kind, 'map');
  assert.equal(typeof map.gate, 'function');
});

test('Each() validates arguments', () => {
  const sub = Tree(name('rate'), Prompt(m => 'x'));
  assert.throws(() => Tree(name('a'), Each()), /collection name/);
  assert.throws(() => Tree(name('a'), Each('x')), /array/);
  assert.throws(() => Tree(name('a'), Each('x', m => [], null)), /expected a Tree/);
  assert.doesNotThrow(() => Tree(name('a'), Each('x', m => [], Tree(Prompt(m => 'y')))));
  assert.throws(() => Tree(name('a'), Each('has#hash', m => [], sub)), /reserved/);
});

test('Emit() parses fn', () => {
  const t = Tree(name('a'), Emit(m => ({ text: 'hi' })));
  const e = t.children[0];
  assert.equal(e.kind, 'emit');
  assert.equal(typeof e.fn, 'function');
  assert.equal(e.gate, null);
});

test('Emit() supports when() gate', () => {
  const t = Tree(name('a'), Emit(when(m => true), m => 'hi'));
  const e = t.children[0];
  assert.equal(e.kind, 'emit');
  assert.equal(typeof e.gate, 'function');
});

test('Emit() validates arguments', () => {
  assert.throws(() => Tree(name('a'), Emit()), /function/);
  assert.throws(() => Tree(name('a'), Emit('not a fn')), /function/);
});
