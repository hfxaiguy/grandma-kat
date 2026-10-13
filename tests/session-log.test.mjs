// The session link + the log reader: a run records the host's opaque session
// key, and a host can ask for a session's runs and their events without knowing
// the schema.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import grandma, { Tree, name, Prompt, Return, listRuns, readEvents } from '../src/index.mjs';
import { mockRuntime } from './helpers.mjs';

const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kat-session-')), 'log.db');

test("a run records its session; the reader returns the session's runs and events", async () => {
  const db = tmpDb();
  const tree = Tree(name('s'), Prompt('p', () => 'hi'), Return((m) => m.branch.p));
  await grandma.knit(tree, {
    ...mockRuntime(async () => ({ content: 'ok' })),
    sessionId: 'web:test',
    logger: db,
  });

  const runs = listRuns(db, 'web:test');
  assert.equal(runs.length, 1, 'the run is attributed to the session');
  assert.match(String(runs[0].run_id), /^\d{4}-/, 'run_id looks like a run');
  assert.equal(listRuns(db, 'web:other').length, 0, 'another session has no runs');

  const events = readEvents(db, runs[0].run_id);
  assert.ok(events.length > 0, 'the run has events');
  assert.equal(typeof events[0].kind, 'string');
  assert.equal(typeof events[0].content, 'object', 'content is parsed');
  assert.equal(readEvents(db, runs[0].run_id, { tail: 1 }).length, 1, 'tail keeps the last N');
});

test('an unattributed run (no sessionId) is not listed under any session', async () => {
  const db = tmpDb();
  const tree = Tree(name('s'), Prompt('p', () => 'hi'), Return((m) => m.branch.p));
  await grandma.knit(tree, { ...mockRuntime(async () => ({ content: 'ok' })), logger: db });
  assert.equal(listRuns(db, 'web:test').length, 0);
  assert.equal(listRuns(db, '').length, 0, 'a null key lists nothing');
});
