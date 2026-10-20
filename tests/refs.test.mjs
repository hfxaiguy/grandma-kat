// refs.mjs — the `ref://<seq>/<path>` resolver behind truncated tool results.
//
// A ref names the run-log row that holds a full value (a map_item/tool_call/
// record row). Resolution happens at the tree-tool boundary; these tests pin
// the grammar, the guards (missing row, another run, missing path), and the
// structural-sharing contract (no refs ⇒ identity, no copy).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRef, parseRef, resolveRef, resolveRefs, formatRef } from '../src/refs.mjs';

const fakeExec = (rows, runId = 'run-1') => ({
  runId,
  logger: {
    readRow: (seq) => rows[seq] ?? null,
  },
});

const row = (runId, content) => ({ run_id: runId, content });

test('grammar: isRef/parseRef accept ref://<name>.<seq>(/<path>) and legacy ref://<seq>', () => {
  assert.equal(isRef('ref://146629/list'), true);
  assert.equal(isRef('ref://42'), true);
  assert.equal(isRef('ref://rows.146629'), true);
  assert.equal(isRef('ref://rows.146629/list'), true);
  assert.equal(isRef('ref:// 42'), false);
  assert.equal(isRef('REF://42'), false);
  assert.equal(isRef('ref://42x'), false);
  assert.equal(isRef('see ref://42'), false);
  assert.equal(isRef(42), false);

  assert.deepEqual(parseRef('ref://146629/list'), { name: null, seq: 146629, path: ['list'] });
  assert.deepEqual(parseRef('ref://7/a/b/0'), { name: null, seq: 7, path: ['a', 'b', '0'] });
  assert.deepEqual(parseRef('ref://7/'), { name: null, seq: 7, path: [] });
  assert.deepEqual(parseRef('ref://rows.146629'), { name: 'rows', seq: 146629, path: [] });
  assert.deepEqual(parseRef('ref://sql_query.42/list'), { name: 'sql_query', seq: 42, path: ['list'] });
  assert.deepEqual(parseRef('ref://caller-list.9/0/name'), { name: 'caller-list', seq: 9, path: ['0', 'name'] });
  assert.equal(parseRef('nope'), null);
});

test('a named ref resolves by its seq (the name is a label)', () => {
  const exec = fakeExec({ 10: row('run-1', { child: 'rows', index: 0, value: { list: [{ name: 'A' }, { name: 'B' }] } }) });
  assert.deepEqual(resolveRef(exec, 'ref://rows.10/list'), [{ name: 'A' }, { name: 'B' }]);
  assert.deepEqual(resolveRef(exec, 'ref://rows.10/list/1/name'), 'B');
  assert.deepEqual(resolveRefs(exec, { input: 'ref://rows.10/list' }), { input: [{ name: 'A' }, { name: 'B' }] });
});

test('resolveRef walks map_item/tool_call/record payloads and paths', () => {
  const rows = {
    10: row('run-1', { child: 'tool_calls', index: 0, value: { handled: true, list: [{ name: 'A' }, { name: 'B' }] } }),
    11: row('run-1', { child: 'x', tool: 'contacts', args: {}, result: [1, 2, 3] }),
    12: row('run-1', { child: 'slot', childIndex: 0, value: 'plain text', op: 'set' }),
  };
  const exec = fakeExec(rows);

  assert.deepEqual(resolveRef(exec, 'ref://10/list'), [{ name: 'A' }, { name: 'B' }]);
  assert.deepEqual(resolveRef(exec, 'ref://10/list/1/name'), 'B');
  assert.deepEqual(resolveRef(exec, 'ref://11/2'), 3);
  assert.equal(resolveRef(exec, 'ref://12'), 'plain text');
});

test('guards: missing row, another run, missing path all throw loudly', () => {
  const exec = fakeExec({ 10: row('run-1', { value: { list: [] } }) });
  assert.throws(() => resolveRef(exec, 'ref://99999'), /no run-log row at seq 99999/);
  assert.throws(() => resolveRef(exec, 'ref://10/other'), /path 'other' not found/);
  assert.throws(
    () => resolveRef(fakeExec({ 10: row('other-run', { value: 1 }) }), 'ref://10'),
    /belongs to another run/,
  );
});

test('resolveRefs substitutes recursively and returns identity without refs', () => {
  const exec = fakeExec({ 5: row('run-1', { value: [1, 2, 3] }) });

  const args = { input: 'ref://5', keep: { deep: 'ref://5/1' }, list: [{ x: 'ref://5' }] };
  assert.deepEqual(resolveRefs(exec, args), {
    input: [1, 2, 3],
    keep: { deep: 2 },
    list: [{ x: [1, 2, 3] }],
  });

  // No refs anywhere ⇒ the SAME reference comes back (no big-array copies).
  const big = { rows: Array.from({ length: 1000 }, (_, i) => i) };
  assert.equal(resolveRefs(exec, big), big);
  assert.equal(resolveRefs(exec, 'plain'), 'plain');

  // A ref-free sibling array is preserved by reference inside a changed object.
  const inner = [1, 2, 3];
  const mixed = { a: 'ref://5', b: inner };
  const out = resolveRefs(exec, mixed);
  assert.notEqual(out, mixed);
  assert.equal(out.b, inner);
});

test('the label must match the row\'s attested refName', () => {
  const exec = fakeExec({
    7: row('run-1', { tool: 'contacts', refName: 'contacts', result: [{ name: 'A' }] }),
  });
  assert.deepEqual(resolveRef(exec, 'ref://contacts.7'), [{ name: 'A' }]);
  assert.throws(
    () => resolveRef(exec, 'ref://caller-list.7'),
    (err) => {
      assert.match(err.message, /that row is 'contacts'/);
      assert.match(err.message, /ref:\/\/contacts\.7/);
      assert.match(err.message, /drop the label: ref:\/\/7/);
      return true;
    },
  );
  // The path rides along in the corrective handle.
  assert.throws(
    () => resolveRef(exec, 'ref://caller-list.7/0'),
    /ref:\/\/contacts\.7\/0/,
  );
});

test('bare refs, nameless rows, and pre-refName logs skip the name check', () => {
  const exec = fakeExec({
    7: row('run-1', { refName: 'contacts', result: [1] }),
    8: row('run-1', { result: [2] }), // an older log row, before refName existed
  });
  assert.deepEqual(resolveRef(exec, 'ref://7'), [1], 'bare handle: no label to check');
  assert.deepEqual(resolveRef(exec, 'ref://anything.8'), [2], 'the row attests no name');
});

test('formatRef builds the one grammar every minter uses', () => {
  assert.equal(formatRef('contacts', 7), 'ref://contacts.7');
  assert.equal(formatRef('contacts', 7, ['list']), 'ref://contacts.7/list');
  assert.equal(formatRef('rows', 7, '0/name'), 'ref://rows.7/0/name');
  assert.equal(formatRef(null, 7), 'ref://7');
  assert.equal(formatRef('', 7, []), 'ref://7');
  assert.equal(parseRef(formatRef('caller-list', 9, ['0', 'name'])).name, 'caller-list');
});
