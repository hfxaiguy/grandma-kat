// The host writes its own event kinds into `calls` (e.g. BOB's web UI logs
// `web_turn_end` markers under the run's real run_id, and session-scoped
// markers under the session key). Resume replays every row of the run up to
// the checkpoint's seq, so a foreign kind MUST be ignored, not rejected: a
// resumed turn whose window contains host rows would otherwise throw and take
// the whole session down. This pins the ignore-unknown-kinds behaviour.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import kat, { Tree, Branch, Memory, Human, Until, max, Return, name } from '../src/index.mjs';
import { mockRuntime } from './helpers.mjs';

test('resume ignores host event kinds it does not know', async () => {
  const dbPath = path.join(os.tmpdir(), `kat-foreign-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  try {
    const makeTree = () => {
      const inner = Tree(
        Branch(Tree(Human('reply'))),
        Until((m) => m.reply === 'done', max(5)),
      );
      return Tree(
        name('host-rows'),
        Memory('reply', () => ''),
        Branch(inner),
        Return((m) => ({ reply: m.reply })),
      );
    };
    const rt = (humanInput) => ({
      ...mockRuntime(async () => ({ content: 'x' }), { memory: {}, logger: dbPath }),
      humanInput,
    });

    const first = await kat.knit(makeTree(), rt('hello'));
    assert.equal(first.status, 'waiting', 'paused at the human');
    const runId = String(first.continuation).split(':')[0];

    // The host logs its own rows under the run's real id — exactly what a
    // web UI does at turn end, between two checkpoints of the same run.
    const ins = (() => {
      const db = new DatabaseSync(dbPath);
      const stmt = db.prepare(
        'INSERT INTO calls (run_id, definition_id, branch_path, iteration, scope_id, kind, content) VALUES (?, ?, ?, ?, ?, ?, ?)');
      return (kind, content) => { stmt.run(runId, 'web', 'host', 0, null, kind, JSON.stringify(content)); return db; };
    })();
    const db = ins('web_turn_end', { turnId: 't1', status: 'done' });
    ins('web_session_label', { label: 'renamed chat' });
    db.close();

    // This resume replays up to the FIRST checkpoint — the host rows sit after
    // it, so they are not read yet.
    const second = await kat.knit(makeTree(), { ...rt('more'), _continuation: first.continuation });
    assert.equal(second.status, 'waiting', 'first resume paused again');

    // This resume replays up to the SECOND checkpoint, which now includes the
    // host rows. It must ignore them and finish.
    const third = await kat.knit(makeTree(), { ...rt('done'), _continuation: second.continuation });
    assert.notEqual(third.status, 'waiting', 'resume across host rows completed');

    const check = new DatabaseSync(dbPath, { readOnly: true });
    const kept = check.prepare("SELECT COUNT(*) n FROM calls WHERE kind LIKE 'web\\_%' ESCAPE '\\'").get();
    check.close();
    assert.equal(Number(kept.n), 2, 'the host rows are still in the log');
  } finally {
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(dbPath + '-wal', { force: true });
    fs.rmSync(dbPath + '-shm', { force: true });
  }
});
