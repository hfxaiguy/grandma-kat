// A Human() pause records the wait; the delivered reply must be recorded too,
// or the log cannot answer "what did the user say?" (read_runs { type:'human' }).
// A normal resume injects the reply into the slot and resumes PAST the Human
// element, so this is the only place the reply is written.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import kat, { Tree, name, Memory, Human, Return } from '../src/index.mjs';
import { runLogTools } from '../src/runlog.mjs';
import { mockRuntime } from './helpers.mjs';

test('a delivered reply is logged on the human row', async () => {
  const dbPath = path.join(os.tmpdir(), `kat-humanlog-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  try {
    const tree = Tree(
      name('greeter'),
      Memory('reply', () => ''),
      Human('reply'),
      Return((m) => `got:${m.reply}`),
    );
    const rt = (humanInput) => ({ ...mockRuntime(async () => ({ content: 'x' }), { logger: dbPath }), humanInput });

    const first = await kat.knit(tree, rt(undefined));
    assert.equal(first.status, 'waiting');

    await kat.knit(tree, { ...rt('hello there'), _continuation: first.continuation });

    const db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db
      .prepare("SELECT content FROM calls WHERE kind='human' ORDER BY seq")
      .all()
      .map((r) => JSON.parse(r.content));
    db.close();

    const pause = rows.find((r) => !r.delivered);
    const reply = rows.find((r) => r.delivered);
    assert.ok(pause, 'the pause is logged');
    assert.equal(pause.child, 'reply');
    assert.equal(reply.child, 'reply');
    assert.equal(reply.value, 'hello there');

    const out = runLogTools(dbPath)[0].execute({ type: 'human' });
    assert.ok(out.rows.some((r) => r.text === 'hello there'), 'read_runs can recall the reply');
  } finally {
    for (const s of ['', '-wal', '-shm']) fs.rmSync(dbPath + s, { force: true });
  }
});
