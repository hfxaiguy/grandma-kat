// A failed model call is tagged with the runtime `models` slot it resolved to
// (the role the tree asked for, e.g. "strong"). A host that offers a fallback
// on a quota wall needs the role to retarget — the raw error only names the
// model id. The original error object is rethrown unchanged apart from `slot`.
import test from 'node:test';
import assert from 'node:assert/strict';
import grandma, { Tree, name, Model, Prompt } from '../src/index.mjs';

test('a thrown LLM error carries the failing model slot', async () => {
  const handler = async () => {
    const err = new Error('LLM request failed (402): out of credit');
    err.status = 402;
    throw err;
  };
  const pattern = Tree(name('agent'), Model('strong'), Prompt(m => 'go'));

  await assert.rejects(
    grandma.knit(pattern, { models: { strong: { model: 'mock', handler } }, tools: {} }),
    (err) => {
      assert.equal(err.slot, 'strong', 'the slot the prompt resolved to is tagged on the error');
      assert.equal(err.status, 402, 'the provider status survives');
      return true;
    },
  );
});

test('an existing slot tag is not overwritten', async () => {
  const handler = async () => {
    const err = new Error('boom');
    err.slot = 'preset';
    throw err;
  };
  const pattern = Tree(name('agent'), Model('cheap'), Prompt(m => 'go'));

  await assert.rejects(
    grandma.knit(pattern, { models: { cheap: { model: 'mock', handler } }, tools: {} }),
    (err) => {
      assert.equal(err.slot, 'preset');
      return true;
    },
  );
});
