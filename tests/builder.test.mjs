import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Tree, when, goback, max } from '../src/index.mjs';

test('builder methods are immutable (copy-on-write)', () => {
  const base = Tree.name('base').prompt(m => 'a');
  const t1 = base.prompt(m => 'b');
  const t2 = base.prompt(m => 'c');

  assert.equal(base.def.children.length, 1);
  assert.equal(t1.def.children.length, 2);
  assert.equal(t2.def.children.length, 2);
  assert.notEqual(t1.def.children[1].prompt, t2.def.children[1].prompt);
});

test('.name() validates names', () => {
  assert.throws(() => Tree.name('has#hash'), /reserved/);
  assert.throws(() => Tree.name(''), /non-empty/);
});

test('.branch() requires a named tree', () => {
  assert.doesNotThrow(() => Tree.name('p').branch(Tree.name('c').prompt(m => 'x')));
  const b = Tree.name('parent');
  assert.throws(() => b.branch({ kind: 'tree', name: null, children: [], models: [], tools: [], untils: [], needs: [] }), /named/);
});

test('bare function in condition slot throws "did you mean when()?"', () => {
  assert.throws(
    () => Tree.name('a').prompt(m => 'x', m => 'y'),
    /did you mean when\(\)?/);
  assert.throws(
    () => Tree.name('a').model(m => true, 'cheap'),
    /did you mean when\(\)?/);
  // single-arg function is the value, not a condition — fine
  assert.doesNotThrow(() => Tree.name('a').prompt(m => 'x'));
  assert.doesNotThrow(() => Tree.name('a').until(m => true));
});

