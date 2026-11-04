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
import kat, { Tree, name, Memory, Human, Return, update, readFromMemoryOnce, Goto } from '../src/index.mjs';
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
    assert.equal(pause.source, undefined, 'a wait has no source');
    assert.equal(reply.child, 'reply');
    assert.equal(reply.source, 'human', 'a direct reply says it came from the human');
    assert.equal(reply.value, 'hello there');

    const out = runLogTools(dbPath)[0].execute({ type: 'human' });
    const delivered = out.rows.find((r) => r.text === 'hello there');
    assert.ok(delivered, 'read_runs can recall the reply');
    assert.equal(delivered.source, 'human', 'read_runs surfaces the source');
  } finally {
    for (const s of ['', '-wal', '-shm']) fs.rmSync(dbPath + s, { force: true });
  }
});

test('a memory-filled delivery is marked as memory, not as the user speaking', async () => {
  const dbPath = path.join(os.tmpdir(), `kat-humanlog-mem-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  try {
    const tree = Tree(
      name('seeded_greeter'),
      Memory('entry', () => 'init'),
      Memory(update(), 'entry', () => 'from-memory'),
      Human('entry', readFromMemoryOnce()),
      Return((m) => `got:${m.entry}`),
    );
    const out = await kat.knit(tree, mockRuntime(async () => ({ content: 'x' }), { logger: dbPath }));

    const db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db
      .prepare("SELECT content FROM calls WHERE kind='human' AND json_extract(content, '$.delivered') = 1 ORDER BY seq")
      .all()
      .map((r) => JSON.parse(r.content));
    db.close();

    assert.equal(out.result, 'got:from-memory');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].value, 'from-memory');
    assert.equal(rows[0].source, 'memory');
    assert.equal(rows[0].via, 'readFromMemoryOnce');
    assert.ok(Number.isInteger(rows[0].seq), 'the source write is named');

    // The user never said this, so a user-perspective transcript excludes it.
    const transcript = runLogTools(dbPath)[0].execute({ mode: 'transcript' });
    assert.deepEqual(transcript.entries, []);
  } finally {
    for (const s of ['', '-wal', '-shm']) fs.rmSync(dbPath + s, { force: true });
  }
});

test('an armed Goto delivery is marked goto, not as the user', async () => {
  const dbPath = path.join(os.tmpdir(), `kat-humanlog-goto-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  try {
    const tree = Tree(
      name('goto_greeter'),
      Goto('entry', () => 'from-goto'),
      Human('entry'),
      Return((m) => `got:${m.entry}`),
    );
    const out = await kat.knit(tree, mockRuntime(async () => ({ content: 'x' }), { logger: dbPath }));

    const db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db
      .prepare("SELECT content FROM calls WHERE kind='human' AND json_extract(content, '$.delivered') = 1 ORDER BY seq")
      .all()
      .map((r) => JSON.parse(r.content));
    db.close();

    assert.equal(out.result, 'got:from-goto');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, 'goto');
    assert.equal(rows[0].via, 'goto');
    assert.deepEqual(runLogTools(dbPath)[0].execute({ mode: 'transcript' }).entries, []);
  } finally {
    for (const s of ['', '-wal', '-shm']) fs.rmSync(dbPath + s, { force: true });
  }
});
