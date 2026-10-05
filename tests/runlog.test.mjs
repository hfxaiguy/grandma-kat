import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLogger } from '../src/logger.mjs';
import { runLogTools, runLogToolFromQuery } from '../src/runlog.mjs';

function tmpDbPath() {
  return path.join(
    os.tmpdir(),
    `grandma-kat-runlog-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

function cleanup(dbPath) {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
}

/**
 * A two-run log exercising every kind the reader shapes:
 * caller-list: llm -> tool -> a human pause -> the delivered reply -> two emits;
 * trunk: one greet emit.
 */
function seed(dbPath) {
  const logger = createLogger(dbPath, 'none');
  const runA = '2026-10-02_17-55-16-10';
  const runB = '2026-10-02_18-00-00-1';
  const log = (run_id, definition_id, kind, content) =>
    logger.log({ run_id, definition_id, branch_path: 'x', iteration: 1, scope_id: 1, kind, content });
  const seq = {};
  seq.llm = log(runA, 'caller-list:abc', 'llm_call', {
    child: 'assist_prompt', round: 1, content: '{"handled":true,"text":"This phone is for Rhonda Pakkala."}',
  });
  seq.tool = log(runA, 'caller-list:abc', 'tool_result', {
    child: 'get_contact', tool: 'get_contact', args: { id: 1846 }, result: { ok: true, contact: { id: 1846, name: 'Rhonda Pakkala' } },
  });
  // The pause row carries no reply; the delivery row carries what the user said.
  seq.wait = log(runA, 'caller-list:abc', 'human', { child: 'reply', context: {}, buttons: [] });
  seq.answer = log(runA, 'caller-list:abc', 'human', { child: 'reply', delivered: true, value: 'Rhonda, go ahead' });
  seq.rhonda = log(runA, 'caller-list:abc', 'emit', {
    child: 'advance', value: { text: 'This phone is for Rhonda Pakkala.' },
  });
  seq.next = log(runA, 'caller-list:abc', 'emit', {
    child: 'next', value: { text: 'Next up: John Deighan (2/43)' },
  });
  seq.greet = log(runB, 'trunk:def', 'emit', {
    child: 'turn', value: { text: 'Hello, this is your grandpa BOB bot' },
  });
  logger.close();
  return { runA, runB, seq };
}

const readRuns = (dbPath) => runLogTools(dbPath)[0];

test('condensed defaults to every kind, newest first', () => {
  const dbPath = tmpDbPath();
  const { runA, seq } = seed(dbPath);
  try {
    const out = readRuns(dbPath).execute({});
    assert.equal(out.rows.length, 7);
    assert.equal(out.rows[0].kind, 'emit');
    assert.equal(out.rows[0].text, 'Hello, this is your grandpa BOB bot');
    assert.equal(out.rows[0].when, '2026-10-02 18:00:00');

    // A delivered reply reads as the user's own words…
    const answer = out.rows.find((r) => r.seq === seq.answer);
    assert.equal(answer.kind, 'human');
    assert.equal(answer.child, 'reply');
    assert.equal(answer.text, 'Rhonda, go ahead');
    assert.equal(answer.run_id, runA);

    // …while a pause reads as a marker, never raw JSON.
    const wait = out.rows.find((r) => r.seq === seq.wait);
    assert.equal(wait.text, '(waiting at reply)');
  } finally {
    cleanup(dbPath);
  }
});

test('type filters by kind (one, or a list)', () => {
  const dbPath = tmpDbPath();
  const { seq } = seed(dbPath);
  try {
    const emits = readRuns(dbPath).execute({ type: 'emit' }).rows;
    assert.deepEqual(emits.map((r) => r.text), [
      'Hello, this is your grandpa BOB bot',
      'Next up: John Deighan (2/43)',
      'This phone is for Rhonda Pakkala.',
    ]);

    const mixed = readRuns(dbPath).execute({ type: ['human', 'emit'], limit: 6 }).rows;
    assert.equal(mixed.length, 5); // 3 emits + pause + delivery
    assert.ok(mixed.every((r) => r.kind === 'human' || r.kind === 'emit'));
    assert.ok(mixed.some((r) => r.seq === seq.answer && r.text === 'Rhonda, go ahead'));

    assert.equal(readRuns(dbPath).execute({ type: 'nope' }).rows.length, 0);
  } finally {
    cleanup(dbPath);
  }
});

test('id, before/after and run_id are exact filters', () => {
  const dbPath = tmpDbPath();
  const { runA, runB, seq } = seed(dbPath);
  try {
    const one = readRuns(dbPath).execute({ id: seq.tool }).rows;
    assert.equal(one.length, 1);
    assert.equal(one[0].kind, 'tool_result');

    const older = readRuns(dbPath).execute({ before: seq.rhonda }).rows;
    assert.ok(older.length > 0 && older.every((r) => r.seq < seq.rhonda));

    const newer = readRuns(dbPath).execute({ after: seq.rhonda }).rows;
    assert.ok(newer.length > 0 && newer.every((r) => r.seq > seq.rhonda));

    assert.deepEqual(
      readRuns(dbPath).execute({ run_id: runB }).rows.map((r) => r.seq),
      [seq.greet],
    );

    // combined: emits in run A, older than the last one
    assert.deepEqual(
      readRuns(dbPath).execute({ type: 'emit', run_id: runA, before: seq.next }).rows.map((r) => r.text),
      ['This phone is for Rhonda Pakkala.'],
    );
  } finally {
    cleanup(dbPath);
  }
});

test('limit bounds the rows', () => {
  const dbPath = tmpDbPath();
  seed(dbPath);
  try {
    assert.equal(readRuns(dbPath).execute({ limit: 2 }).rows.length, 2);
  } finally {
    cleanup(dbPath);
  }
});

test('expanded returns the enclosing step around a row', () => {
  const dbPath = tmpDbPath();
  const { runA, seq } = seed(dbPath);
  try {
    const out = readRuns(dbPath).execute({ mode: 'expanded', seq: seq.rhonda });
    assert.equal(out.run_id, runA);
    assert.equal(out.emit.text, 'This phone is for Rhonda Pakkala.');
    const tool = out.events.find((e) => e.kind === 'tool_result');
    assert.equal(tool.child, 'get_contact');
    assert.match(out.events[0].snippet, /Rhonda Pakkala/);

    const windowed = readRuns(dbPath).execute({ mode: 'expanded', seq: seq.rhonda, window: 1 });
    assert.deepEqual(windowed.events.map((e) => e.seq), [seq.rhonda - 1, seq.rhonda, seq.rhonda + 1]);
  } finally {
    cleanup(dbPath);
  }
});

test('errors are returned, not thrown', () => {
  const dbPath = tmpDbPath();
  const { seq } = seed(dbPath);
  try {
    assert.match(readRuns(dbPath).execute({ mode: 'expanded' }).error, /numeric seq/);
    assert.match(readRuns(dbPath).execute({ mode: 'expanded', seq: 999999 }).error, /no event at seq/);
    assert.match(readRuns(dbPath).execute({ id: 'x' }).error, /integer/);
    assert.match(readRuns('/no/such/grandma-kat.db').execute({}).error, /no run log/);
    assert.ok(readRuns(dbPath).execute({ mode: 'expanded', seq: seq.rhonda }).events.length > 0);
  } finally {
    cleanup(dbPath);
  }
});

test('the async (browser) path matches the Node path', async () => {
  const dbPath = tmpDbPath();
  seed(dbPath);
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const q = async (sql, params) => db.prepare(sql).all(...params);
      const tool = runLogToolFromQuery(q);
      const sync = readRuns(dbPath).execute({ type: ['human', 'emit'], limit: 6 });
      const asyncOut = await tool.execute({ type: ['human', 'emit'], limit: 6 });
      assert.deepEqual(asyncOut.rows.map((r) => r.text), sync.rows.map((r) => r.text));
      assert.deepEqual(asyncOut.rows.map((r) => r.seq), sync.rows.map((r) => r.seq));
    } finally {
      db.close();
    }
  } finally {
    cleanup(dbPath);
  }
});

test('the tool description advertises both modes and the type filter', () => {
  const { description } = runLogTools('/whatever.db')[0];
  assert.match(description, /condensed/);
  assert.match(description, /expanded/);
  assert.match(description, /type/);
  assert.match(description, /CURRENT state/i);
});
