// Emit flags tag an emitted value with a channel (`level`) without changing
// how the tree runs. `Emit("text", flag("machine"))` is the static shorthand;
// function emits and object emits are tagged too.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import kat, { Tree, name, Emit, flag, Return, when } from '../src/index.mjs';

const run = async (tree) => {
  const emitted = [];
  const out = await kat.knit(tree, {
    models: { default: { model: 'mock', handler: async () => ({ content: '' }) } },
    onEmit: (value) => emitted.push(value),
  });
  return { out, emitted };
};

test('a literal Emit with flag(machine) is tagged', async () => {
  const { out, emitted } = await run(
    Tree(name('flag_literal'), Emit('starting', flag('machine')), Return(() => 'done')),
  );
  assert.deepEqual(emitted, [{ text: 'starting', level: 'machine' }]);
  assert.equal(out.result, 'done');
});

test('a function Emit with flag(machine) tags text and preserves buttons', async () => {
  const buttons = [{ label: 'OK', value: 'ok' }];
  const { emitted } = await run(
    Tree(
      name('flag_fn'),
      Emit(() => ({ text: 'waiting', buttons }), flag('machine')),
      Return(() => 'done'),
    ),
  );
  assert.deepEqual(emitted, [{ text: 'waiting', buttons, level: 'machine' }]);
});

test('flag works on machine narration objects', async () => {
  const { emitted } = await run(
    Tree(
      name('flag_machine'),
      Emit(() => ({ machine: { tree: 'app', doing: 'waiting', at: 'reply' } }), flag('machine')),
      Return(() => 'done'),
    ),
  );
  assert.equal(emitted[0].machine.tree, 'app');
  assert.equal(emitted[0].level, 'machine');
});

test('when() gates a flagged emit and leaves unflagged emits untouched', async () => {
  const { emitted } = await run(
    Tree(
      name('flag_gate'),
      Emit(when(() => false), 'skipped', flag('machine')),
      Emit(() => ({ text: 'plain' })),
      Return(() => 'done'),
    ),
  );
  assert.deepEqual(emitted, [{ text: 'plain' }]);
});
