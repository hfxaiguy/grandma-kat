// The portable session log store: the engine's synchronous logger contract
// over an asynchronous driver, plus restart restore.
//
//   1. log()/readRow() are synchronous, and a checkpoint's shadow write is
//      ordered after the call rows it depends on.
//   2. A second store over the same driver restores a paused run and resumes
//      it synchronously — same run id, old checkpoint consumed, new one
//      shadowed.
//   3. A completed resume drops the checkpoint from memory and disk.
//   4. Restore refuses a missing checkpoint and a run whose pause row never
//      reached the driver.
//   5. With no host allocator the store seeds its counter from driver.headSeq.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import grandma, {
  Tree,
  name,
  Human,
  Return,
  resume,
  createSessionLogStore,
} from '../src/index.mjs';

const mockModels = {
  default: { model: 'mock', handler: async () => ({ content: 'ok' }) },
};

/** An asynchronous driver: every op is recorded in order; rows land in arrays. */
function memoryDriver() {
  const calls = [];
  const cps = new Map();
  const ops = [];
  const tick = () => new Promise((r) => setTimeout(r, 0));
  return {
    calls,
    cps,
    ops,
    async appendCalls(rows) {
      await tick();
      ops.push(`append:${rows.map((r) => r.seq).join(',')}`);
      for (const row of rows) calls.push({ ...row });
    },
    async upsertCheckpoint(row) {
      await tick();
      ops.push(`cp:${row.id}`);
      cps.set(row.id, { ...row });
    },
    async deleteCheckpointRow(id) {
      await tick();
      ops.push(`del:${id}`);
      cps.delete(id);
    },
    async getCheckpoint(id) {
      return cps.get(id) ?? null;
    },
    async getEvents(runId, opts = {}) {
      return calls.filter(
        (r) => r.run_id === runId && (opts.upToSeq == null || r.seq <= opts.upToSeq),
      );
    },
    async headSeq() {
      return calls.reduce((max, r) => Math.max(max, r.seq), 0);
    },
    async startRun(runId, sessionId) {
      ops.push(`run:${runId}:${sessionId ?? ''}`);
    },
  };
}

const pauseTree = () =>
  Tree(name('s'), Human('ask'), Human('reply'), Return((m) => m.branch.reply));

test('log/readRow are synchronous; a checkpoint is shadowed after its rows', async () => {
  const driver = memoryDriver();
  const store = createSessionLogStore({ driver, flushDelayMs: 60_000, onError: () => {} });
  await store.ready;

  const seq = store.log({
    run_id: 'r1',
    definition_id: 'd',
    branch_path: '',
    iteration: 0,
    scope_id: 0,
    kind: 'human',
    content: { child: 'ask' },
  });
  assert.equal(typeof seq, 'number');
  assert.equal(store.readRow(seq)?.content?.child, 'ask', 'readable before any flush');

  store.saveCheckpoint('r1:7', 'r1', 7, [1]);
  assert.ok(store.getCheckpoint('r1:7'), 'in-memory checkpoint is immediate');
  await store.flush();

  assert.deepEqual(
    driver.ops.slice(-2),
    [`append:${seq}`, 'cp:r1:7'],
    'the pause row is enqueued before the checkpoint row',
  );
  assert.equal(driver.cps.get('r1:7')?.seq, 7);
});

test('restore rebuilds a paused run; resume continues it and consumes the checkpoint', async () => {
  const driver = memoryDriver();
  const first = createSessionLogStore({ driver, onError: () => {} });
  await first.ready;
  const runtime = { models: mockModels, logger: first, sessionId: 'web:restore' };

  const paused = await grandma.knit(pauseTree(), runtime);
  assert.equal(paused.status, 'waiting', 'paused at the first human');
  await first.flush();
  assert.ok(driver.cps.has(paused.continuation), 'checkpoint reached the driver');
  const runId = String(paused.continuation).split(':')[0];

  // "Reload": a fresh store over the same driver, then restore.
  const second = createSessionLogStore({ driver, onError: () => {} });
  await second.ready;
  const restored = await second.restore(paused.continuation);
  assert.equal(restored.ok, true, `restore failed: ${restored.ok ? '' : restored.reason}`);
  assert.equal(second.getCheckpoint(paused.continuation)?.seq, restored.checkpoint.seq);
  const replayed = second.getEvents(runId);
  assert.ok(replayed.length > 0, 'the run replay window is hydrated');
  assert.equal(replayed.at(-1).seq, restored.checkpoint.seq, 'the pause row is the last row');
  assert.equal(replayed.at(-1).kind, 'human');

  const again = await resume(paused.continuation, {
    ...runtime,
    logger: second,
    humanInput: 'hello',
  });
  assert.equal(again.status, 'waiting', 'paused at the second human');
  assert.notEqual(again.continuation, paused.continuation, 'a new pause saved a new checkpoint');
  assert.ok(String(again.continuation).startsWith(runId), 'the resume kept the original run id');
  assert.equal(second.getCheckpoint(paused.continuation), null, 'the consumed checkpoint is gone');
  await second.flush();
  assert.equal(driver.cps.has(paused.continuation), false, 'and gone from the driver');
  assert.ok(driver.cps.has(again.continuation), 'the new checkpoint is shadowed');
  const delivered = second.getEvents(runId).find(
    (r) => r.kind === 'human' && r.content?.delivered === true,
  );
  assert.equal(delivered?.content?.value, 'hello', 'the reply is in the resumed run');

  // A third process restores the NEW pause and completes the tree.
  const third = createSessionLogStore({ driver, onError: () => {} });
  await third.ready;
  assert.equal((await third.restore(again.continuation)).ok, true);
  const done = await resume(again.continuation, {
    ...runtime,
    logger: third,
    humanInput: 'world',
  });
  assert.notEqual(done.status, 'waiting', 'the tree completed');
  await third.flush();
  assert.equal(driver.cps.size, 0, 'a completed run leaves no checkpoint row');
});

test('restore refuses missing, malformed, and partially-flushed pauses', async () => {
  const driver = memoryDriver();
  const store = createSessionLogStore({ driver, onError: () => {} });
  await store.ready;

  assert.deepEqual(await store.restore('nope:1'), {
    ok: false,
    reason: 'checkpoint not found',
  });
  assert.equal((await store.restore({ id: 'x', run_id: '', seq: 1 })).ok, false, 'malformed row');

  // A checkpoint whose run's pause row never reached disk (torn flush).
  driver.cps.set('r9:4', { id: 'r9:4', run_id: 'r9', seq: 4, resume_positions: '[]' });
  driver.calls.push({ run_id: 'r9', seq: 2, kind: 'record', content: {} });
  const torn = await store.restore('r9:4');
  assert.equal(torn.ok, false);
  assert.match(torn.reason, /pause row 4 missing/);
});

test('without a host allocator the store seeds seqs from driver.headSeq', async () => {
  const driver = memoryDriver();
  driver.calls.push({ run_id: 'old', seq: 41, kind: 'emit', content: {} });
  const store = createSessionLogStore({ driver, onError: () => {} });
  await store.ready;
  const seq = store.log({
    run_id: 'new',
    definition_id: 'd',
    branch_path: '',
    iteration: 0,
    scope_id: 0,
    kind: 'emit',
    content: {},
  });
  assert.equal(seq, 42);
  await store.flush();
  assert.deepEqual(driver.ops.at(-1), 'append:42');
});
