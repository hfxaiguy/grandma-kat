// From('name', [memory(fn)]) — attaching a registered tree as if it were a
// branch, with an entry-time memory patch for the import's own scope.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import grandma, {
  Tree, From, name, Model, Prompt, Memory, Needs, Human, Branch, Each, Return, Emit, when, memory,
} from '../src/index.mjs';

const mockModel = (text) => ({ model: 'mock', handler: async () => ({ content: text }) });
const models = { mock: mockModel('hello') };
const logPath = () =>
  path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kat-from-')), 'log.db');

// Registered by building it (name() registers; nothing else is required).
const inner = Tree(
  name('from_inner'),
  Needs('input'),
  Model('mock'),
  Prompt((m) => `say ${m.input}`),
  Return((m) => m.prev[0]),
);

test('From(name) attaches a registered tree like a branch', async () => {
  const tree = Tree(name('from_outer'), From('from_inner'), Return((m) => m.prev[0]));
  const out = await grandma.knit(tree, { memory: { input: 'hi' }, models, logger: false });
  assert.equal(out.result, 'hello');
  assert.equal(out.memory.from_inner, 'hello', 'the value lands under the tree name');
});

test('From(name) builds the same branch record as Branch(def)', () => {
  const viaFrom = Tree(name('from_a'), From('from_inner'));
  const viaBranch = Tree(name('from_b'), Branch(inner));
  assert.deepEqual(viaFrom.children[0], viaBranch.children[0]);
  assert.equal(viaFrom.children[0].memory, undefined, 'no memory field without memory()');
});

test("From(name, memory(fn)) seeds the import's own scope at entry", async () => {
  const seeded = Tree(name('from_seeded'), Needs('input'), Model('mock'), Return((m) => `got:${m.input}`));
  const tree = Tree(
    name('from_outer_seeded'),
    // No `input` in the root memory: the seed is what satisfies Needs('input').
    From('from_seeded', memory((m) => ({ input: `from ${m.tag}` }))),
    Return((m) => m.prev[0]),
  );
  const out = await grandma.knit(tree, { memory: { tag: 'outer' }, models, logger: false });
  assert.equal(out.result, 'got:from outer');
});

test('memory(m => ({ ...m })) snapshots the chain into the import', async () => {
  const sees = Tree(name('from_sees'), Needs('tag'), Model('mock'), Return((m) => `tag:${m.tag}`));
  const tree = Tree(
    name('from_outer_snap'),
    Memory('tag', () => 'outer-tag'),
    From('from_sees', memory((m) => ({ ...m }))),
    Return((m) => m.prev[0]),
  );
  const out = await grandma.knit(tree, { memory: {}, models, logger: false });
  assert.equal(out.result, 'tag:outer-tag');
});

test('From() is a positional step: when() gates it, the value flows like a branch', async () => {
  const tree = Tree(
    name('from_gated'),
    From(when((m) => m.useSeed), 'from_seeded', memory(() => ({ input: 'gated run' }))),
    From(when((m) => !m.useSeed), 'from_inner'),
    Return((m) => m.prev[0]),
  );
  const out = await grandma.knit(tree, { memory: { useSeed: true, input: 'fallback' }, models, logger: false });
  assert.equal(out.result, 'got:gated run');
});

test('an unregistered name throws at build time', () => {
  assert.throws(() => From('from_nope'), /no tree registered under name 'from_nope'/);
  assert.throws(() => From(), /expects one registered tree name/);
  assert.throws(() => From('from_inner', memory(() => ({})), when(() => true), 'extra'), /expects one registered tree name/);
});

test('a bare element is shorthand for Tree(element) in Branch/Each slots', async () => {
  // Branch(Prompt(...)) and Each(name, fn, From(...)) both normalize.
  const tree = Tree(
    name('shorthand_outer'),
    Branch(Prompt(() => 'asked')),
    Each('copies', () => [1, 2], From('from_inner')),
    Return((m) => ({ mapped: m.branch.copies, direct: m.prev[1] })),
  );
  const out = await grandma.knit(tree, { memory: { input: 'hi' }, models, logger: false });
  assert.deepEqual(out.result, { mapped: ['hello', 'hello'], direct: 'hello' });
  const branchRec = tree.children[0];
  assert.equal(branchRec.kind, 'branch');
  assert.equal(branchRec.tree.kind, 'tree', 'the element became an anonymous tree');
  assert.equal(tree.children[1].tree.kind, 'tree');
});

test('a pause inside an imported tree resumes through From(), seed and all', async () => {
  Tree(
    name('from_ask'),
    Model('mock'),
    Human('reply'),
    Return((m) => `said:${m.reply} input:${m.input}`),
  );
  const tree = Tree(
    name('from_outer_resume'),
    From('from_ask', memory(() => ({ input: 'seeded' }))),
    Return((m) => m.prev[0]),
  );
  const logger = logPath();
  const first = await grandma.knit(tree, { memory: {}, models, logger });
  assert.equal(first.status, 'waiting');
  assert.equal(first.humanSlot, 'reply');

  const out = await grandma.knit(tree, {
    memory: {},
    models,
    logger,
    _continuation: first.continuation,
    humanInput: 'yes',
  });
  assert.equal(out.result, 'said:yes input:seeded', 'the memory() seed is re-applied on resume');
});

test('Tree.from() still resolves and warns once, deprecation-style', async () => {
  const warnings = [];
  const original = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  try {
    assert.equal(Tree.from('from_inner'), inner, 'still returns the registered def');
    Tree.from('from_inner');
    assert.throws(() => Tree.from('from_nope'), /no tree registered under name 'from_nope'/);
  } finally {
    console.warn = original;
  }
  assert.equal(warnings.length, 1, 'warns once per process');
  assert.match(warnings[0], /deprecated/);
});
