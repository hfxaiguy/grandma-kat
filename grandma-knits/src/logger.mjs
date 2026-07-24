// Call log: every event worth debugging is a row, including flow-control
// events (checks, gates, gobacks, skips). Default store is SQLite via
// node:sqlite; `logger: false` disables; a custom { log, close? } object
// can be injected for tests or alternative stores.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export function createRunId() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}

// Which version of the definition ran: root name + content hash. Functions
// are replaced by stable placeholders so the hash is structural.
export function definitionId(rootDef) {
  const json = JSON.stringify(rootDef, (k, v) =>
    typeof v === 'function' ? `[fn:${v.name || 'anon'}]` : v);
  const hash = crypto.createHash('sha256').update(json).digest('hex').slice(0, 8);
  return `${rootDef.name ?? 'unnamed'}:${hash}`;
}

const nullLogger = { log() {}, close() {} };

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS calls (
  run_id TEXT NOT NULL,
  definition_id TEXT NOT NULL,
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  branch_path TEXT,
  iteration INTEGER,
  kind TEXT NOT NULL,
  content TEXT
)`;

class SqliteLogger {
  constructor(dbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(CREATE_TABLE);
    this.insert = this.db.prepare(
      'INSERT INTO calls (run_id, definition_id, branch_path, iteration, kind, content) VALUES (?, ?, ?, ?, ?, ?)');
  }

  log(event) {
    this.insert.run(
      event.run_id,
      event.definition_id,
      event.branch_path,
      event.iteration,
      event.kind,
      JSON.stringify(event.content ?? null));
  }

  close() {
    this.db.close();
  }
}

export function createLogger(opt) {
  if (opt === false) return nullLogger;
  if (opt && typeof opt.log === 'function') {
    return { log: (e) => opt.log(e), close: () => opt.close?.() };
  }
  const dbPath = typeof opt === 'string'
    ? opt
    : opt?.path ?? path.join(process.cwd(), 'logs', 'grandma-kat.db');
  return new SqliteLogger(dbPath);
}
