// A session can be parked at a Human() while its pattern file is edited —
// the seed updater writes a newer trunk under a running conversation. The
// checkpoint saves child INDEXES from the build that paused; inserting a
// Memory() before the Human shifts them, so the old index re-enters the Human
// (the delivery is lost) and a later Memory(update()) throws because the new
// declaration never ran. Resume re-anchors by name and seeds the declarations
// the rebuilt tree added before the pause point.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import grandma, {
  Tree, name, Human, Hook, onHuman, Memory, Return, update,
} from '../src/index.mjs';
import { mockRuntime } from './helpers.mjs';

const model = { model: 'mock', handler: async () => ({ content: 'x' }) };

function harness() {
  const dbPath = path.join(
    os.tmpdir(),
    `kat-shape-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  const runtime = (humanInput) => ({
    ...mockRuntime(model.handler, { models: { default: model }, memory: {}, logger: dbPath }),
    humanInput,
  });
  return { dbPath, runtime };
}

test('resume re-anchors past the Human after a Memory() is inserted before it', async () => {
  const { dbPath, runtime } = harness();
  // Before the edit: a → Human → a update.
  const before = () => Tree(
    name('shape_root'),
    Memory('a', () => 0),
    Human('h'),
    Memory(update(), 'a', (m, cur) => cur + 1),
    Return((m) => ({ a: m.a })),
  );
  // After the edit: `b` is declared before the Human. The saved position now
  // points at the Human itself; the later b update has no slot unless resume
  // seeds it.
  const after = () => Tree(
    name('shape_root'),
    Memory('a', () => 0),
    Memory('b', () => ({})),
    Human('h'),
    Memory(update(), 'a', (m, cur) => cur + 1),
    Memory(update(), 'b', () => ({ ok: true })),
    Return((m) => ({ a: m.a, b: m.b })),
  );
  try {
    const first = await grandma.knit(before(), runtime());
    assert.equal(first.status, 'waiting');
    assert.equal(first.humanSlot, 'h');

    const second = await grandma.knit(after(), {
      ...runtime('hello'),
      _continuation: first.continuation,
    });
    assert.notEqual(second.status, 'waiting', 'the reply did not land on the moved Human again');
    assert.deepEqual(second.result, { a: 1, b: { ok: true } }, 'both post-pause updates wrote');
  } finally {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
  }
});

test('a hook added before the Human can update a slot the old checkpoint lacks', async () => {
  const { dbPath, runtime } = harness();
  const before = () => Tree(
    name('hook_shape_root'),
    Memory('conversation', () => []),
    Human('h'),
    Memory(update(), 'conversation', (m, cur) => [...cur, m.h]),
    Return((m) => m.conversation),
  );
  const hook = Tree(
    name('hook_shape_hook'),
    Memory(update(), 'hook_actions', (m) => ({ seen: m.input })),
  );
  const after = () => Tree(
    name('hook_shape_root'),
    Hook(onHuman(), hook),
    Memory('conversation', () => []),
    Memory('hook_actions', () => ({})),
    Human('h'),
    Memory(update(), 'conversation', (m, cur) => [...cur, m.h]),
    Memory(update(), 'hook_actions', (m) => ({ input: m.h })),
    Return((m) => ({ conversation: m.conversation, hook: m.hook_actions })),
  );
  try {
    const first = await grandma.knit(before(), runtime());
    const second = await grandma.knit(after(), {
      ...runtime('hello'),
      _continuation: first.continuation,
    });
    assert.notEqual(second.status, 'waiting');
    assert.deepEqual(second.result, {
      conversation: ['hello'],
      hook: { input: 'hello' },
    }, 'the hook and the post-pause update both saw the seeded slot');
  } finally {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
  }
});