test('when() works in first and second position', () => {
  const t1 = Tree.name('a').prompt(when(m => true), m => 'x');
  assert.equal(typeof t1.def.children[0].gate, 'function');

  const t2 = Tree.name('a').prompt('named', when(m => true), m => 'x');
  assert.equal(t2.def.children[0].name, 'named');
  assert.equal(typeof t2.def.children[0].gate, 'function');
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

test('.check() defaults to goback(1) with default max', () => {
  const t = Tree.name('a').prompt(m => 'x').check(m => true);
  const check = t.def.children[1];
  assert.equal(check.kind, 'check');
  assert.equal(check.flow.n, 1);
  assert.equal(check.flow.max.count, 3);
});

test('.until() parses condition and max', () => {
  const t = Tree.name('a').prompt(m => 'x').until(m => true, max(5));
  const untilChild = t.def.children[1];
  assert.equal(untilChild.kind, 'until');
  assert.equal(untilChild.max.count, 5);
  assert.throws(() => Tree.name('a').prompt(m => 'x').until('nope'), /function/);
});

test('.needs() dedupes', () => {
  const t = Tree.name('a').needs('x', 'y', 'x');
  assert.deepEqual(t.def.needs, ['x', 'y']);
});

test('prompt options validate', () => {
  assert.throws(() => Tree.name('a').prompt(m => 'x', { bogus: 1 }), /unknown option/);
  assert.throws(() => Tree.name('a').prompt(m => 'x', { tools: 'nope' }), /array of strings/);
  assert.doesNotThrow(() => Tree.name('a').prompt(m => 'x', { tools: [] }));
});

test('registry: Tree.from() retrieves named trees', () => {
  Tree.name('registered').prompt(m => 'x');
  assert.equal(Tree.has('registered'), true);
  const t = Tree.from('registered');
  assert.equal(t.def.name, 'registered');
  // registry holds the latest definition (children added after .name())
  assert.equal(t.def.children.length, 1);
  assert.throws(() => Tree.from('nonexistent'), /no tree registered/);
});

test('.call() parses tool name and args', () => {
  const t = Tree.name('a').call('navigate', m => ({ url: 'x' }));
  const call = t.def.children[0];
  assert.equal(call.kind, 'call');
  assert.equal(call.tool, 'navigate');
  assert.equal(call.name, null);
  assert.throws(() => Tree.name('a').call(), /tool name/);
});

test('.call() supports optional name', () => {
  const t = Tree.name('a').call('get_page', 'exec_js', () => ({ code: '1' }));
  const c = t.def.children[0];
  assert.equal(c.kind, 'call');
  assert.equal(c.name, 'get_page');
  assert.equal(c.tool, 'exec_js');

  const g = Tree.name('b').call(when(m => true), 'get_page', 'exec_js', () => ({ code: '2' }));
  const gc = g.def.children[0];
  assert.equal(gc.name, 'get_page');
  assert.equal(gc.tool, 'exec_js');
  assert.equal(typeof gc.gate, 'function');
});

test('.memory() parses name and fn', () => {
  const t = Tree.name('a').prompt(m => 'x').memory('tried', (m, cur) => [...cur ?? [], m.prev[0]]);
  const mem = t.def.children[1];
  assert.equal(mem.kind, 'memory');
  assert.equal(mem.name, 'tried');
  assert.equal(typeof mem.fn, 'function');
  assert.equal(mem.gate, null);
});

test('.memory() supports when() gate', () => {
  const t = Tree.name('a').prompt(m => 'x').memory(when(m => true), 'tried', (m, cur) => cur ?? []);
  const mem = t.def.children[1];
  assert.equal(mem.kind, 'memory');
  assert.equal(mem.name, 'tried');
  assert.equal(typeof mem.gate, 'function');
});

test('.memory() validates arguments', () => {
  assert.throws(() => Tree.name('a').memory(), /slot name/);
  assert.throws(() => Tree.name('a').memory('x'), /function/);
  assert.throws(() => Tree.name('a').memory('has#hash', m => m), /reserved/);
});

test('.memoryUpdate() parses name and fn', () => {
  const t = Tree.name('a').prompt(m => 'x').memoryUpdate('tried', (m, cur) => [...cur, m.prev[0]]);
  const mem = t.def.children[1];
  assert.equal(mem.kind, 'memoryUpdate');
  assert.equal(mem.name, 'tried');
  assert.equal(typeof mem.fn, 'function');
  assert.equal(mem.gate, null);
});

test('.memoryUpdate() supports when() gate', () => {
  const t = Tree.name('a').prompt(m => 'x').memoryUpdate(when(m => true), 'tried', (m, cur) => cur);
  const mem = t.def.children[1];
  assert.equal(mem.kind, 'memoryUpdate');
  assert.equal(mem.name, 'tried');
  assert.equal(typeof mem.gate, 'function');
});

test('.memoryUpdate() validates arguments', () => {
  assert.throws(() => Tree.name('a').memoryUpdate(), /slot name/);
  assert.throws(() => Tree.name('a').memoryUpdate('x'), /function/);
  assert.throws(() => Tree.name('a').memoryUpdate('has#hash', m => m), /reserved/);
});

test('.return() parses fn', () => {
  const t = Tree.name('a').prompt(m => 'x').return(m => 'done');
  const ret = t.def.children[1];
  assert.equal(ret.kind, 'return');
  assert.equal(typeof ret.fn, 'function');
  assert.equal(ret.gate, null);
});

test('.return() supports when() gate', () => {
  const t = Tree.name('a').return(when(m => true), m => 'done');
  const ret = t.def.children[0];
  assert.equal(ret.kind, 'return');
  assert.equal(typeof ret.gate, 'function');
});

test('.return() validates arguments', () => {
  assert.throws(() => Tree.name('a').return(), /function/);
  assert.throws(() => Tree.name('a').return('not a fn'), /function/);
});

test('.map() parses name, arrayFn, and tree', () => {
  const sub = Tree.name('rate').prompt(m => `rate ${m.item}`);
  const t = Tree.name('a').map('rated', m => m.branch.items, sub);
  const map = t.def.children[0];
  assert.equal(map.kind, 'map');
  assert.equal(map.name, 'rated');
  assert.equal(typeof map.arrayFn, 'function');
  assert.equal(map.tree.name, 'rate');
  assert.equal(map.gate, null);
});

test('.map() supports when() gate', () => {
  const sub = Tree.name('rate').prompt(m => `rate ${m.item}`);
  const t = Tree.name('a').map(when(m => true), 'rated', m => [], sub);
  const map = t.def.children[0];
  assert.equal(map.kind, 'map');
  assert.equal(typeof map.gate, 'function');
});

test('.map() validates arguments', () => {
  const sub = Tree.name('rate').prompt(m => 'x');
  assert.throws(() => Tree.name('a').map(), /collection name/);
  assert.throws(() => Tree.name('a').map('x'), /array/);
  assert.throws(() => Tree.name('a').map('x', m => [], null), /expected a Tree/);
  // unnamed tree
  const unnamed = { kind: 'tree', name: null, children: [{ kind: 'prompt', name: null, prompt: 'x', gate: null }], models: [], tools: [], untils: [], needs: [] };
  assert.throws(() => Tree.name('a').map('x', m => [], unnamed), /named/);
  assert.throws(() => Tree.name('a').map('has#hash', m => [], sub), /reserved/);
});

test('.emit() parses fn', () => {
  const t = Tree.name('a').emit(m => ({ text: 'hi' }));
  const e = t.def.children[0];
  assert.equal(e.kind, 'emit');
  assert.equal(typeof e.fn, 'function');
  assert.equal(e.gate, null);
});

test('.emit() supports when() gate', () => {
  const t = Tree.name('a').emit(when(m => true), m => 'hi');
  const e = t.def.children[0];
  assert.equal(e.kind, 'emit');
  assert.equal(typeof e.gate, 'function');
});

test('.emit() validates arguments', () => {
  assert.throws(() => Tree.name('a').emit(), /function/);
  assert.throws(() => Tree.name('a').emit('not a fn'), /function/);
});
