// From('name', version('v1'|'prod'|'draft')) — a deferred port resolved from
// disk by the host loader at run time, so the process never needs to have
// imported the tree. From('name') without version() uses the build-time
// registry when the name is registered, and otherwise defers to the host
// loader too (so load order does not matter).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import grandma, {
  Tree, From, name, Model, Needs, Human, Return, version, memory,
} from '../src/index.mjs';

const logPath = () =>
  path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kat-from-version-')), 'log.db');

const mockModel = (text) => ({ model: 'mock', handler: async () => ({ content: text }) });
const models = { mock: mockModel('hello') };

// The imported tree's internal name is version-qualified (in BOB it is
// `inner.v1`), so its own name and the operator ref differ.
const inner = Tree(
  name('inner.v1'),
  Needs('input'),
  Model('mock'),
  Return((m) => `v1:${m.input}`),
);

test('version() validates its argument', () => {
  assert.throws(() => version('2'), /expects 'vN', 'prod' or 'draft'/);
  assert.throws(() => version(''), /expects/);
  assert.equal(version('v12').text, 'v12');
  assert.equal(version('prod').text, 'prod');
  assert.equal(version('draft').text, 'draft');
});

test('From(name) without version() defers to the registry or the host loader', async () => {
  // Build time: no throw — it resolves from the registry, else from loadTree.
  const tree = Tree(name('from_no_version'), From('nope_unregistered'), Return((m) => m.prev[0]));
  await assert.rejects(
    grandma.knit(tree, { memory: {}, models, logger: false }),
    /is not registered and loadTree did not provide it/,
  );
});

test('From(name, version(vN)) defers to the host loader and runs it', async () => {
  const outer = Tree(
    name('deferred_v1_outer'),
    From('inner', version('v1')),
    Return((m) => m.inner),
  );
  const calls = [];
  const out = await grandma.knit(outer, {
    memory: { input: 'hi' },
    models,
    logger: false,
    loadTree: async (n) => {
      calls.push(n);
      return n === 'inner@v1' ? inner : null;
    },
  });
  assert.deepEqual(calls, ['inner@v1'], 'the ref reaches the host loader');
  assert.equal(out.result, 'v1:hi');
  assert.equal(out.memory.inner, 'v1:hi', 'lands under the bare logical slot name');
});

test("version('prod') and version('draft') map to their refs", async () => {
  for (const v of ['prod', 'draft']) {
    const outer = Tree(
      name(`deferred_${v}_outer`),
      From('inner', version(v)),
      Return((m) => m.inner),
    );
    const calls = [];
    const out = await grandma.knit(outer, {
      memory: { input: v },
      models,
      logger: false,
      loadTree: async (n) => {
        calls.push(n);
        return inner;
      },
    });
    assert.deepEqual(calls, [`inner@${v}`]);
    assert.equal(out.result, `v1:${v}`);
  }
});

test('version() combines with memory() to seed the import', async () => {
  const outer = Tree(
    name('deferred_seed_outer'),
    From('inner', version('v1'), memory((m) => ({ input: `from ${m.tag}` }))),
    Return((m) => m.inner),
  );
  const out = await grandma.knit(outer, {
    memory: { tag: 'outer' },
    models,
    logger: false,
    loadTree: async (n) => (n === 'inner@v1' ? inner : null),
  });
  assert.equal(out.result, 'v1:from outer');
});

test('a versioned From() resolves on resume too', async () => {
  const ask = Tree(
    name('ask.v1'),
    Model('mock'),
    Human('reply'),
    Return((m) => `said:${m.reply}`),
  );
  const outer = Tree(
    name('deferred_resume_outer'),
    From('ask', version('v1')),
    Return((m) => m.ask),
  );
  const logger = logPath();
  const loadTree = async (n) => (n === 'ask@v1' || n === 'ask.v1' ? ask : null);
  const first = await grandma.knit(outer, { memory: {}, models, logger, loadTree });
  assert.equal(first.status, 'waiting');
  assert.equal(first.humanSlot, 'reply');

  const out = await grandma.knit(outer, {
    memory: {},
    models,
    logger,
    loadTree,
    _continuation: first.continuation,
    humanInput: 'yes',
  });
  assert.equal(out.result, 'said:yes');
});

test('a deferred port that the loader cannot resolve fails clearly', async () => {
  const outer = Tree(name('deferred_missing_outer'), From('ghost', version('v9')));
  await assert.rejects(
    () => grandma.knit(outer, { memory: {}, models, logger: false, loadTree: async () => null }),
    /tree 'ghost@v9' is not registered/,
  );
});
