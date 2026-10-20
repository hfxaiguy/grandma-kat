// Predicate slots accept a Tree — Until/Check conditions and max errFn.
//
// A condition or errFn may be a function (the classic form) OR a tree: a bare
// element (wrapped into a one-child tree) or a built Tree def. The tree runs
// paused-free in a fresh child scope and its exported value is the predicate
// result — for a condition, truthy passes; for an errFn, the value is the
// exhaustion message.
//
// Scripted against mock models — no live LLM.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import grandma, {
  Tree, name, Model, Prompt, Until, max, Return, Human, disableAuto,
} from '../src/index.mjs';
import { scripted, mockRuntime } from './helpers.mjs';

// ── builder: a tree is accepted where a function was ──────────────────────

test('Until()/max() accept a bare element or a Tree def, and reject junk', () => {
  // Bare element — accepted by the builder.
  const withElement = Tree(name('te'), Until(Prompt(disableAuto(), 'c', () => 'x'), max(3)));
  assert.equal(withElement.children[0].kind, 'until');
  // A Tree def — accepted too.
  const def = Tree(name('cond'), Return(() => true));
  const withDef = Tree(name('td'), Until(def, max(2, Tree(name('msg'), Return(() => 'boom')))));
  assert.equal(withDef.children[0].check.kind, 'tree');
  assert.equal(withDef.children[0].max.errFn.kind, 'tree');
  // Junk is still rejected.
  assert.throws(() => Until(42, max(2)), /must be the condition function/);
  assert.throws(() => max(2, 42), /errFn must be a function or a Tree/);
});

// ── runtime: a condition tree drives the loop ─────────────────────────────

test('Until(tree): the condition tree runs each pass and its value controls the loop', async () => {
  let condRuns = 0;
  const condition = Tree(name('cond'), Return(() => (condRuns += 1) >= 2));
  const tree = Tree(
    name('loop'),
    Model('default'),
    Until(condition, max(5)),
    Return(() => 'done'),
  );
  const out = await grandma.knit(tree, mockRuntime(scripted(['x'])));
  assert.equal(out.result, 'done');
  assert.equal(condRuns, 2, 'the condition tree ran once per pass and ended it on the second');
});

test('Until(tree): a never-true condition tree exhausts with the built-in message', async () => {
  const condition = Tree(name('cond'), Return(() => false));
  const tree = Tree(name('loop'), Model('default'), Until(condition, max(2)), Return(() => 'never'));
  await assert.rejects(
    () => grandma.knit(tree, mockRuntime(scripted(['x']))),
    /exhausted after 2 iterations/,
  );
});

// ── runtime: a tree produces the exhaustion message ───────────────────────

test('max(n, tree): the errFn tree runs at exhaustion and its value is the message', async () => {
  let capRuns = 0;
  const errTree = Tree(name('msg'), Return(() => `cap message #${(capRuns += 1)}`));
  const tree = Tree(
    name('loop'),
    Model('default'),
    Until(() => false, max(2, errTree)),
    Return(() => 'never'),
  );
  await assert.rejects(
    () => grandma.knit(tree, mockRuntime(scripted(['x']))),
    /cap message #1/,
  );
  assert.equal(capRuns, 1, 'the errFn tree ran exactly once, at exhaustion');
});

// ── a bare Prompt element as a condition ──────────────────────────────────

test('Until(Prompt(...)): a bare element is wrapped and run', async () => {
  const handler = scripted([{ content: 'stop' }]);
  const tree = Tree(
    name('loop'),
    Model('default'),
    Until(Prompt(disableAuto(), 'gate', () => [{ role: 'user', content: 'more?' }]), max(3)),
    Return(() => 'finished'),
  );
  const out = await grandma.knit(tree, mockRuntime(handler));
  assert.equal(out.result, 'finished');
  assert.equal(handler.calls.length, 1, 'the gate prompt ran once');
});

// ── a predicate tree that pauses is a build error ─────────────────────────

test('a predicate tree with Human() is rejected as pause-free', async () => {
  const tree = Tree(name('loop'), Model('default'), Until(Tree(name('c'), Human('h')), max(2)));
  await assert.rejects(
    () => grandma.knit(tree, mockRuntime(scripted(['x']))),
    /must be pause-free/,
  );
});
