// Session-persistent memory: a tree invoked as a TOOL keeps its slots for the
// session (keyed sessionId × tree). `fresh` clears the store; `keep(fn)`
// governs one slot's lifecycle.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import kat, { Tree, name, Memory, Call, Return, update, keep, registerTree } from '../src/index.mjs';

function makeApp() {
  return Tree(
    name('app'),
    Memory('acc', () => []),
    Memory(update(), 'acc', (m, cur) => [...(cur ?? []), String(m.input ?? '')]),
    Return((m) => m.acc),
  );
}
registerTree(makeApp());

const appTool = { description: 'app', parameters: { type: 'object', properties: {} }, tree: 'app' };
const runtime = (sessionId, onEmit) => ({
  models: { default: { model: 'mock', handler: async () => ({ content: '' }) } },
  tools: { app: appTool },
  ...(sessionId ? { sessionId } : {}),
  ...(onEmit ? { onEmit } : {}),
});

const host = () => Tree(
  name('host'),
  Call('one', 'app', () => ({ input: 'a' })),
  Call('two', 'app', () => ({ input: 'b' })),
  Return((m) => [m.branch.one, m.branch.two]),
);

test('a tool tree keeps its slots across invocations within a session', async () => {
  const out = await kat.knit(host(), runtime('s-keep'));
  assert.deepEqual(out.result, [['a'], ['a', 'b']], 'second call resumes the accumulated slot');
});

test('without a sessionId nothing persists', async () => {
  const out = await kat.knit(host(), runtime(null));
  assert.deepEqual(out.result, [['a'], ['b']], 'each call starts fresh');
});

test('fresh clears the tree\'s store for the session (with a machine note)', async () => {
  await kat.knit(host(), runtime('s-fresh')); // populate ['a'] then ['a','b']
  const emitted = [];
  const hostFresh = Tree(
    name('host_fresh'),
    Call('one', 'app', () => ({ input: 'z', fresh: true })),
    Return((m) => m.branch.one),
  );
  const out = await kat.knit(hostFresh, runtime('s-fresh', (v) => emitted.push(v)));
  assert.deepEqual(out.result, ['z'], 'fresh discarded the prior accumulation');
  assert.ok(
    emitted.some((e) => e?.machine?.doing === 'fresh' && e.machine.tree === 'app'),
    'a machine note announced the discard',
  );
});

test('keep(fn) false erases a stored slot at entry', async () => {
  const appKeep = Tree(
    name('app_keep'),
    Memory(keep((m) => (m.acc ?? []).length < 2), 'acc', () => []),
    Memory(update(), 'acc', (m, cur) => [...(cur ?? []), String(m.input ?? '')]),
    Return((m) => m.acc),
  );
  registerTree(appKeep);
  const tools = { app_keep: { description: 'app_keep', parameters: { type: 'object', properties: {} }, tree: 'app_keep' } };
  const rt = { models: { default: { model: 'mock', handler: async () => ({ content: '' }) } }, tools, sessionId: 's-keepfn' };
  const host3 = Tree(
    name('host3'),
    Call('one', 'app_keep', () => ({ input: 'a' })),
    Call('two', 'app_keep', () => ({ input: 'b' })),
    Call('three', 'app_keep', () => ({ input: 'c' })),
    Return((m) => [m.branch.one, m.branch.two, m.branch.three]),
  );
  const out = await kat.knit(host3, rt);
  assert.deepEqual(
    out.result,
    [['a'], ['a', 'b'], ['c']],
    'the slot is kept until it holds 2 items, then keep(false) resets it',
  );
});
