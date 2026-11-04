// Transcript mode: the conversation as the user experienced it.
//
// The log records two very different things as `human` rows with
// `delivered: true`: a reply the host actually received, and a value the tree
// filled from memory (Goto/readFromMemoryOnce). Only the first is the user's
// words. Transcript mode reads `source` and keeps the user-facing conversation:
// direct human replies + every emit, oldest first, with machine emits labeled.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLogger } from '../src/logger.mjs';
import { runLogTools, runLogToolFromQuery } from '../src/runlog.mjs';

const tmpDbPath = () =>
  path.join(os.tmpdir(), `kat-transcript-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);

const cleanup = (dbPath) => {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
};

function seed(dbPath) {
  const logger = createLogger(dbPath, 'none');
  const run = '2026-11-03_12-00-00-1';
  const log = (kind, content) =>
    logger.log({
      run_id: run,
      definition_id: 'trunk:def',
      branch_path: 'x',
      iteration: 1,
      scope_id: 1,
      kind,
      content,
    });
  const seq = {};
  seq.wait = log('human', { child: 'reply', context: {}, buttons: [] });
  seq.memory = log('human', {
    child: 'entry',
    delivered: true,
    source: 'memory',
    via: 'readFromMemoryOnce',
    seq: 99,
    value: 'not the user',
  });
  seq.goto = log('human', {
    child: 'entry',
    delivered: true,
    source: 'goto',
    via: 'goto',
    value: 'also not the user',
  });
  seq.reply = log('human', {
    child: 'reply',
    delivered: true,
    source: 'human',
    value: 'hello Bob',
  });
  seq.ask = log('llm_call', { child: 'assist', content: 'internal decision' });
  seq.answer = log('emit', { child: 'reply', value: { text: 'hi there' } });
  seq.machine = log('emit', {
    child: 'note',
    value: { text: 'engine note', level: 'machine' },
  });
  seq.narration = log('emit', {
    child: 'engine',
    value: { machine: { tree: 'insight', doing: 'fresh', detail: 'discarded saved state' } },
  });
  logger.close();
  return { run, seq };
}

test('transcript is the user-facing conversation, oldest first', () => {
  const dbPath = tmpDbPath();
  const { run, seq } = seed(dbPath);
  try {
    const out = runLogTools(dbPath)[0].execute({ mode: 'transcript', run_id: run });
    assert.equal(out.mode, 'transcript');
    assert.deepEqual(out.entries.map((e) => e.seq), [seq.reply, seq.answer, seq.machine, seq.narration]);
    assert.deepEqual(out.entries.map((e) => e.text), [
      'hello Bob',
      'hi there',
      'engine note',
      'discarded saved state',
    ]);
    assert.deepEqual(
      out.entries.map((e) => [e.speaker, e.source ?? e.channel]),
      [
        ['user', 'human'],
        ['bot', 'user'],
        ['bot', 'machine'],
        ['bot', 'machine'],
      ],
    );
    assert.equal(out.count, 4);
    assert.equal(out.meta.max_seq, seq.narration);
    assert.equal(out.meta.from_seq, seq.reply);
    assert.equal(out.meta.to_seq, seq.narration);

    // The pause and the memory/goto deliveries are not part of the user's
    // conversation.
    for (const hidden of [seq.wait, seq.memory, seq.goto, seq.ask]) {
      assert.ok(!out.entries.some((e) => e.seq === hidden), `seq ${hidden} stays out`);
    }
  } finally {
    cleanup(dbPath);
  }
});

test('transcript pages with before/after and limit, keeping newest entries', () => {
  const dbPath = tmpDbPath();
  const { run, seq } = seed(dbPath);
  try {
    const readRuns = runLogTools(dbPath)[0];
    const newest = readRuns.execute({ mode: 'transcript', run_id: run, limit: 2 });
    assert.deepEqual(newest.entries.map((e) => e.seq), [seq.machine, seq.narration]);

    const older = readRuns.execute({
      mode: 'transcript',
      run_id: run,
      before: seq.machine,
    });
    assert.deepEqual(older.entries.map((e) => e.seq), [seq.reply, seq.answer]);

    const after = readRuns.execute({
      mode: 'transcript',
      run_id: run,
      after: seq.reply,
    });
    assert.deepEqual(after.entries.map((e) => e.seq), [seq.answer, seq.machine, seq.narration]);
  } finally {
    cleanup(dbPath);
  }
});

test('condensed rows expose human source and emit channel', () => {
  const dbPath = tmpDbPath();
  const { seq } = seed(dbPath);
  try {
    const out = runLogTools(dbPath)[0].execute({ type: ['human', 'emit'], limit: 20 });
    const bySeq = new Map(out.rows.map((r) => [r.seq, r]));

    assert.equal(bySeq.get(seq.wait).source, undefined, 'a pause has no source');
    assert.equal(bySeq.get(seq.reply).source, 'human');
    assert.equal(bySeq.get(seq.memory).source, 'memory');
    assert.equal(bySeq.get(seq.goto).source, 'goto');

    assert.equal(bySeq.get(seq.answer).channel, 'user');
    assert.equal(bySeq.get(seq.machine).channel, 'machine');
    assert.equal(bySeq.get(seq.narration).channel, 'machine');
    assert.equal(bySeq.get(seq.narration).text, 'discarded saved state');
  } finally {
    cleanup(dbPath);
  }
});

test('transcript treats a legacy delivered row without a source as the user', () => {
  const dbPath = tmpDbPath();
  try {
    const logger = createLogger(dbPath, 'none');
    const run = '2026-11-03_13-00-00-1';
    const row = (kind, content) =>
      logger.log({ run_id: run, definition_id: 'trunk:def', branch_path: 'x', iteration: 1, scope_id: 1, kind, content });
    const reply = row('human', { child: 'reply', delivered: true, value: 'legacy hello' });
    row('emit', { child: 'reply', value: { text: 'legacy hi' } });
    logger.close();

    const out = runLogTools(dbPath)[0].execute({ mode: 'transcript', run_id: run });
    assert.deepEqual(out.entries.map((e) => e.seq), [reply, reply + 1]);
    assert.equal(out.entries[0].speaker, 'user');
    assert.equal(out.entries[0].source, 'human');
  } finally {
    cleanup(dbPath);
  }
});

test('the async (browser) transcript matches the Node path', async () => {
  const dbPath = tmpDbPath();
  const { run } = seed(dbPath);
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const q = async (sql, params) => db.prepare(sql).all(...params);
      const sync = runLogTools(dbPath)[0].execute({ mode: 'transcript', run_id: run });
      const asyncOut = await runLogToolFromQuery(q).execute({ mode: 'transcript', run_id: run });
      assert.deepEqual(asyncOut.entries, sync.entries);
      assert.equal(asyncOut.meta.max_seq, sync.meta.max_seq);
    } finally {
      db.close();
    }
  } finally {
    cleanup(dbPath);
  }
});
