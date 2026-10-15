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

// Resuming a run replays `WHERE run_id = ? ORDER BY seq`, and runlog's
// emit-anchor/range lookups filter on run_id too. Without an index each of
// those is a full scan of `calls` — which grows into hundreds of MB in real
// deployments, and the scan is synchronous on the host's event loop (it froze
// the whole web UI / Telegram bot on every resumed turn). The logger must
// create idx_calls_run on every DB it opens.

test('calls are indexed by run_id — the resume query never full-scans', () => {
  const p = tmpDbPath();
  const logger = createLogger(p, 'none');
  const db = new DatabaseSync(p, { readOnly: true });
  try {
    for (let i = 0; i < 40; i++) {
      logger.log({
        run_id: i % 2 ? 'r1' : 'r2', definition_id: 'd1', branch_path: 'b',
        iteration: 1, scope_id: 1, kind: 'record', content: { i },
      });
    }
    const info = db.prepare("PRAGMA index_info('idx_calls_run')").all();
    assert.deepEqual(info.map((r) => r.name), ['run_id'], 'the index must cover exactly run_id');
    const infoKind = db.prepare("PRAGMA index_info('idx_calls_run_kind')").all();
    assert.deepEqual(infoKind.map((r) => r.name), ['run_id', 'kind'], 'the composite index covers run_id, kind');
    const plan = db.prepare('EXPLAIN QUERY PLAN SELECT * FROM calls WHERE run_id = ? ORDER BY seq')
      .all().map((r) => r.detail).join('; ');
    assert.match(plan, /idx_calls_run/, `the resume query must use the index, got: ${plan}`);
    assert.doesNotMatch(plan, /SCAN calls/i, `the resume query must not full-scan, got: ${plan}`);
    const kindPlan = db.prepare("EXPLAIN QUERY PLAN SELECT * FROM calls WHERE run_id = ? AND kind = 'emit'")
      .all().map((r) => r.detail).join('; ');
    assert.match(kindPlan, /idx_calls_run_kind/, `kind-filtered reads must use the composite index, got: ${kindPlan}`);
  } finally {
    db.close();
    logger.close();
    fs.rmSync(p, { force: true });
    fs.rmSync(p + '-wal', { force: true });
    fs.rmSync(p + '-shm', { force: true });
  }
});

test('an existing log DB from before the index gets it on open', () => {
  const p = tmpDbPath();
  const legacy = new DatabaseSync(p);
  legacy.exec(`
    CREATE TABLE calls (
      run_id TEXT NOT NULL, definition_id TEXT NOT NULL,
      seq INTEGER PRIMARY KEY AUTOINCREMENT, branch_path TEXT,
      iteration INTEGER, scope_id INTEGER, kind TEXT NOT NULL, content TEXT
    );
    CREATE TABLE checkpoints (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, seq INTEGER NOT NULL, resume_positions TEXT NOT NULL);
    CREATE TABLE runs (run_id TEXT PRIMARY KEY, session_id TEXT, started_at TEXT NOT NULL);
    INSERT INTO calls (run_id, definition_id, kind, content) VALUES ('old', 'd1', 'record', '{}')`);
  legacy.close();

  const logger = createLogger(p, 'none');
  const db = new DatabaseSync(p, { readOnly: true });
  try {
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'calls' ORDER BY name").all();
    assert.deepEqual(idx.map((r) => r.name), ['idx_calls_run', 'idx_calls_run_kind'], 'opening an old log must build the indexes');
  } finally {
    db.close();
    logger.close();
    fs.rmSync(p, { force: true });
    fs.rmSync(p + '-wal', { force: true });
    fs.rmSync(p + '-shm', { force: true });
  }
});
