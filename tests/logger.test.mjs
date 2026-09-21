import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLogger } from '../src/logger.mjs';

function tmpDbPath() {
  return path.join(os.tmpdir(), `grandma-kat-logtest-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

// The admin UI (and anything else that watches the log) polls the calls
// table with a read-only connection while a run is writing. With the old
// delete journal + busy_timeout 0, an overlapping read made the writer
// throw "database is locked" mid-run. WAL + busy_timeout fixes that.

test('SqliteLogger runs in WAL mode with a busy timeout', () => {
  const p = tmpDbPath();
  const logger = createLogger(p, 'none');
  const db = new DatabaseSync(p, { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    // busy_timeout is per-connection and set on the writer, not the reader;
    // SQLite reports it in a single `timeout` column.
    assert.ok(logger.db.prepare('PRAGMA busy_timeout').get().timeout >= 5000);
  } finally {
    db.close();
    logger.close();
    fs.rmSync(p, { force: true });
  }
});

test('an existing delete-journal log DB is migrated to WAL', () => {
  const p = tmpDbPath();
  const legacy = new DatabaseSync(p);
  legacy.exec('PRAGMA journal_mode = delete');
  legacy.exec('CREATE TABLE placeholder (x)');
  legacy.close();

  const logger = createLogger(p, 'none');
  const db = new DatabaseSync(p, { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal',
      'opening the logger on a legacy DB must upgrade it');
  } finally {
    db.close();
    logger.close();
    fs.rmSync(p, { force: true });
    fs.rmSync(p + '-wal', { force: true });
    fs.rmSync(p + '-shm', { force: true });
  }
});

test('writes succeed while a read-only poller has the DB open', () => {
  const p = tmpDbPath();
  const logger = createLogger(p, 'none');
  const reader = new DatabaseSync(p, { readOnly: true });
  try {
    reader.exec('PRAGMA busy_timeout = 5000');
    for (let i = 0; i < 50; i++) {
      logger.log({
        run_id: 'r1', definition_id: 'd1', branch_path: 'b', iteration: 1,
        scope_id: 1, kind: 'record', content: { i, pad: 'x'.repeat(200) },
      });
      // Interleave the poller exactly like the admin tree panel: query the
      // growing table between every logged event.
      reader.prepare('SELECT * FROM calls WHERE seq > ? ORDER BY seq').all(0);
    }
    const rows = new DatabaseSync(p, { readOnly: true }).prepare('SELECT count(*) n FROM calls').get();
    assert.equal(Number(rows.n), 50, 'every event survived the concurrent polling');
  } finally {
    reader.close();
    logger.close();
    fs.rmSync(p, { force: true });
    fs.rmSync(p + '-wal', { force: true });
    fs.rmSync(p + '-shm', { force: true });
  }
});
