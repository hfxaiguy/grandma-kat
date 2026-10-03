import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLogger } from '../src/logger.mjs';
import { runLogTools } from '../src/runlog.mjs';

function tmpDbPath() {
  return path.join(
    os.tmpdir(),
    `grandma-kat-runlog-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

function cleanup(dbPath) {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
}

/** A tiny two-run log: one caller-list call (llm -> tool -> emit -> emit), one trunk greet. */
function seed(dbPath) {
  const logger = createLogger(dbPath, 'none');
  const caller = '2026-10-02_17-55-16-10';
  const trunk = '2026-10-02_18-00-00-1';
  const log = (run_id, definition_id, kind, content) =>
    logger.log({ run_id, definition_id, branch_path: 'x', iteration: 1, scope_id: 1, kind, content });
  log(caller, 'caller-list:abc', 'llm_call', {
    child: 'assist_prompt', round: 1, content: '{"handled":true,"text":"This phone is for Rhonda Pakkala."}',
  });
  log(caller, 'caller-list:abc', 'tool_result', {
    child: 'get_contact', tool: 'get_contact', args: { id: 1846 }, result: { ok: true, contact: { id: 1846, name: 'Rhonda Pakkala' } },
  });
  const rhondaEmit = log(caller, 'caller-list:abc', 'emit', {
    child: 'advance', value: { text: 'This phone is for Rhonda Pakkala.' },
  });
  log(caller, 'caller-list:abc', 'emit', {
    child: 'next', value: { text: 'Next up: John Deighan (2/43)' },
  });
  log(trunk, 'trunk:def', 'emit', {
    child: 'turn', value: { text: 'Hello, this is your grandpa BOB bot' },
  });
  logger.close();
  return { caller, trunk, rhondaEmit };
}

const readRuns = (dbPath) => runLogTools(dbPath)[0];

test('condensed lists recent emits, newest first', () => {
  const dbPath = tmpDbPath();
  const { caller } = seed(dbPath);
  try {
    const out = readRuns(dbPath).execute({ mode: 'condensed' });
    assert.equal(out.emits.length, 3);
    assert.equal(out.emits[0].text, 'Hello, this is your grandpa BOB bot');
    assert.equal(out.emits[1].text, 'Next up: John Deighan (2/43)');
    assert.equal(out.emits[2].text, 'This phone is for Rhonda Pakkala.');
    assert.equal(out.emits[2].run_id, caller);
    assert.equal(out.emits[2].when, '2026-10-02 17:55:16');

    const one = readRuns(dbPath).execute({ mode: 'condensed', run_id: caller });
    assert.deepEqual(one.emits.map((e) => e.text), [
      'Next up: John Deighan (2/43)',
      'This phone is for Rhonda Pakkala.',
    ]);
  } finally {
    cleanup(dbPath);
  }
});

test('expanded returns the enclosing step around an emit', () => {
  const dbPath = tmpDbPath();
  const { caller, rhondaEmit } = seed(dbPath);
  try {
    const out = readRuns(dbPath).execute({ mode: 'expanded', seq: rhondaEmit });
    assert.equal(out.run_id, caller);
    assert.equal(out.emit.text, 'This phone is for Rhonda Pakkala.');
    // The step that produced it: the llm call + tool result before it, and it.
    assert.deepEqual(out.events.map((e) => e.kind), ['llm_call', 'tool_result', 'emit']);
    const tool = out.events.find((e) => e.kind === 'tool_result');
    assert.equal(tool.child, 'get_contact');
    assert.match(tool.snippet, /Rhonda Pakkala/);
    assert.match(out.events[0].snippet, /This phone is for Rhonda Pakkala/);
  } finally {
    cleanup(dbPath);
  }
});

test('expanded honours an explicit window', () => {
  const dbPath = tmpDbPath();
  const { rhondaEmit } = seed(dbPath);
  try {
    const out = readRuns(dbPath).execute({ mode: 'expanded', seq: rhondaEmit, window: 1 });
    assert.deepEqual(out.events.map((e) => e.seq), [rhondaEmit - 1, rhondaEmit, rhondaEmit + 1]);
  } finally {
    cleanup(dbPath);
  }
});

test('errors are returned, not thrown', () => {
  const dbPath = tmpDbPath();
  const { rhondaEmit } = seed(dbPath);
  try {
    assert.match(readRuns(dbPath).execute({ mode: 'expanded' }).error, /numeric seq/);
    assert.match(readRuns(dbPath).execute({ mode: 'expanded', seq: 999999 }).error, /no event at seq/);
    assert.match(readRuns('/no/such/grandma-kat.db').execute({}).error, /no run log/);
    assert.ok(readRuns(dbPath).execute({ mode: 'expanded', seq: rhondaEmit }).events.length > 0);
  } finally {
    cleanup(dbPath);
  }
});

test('the tool description advertises both modes and the state-vs-history split', () => {
  const { description } = runLogTools('/whatever.db')[0];
  assert.match(description, /condensed/);
  assert.match(description, /expanded/);
  assert.match(description, /save|update/i);
  assert.match(description, /CURRENT state/i);
});
