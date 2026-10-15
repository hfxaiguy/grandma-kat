// End-to-end: an `Each` over tool calls (the trunk's tool loop shape) collects
// the item row seqs, and a later tree-tool call can hand the FULL value to
// another tree as a `ref://` handle — resolved by the engine before the args
// are seeded, inside the same run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import grandma, { Tree, name, Tools, Needs, Each, Call, Memory, Return } from '../src/index.mjs';
import { mockRuntime } from './helpers.mjs';

const producer = Tree(name('producer'), Needs('n'),
  Each('items', (m) => Array.from({ length: m.n ?? 3 }, (_, i) => ({ id: i, name: `P${i}` })),
    Tree(Return((m) => m.item))),
  Return((m) => m.branch.items ?? []));

const consumer = Tree(name('consumer'), Needs('input'), Return((m) => m.input));

// The trunk's tool-loop shape: Each over the model's calls, then the next
// call's args may use the captured item seqs.
function outerTree(withBadRef = false) {
  return Tree(name('outer'), Tools('producer', 'consumer'),
    Each('tool_calls', () => [{ name: 'producer', arguments: { n: 4 } }],
      Tree(Call((m) => m.item.name, (m) => m.item.arguments))),
    Memory('produced', (m) => m.branch.tool_calls),
    Memory('seqs', (m) => m.raw.branch.tool_calls?.itemSeqs ?? []),
    Call('whole', 'consumer', (m) => ({ input: `ref://${m.seqs[0]}` })),
    Call('path', 'consumer', (m) => ({ input: `ref://${m.seqs[0]}/1/name` })),
    ...(withBadRef ? [Call('bad', 'consumer', () => ({ input: 'ref://99999999' }))] : []),
    Return((m) => ({
      produced: m.produced,
      seqs: m.seqs,
      whole: m.branch.whole,
      path: m.branch.path,
      ...(withBadRef ? { bad: m.branch.bad } : {}),
    })));
}

const runOuter = (tree) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kat-refs-'));
  const runtime = mockRuntime(async () => ({ content: 'unused' }), {
    tools: {
      producer: { description: 'producer', parameters: {}, tree: producer },
      consumer: { description: 'consumer', parameters: {}, tree: consumer },
    },
    logger: path.join(dir, 'runs.db'),
  });
  return grandma.knit(tree, runtime);
};

test('refs: a tree-tool arg ref resolves to the full value from the run log', async () => {
  const { result } = await runOuter(outerTree());

  assert.equal(result.seqs.length, 1);
  assert.ok(Number.isFinite(result.seqs[0]), 'the Each record carries the item row seq');

  // Whole-value ref: the consumer receives the producer's full result (the
  // map_item row's value — the single call's outcome, like the trunk's fold).
  assert.deepEqual(result.whole, result.produced[0]);
  assert.deepEqual(result.whole, [
    { id: 0, name: 'P0' },
    { id: 1, name: 'P1' },
    { id: 2, name: 'P2' },
    { id: 3, name: 'P3' },
  ]);

  // Path ref: walk into the item.
  assert.equal(result.path, 'P1');
});

test('refs: an unresolvable ref fails the call loudly (tool error, not bad data)', async () => {
  const { result } = await runOuter(outerTree(true));
  assert.equal(result.bad?.error !== undefined, true, 'the call returned an error value');
  assert.match(String(result.bad.error), /no run-log row at seq 99999999/);
  // The good calls in the same round still worked.
  assert.deepEqual(result.whole, result.produced[0]);
});
