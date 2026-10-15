// Call log: every event worth debugging is a row, including flow-control
// events (checks, gates, gobacks, skips). Default store is SQLite via
// node:sqlite; `logger: false` disables; a custom { log, close? } object
// can be injected for tests or alternative stores.
//
// logLevel controls console output: 'none' (default), 'info' (LLM calls,
// tool calls, flow events), 'debug' (everything).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

let runCounter = 0;
export function createRunId() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19) + '-' + (++runCounter);
}

// Which version of the definition ran: root name + content hash. Functions
// are replaced by stable placeholders so the hash is structural.
export function definitionId(rootDef) {
  const json = JSON.stringify(rootDef, (k, v) =>
    typeof v === 'function' ? `[fn:${v.name || 'anon'}]` : v);
  const hash = crypto.createHash('sha256').update(json).digest('hex').slice(0, 8);
  return `${rootDef.name ?? 'unnamed'}:${hash}`;
}

const nullLogger = { log() {}, close() {}, startRun() {}, saveCheckpoint() {}, getCheckpoint() { return null; }, deleteCheckpoint() {}, getEvents() { return []; } };

const INFO_KINDS = new Set(['llm_start', 'llm_call', 'llm_error', 'tool_call', 'tool_error', 'tool_result', 'flow']);

const KIND_LABELS = {
  llm_start: 'LLM…',
  llm_call: 'LLM',
  llm_error: 'LLM-ERR',
  tool_call: 'tool',
  tool_error: 'tool-ERR',
  tool_result: 'result',
  check: 'check',
  gate: 'gate',
  flow: 'flow',
  skip: 'skip',
  human: 'human',
  scope_init: 'scope',
  record: 'record',
  emit: 'emit',
};

class ConsoleLogger {
  constructor(level) {
    this.level = level; // 'info' or 'debug'
  }

  log(event) {
    const c = event.content ?? {};
    // Memory writes arrive as record events with op 'memory'/'memoryUpdate';
    // they stay visible at info level like the old dedicated rows were.
    const memWrite = event.kind === 'record' && (c.op === 'memory' || c.op === 'memoryUpdate');
    if (this.level === 'info' && !INFO_KINDS.has(event.kind) && !memWrite) return;

    const label = memWrite ? 'memory' : KIND_LABELS[event.kind] ?? event.kind;
    const path = event.branch_path ? ` [${event.branch_path}]` : '';
    const iter = event.iteration > 1 ? ` #${event.iteration}` : '';

    switch (event.kind) {
      case 'llm_start':
        console.error(`  ${label}${path}${iter}: ${c.model ?? '?'}${c.round > 1 ? ` round ${c.round}` : ''}${c.tools?.length ? ` (${c.tools.join(', ')})` : ''} — calling`);
        break;
      case 'llm_call':
        if (this.level === 'debug') {
          console.error(`  ${label}${path}${iter}: ${c.model ?? '?'}${c.round > 1 ? ` round ${c.round}` : ''}`);
          if (c.messages?.length) {
            console.error(`    input (${c.messages.length} messages):`);
            for (const m of c.messages) {
              const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
              console.error(`      [${m.role}] ${truncate(content, 200)}`);
            }
          }
          if (c.reasoning) console.error(`    thinking: ${c.reasoning}`);
          if (c.content) console.error(`    output: ${c.content}`);
          if (c.toolCalls?.length) console.error(`    tool calls: ${c.toolCalls.map(t => `${t.name ?? t.function?.name ?? '?'}(${t.arguments ?? t.function?.arguments ?? ''})`).join(', ')}`);
        } else {
          console.error(`  ${label}${path}${iter}: ${c.model ?? '?'}${c.round > 1 ? ` round ${c.round}` : ''}${c.content ? ` → ${truncate(c.content, 80)}` : ''}${c.toolCalls?.length ? ` (tool calls: ${c.toolCalls.map(t => t.name ?? t.function?.name ?? '?').join(', ')})` : ''}`);
        }
        break;
      case 'tool_call':
        console.error(`  ${label}${path}: ${c.tool ?? c.child ?? '?'}${c.args ? `(${truncate(JSON.stringify(c.args), 60)})` : ''}`);
        break;
      case 'tool_result':
        console.error(`  ${label}${path}: ${c.tool ?? '?'}${c.args ? `(${truncate(JSON.stringify(c.args), 80)})` : ''} → ${truncate(JSON.stringify(c.result), 80)}`);
        break;
      case 'llm_error':
        console.error(`  ${label}${path}: ${c.model ?? '?'} round ${c.round} FAILED: ${truncate(c.error, 200)}`);
        if (this.level === 'debug') {
          for (const m of c.messages ?? []) {
            const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
            console.error(`      [${m.role}] ${truncate(content, 200)}`);
          }
        }
        break;
      case 'tool_error':
        console.error(`  ${label}${path}: ${c.tool ?? '?'}${c.args ? `(${truncate(JSON.stringify(c.args), 80)})` : ''} FAILED: ${truncate(c.error, 200)}`);
        break;
      case 'flow':
        console.error(`  ${label}${path}: ${c.type}${c.n ? ` goback(${c.n})` : ''}${c.child ? ` from '${c.child}'` : ''}${c.used ? ` (${c.used}/${c.max ?? '?'})` : ''}`);
        break;

      case 'check':
        console.error(`  ${label}${path}: ${c.child ?? '?'} ${c.pass ? 'pass' : `FAIL: ${truncate(c.feedback, 60)}`}`);
        break;
      case 'gate':
        if (this.level === 'debug') console.error(`  ${label}${path}: ${c.child ?? '?'} → ${c.result}`);
        break;
      case 'human':
        console.error(`  ${label}${path}: ${c.child ?? '?'} (paused)`);
        break;
      case 'scope_init':
        if (this.level === 'debug') console.error(`  ${label}: #${c.scopeId} parent=${c.parentScopeId ?? 'root'}`);
        break;
      case 'record':
        if (memWrite) {
          console.error(`  ${label}${path}: ${c.child} = ${truncate(JSON.stringify(c.value), 60)}`);
        } else if (this.level === 'debug') {
          console.error(`  ${label}${path}: ${c.child} (idx=${c.childIndex}) → ${truncate(JSON.stringify(c.value), 60)}`);
        }
        break;
      case 'emit':
        if (this.level === 'debug') console.error(`  ${label}${path}: ${truncate(JSON.stringify(c.value), 60)}`);
        break;
      default:
        if (this.level === 'debug') console.error(`  ${label}${path}: ${JSON.stringify(c)}`);
    }
  }

  close() {}

  startRun() {}
  saveCheckpoint() {}
  getCheckpoint() { return null; }
  deleteCheckpoint() {}
  getEvents() { return []; }
}

function truncate(s, max) {
  if (!s) return '';
  s = String(s).replace(/\n/g, ' ');
  return s.length > max ? s.slice(0, max) + '…' : s;
}

// `idx_calls_run` serves the hot read paths: resuming a turn replays a run
// with `WHERE run_id = ? ORDER BY seq` (seq is the rowid, which the index is
// already ordered by), and runlog's emit-anchor/range lookups filter on
// run_id too. Without it those queries full-scan `calls`, which grows
// unboundedly (hundreds of MB in real deployments) — and the scan runs
// synchronously on the host's event loop, freezing whatever serves the UI.
//
// `idx_calls_run_kind` serves kind-filtered reads within a run: a host
// deriving UI state (e.g. web session turns from `human`/`emit` events) or
// rolling up its own marker kinds (`run_id` = session key) reads
// `WHERE run_id = ? AND kind ...`; the composite makes that an index seek,
// and a whole-table `GROUP BY run_id, kind` becomes an index-only ordered
// pass (rowid is the trailing column, so MAX(seq) per group needs no table
// rows).
const CREATE_TABLES = `
CREATE TABLE IF NOT EXISTS calls (
  run_id TEXT NOT NULL,
  definition_id TEXT NOT NULL,
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  branch_path TEXT,
  iteration INTEGER,
  scope_id INTEGER,
  kind TEXT NOT NULL,
  content TEXT
);
CREATE TABLE IF NOT EXISTS checkpoints (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  resume_positions TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  session_id TEXT,
  started_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id);
CREATE INDEX IF NOT EXISTS idx_calls_run ON calls(run_id);
CREATE INDEX IF NOT EXISTS idx_calls_run_kind ON calls(run_id, kind)`;

class SqliteLogger {
  constructor(dbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    // Read-only pollers (admin tree panels, log viewers) must not starve
    // the writer: WAL lets readers and writers coexist, and busy_timeout
    // turns transient contention (e.g. the one-off mode migration on an
    // existing delete-journal DB) into a short wait instead of throwing
    // "database is locked" mid-run.
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(CREATE_TABLES);
    this.insert = this.db.prepare(
      'INSERT INTO calls (run_id, definition_id, branch_path, iteration, scope_id, kind, content) VALUES (?, ?, ?, ?, ?, ?, ?)');
    this.insertCp = this.db.prepare(
      'INSERT INTO checkpoints (id, run_id, seq, resume_positions) VALUES (?, ?, ?, ?)');
    this.selectCp = this.db.prepare(
      'SELECT * FROM checkpoints WHERE id = ?');
    this.deleteCp = this.db.prepare(
      'DELETE FROM checkpoints WHERE id = ?');
    this.selectEvents = this.db.prepare(
      'SELECT * FROM calls WHERE run_id = ? ORDER BY seq');
    this.selectRow = this.db.prepare(
      'SELECT * FROM calls WHERE seq = ?');
    this.insertRun = this.db.prepare(
      'INSERT OR IGNORE INTO runs (run_id, session_id, started_at) VALUES (?, ?, ?)');
  }

  /**
   * Record which session a run belongs to (once per run; a resumed run keeps
   * its original row). The host passes an opaque `runtime.sessionId`; the log
   * stores it so a host can later ask "which runs are this session's?".
   */
  startRun(runId, sessionId) {
    this.insertRun.run(runId, sessionId ?? null, new Date().toISOString());
  }

  log(event) {
    const { lastInsertRowid } = this.insert.run(
      event.run_id,
      event.definition_id,
      event.branch_path,
      event.iteration,
      event.scope_id ?? null,
      event.kind,
      JSON.stringify(event.content ?? null));
    return Number(lastInsertRowid);
  }

  saveCheckpoint(id, runId, seq, resumePositions) {
    this.insertCp.run(id, runId, seq, JSON.stringify(resumePositions));
  }

  getCheckpoint(runId) {
    return this.selectCp.get(runId) ?? null;
  }

  deleteCheckpoint(runId) {
    this.deleteCp.run(runId);
  }

  getEvents(runId) {
    return this.selectEvents.all(runId).map((r) => ({
      ...r,
      content: JSON.parse(r.content),
    }));
  }

  /**
   * One log row by seq, content parsed — the store behind `ref://` handles
   * (see refs.mjs). Returns null when the seq is unknown.
   */
  readRow(seq) {
    const row = this.selectRow.get(seq);
    return row ? { ...row, content: JSON.parse(row.content) } : null;
  }

  close() {
    this.db.close();
  }
}

class CompositeLogger {
  constructor(loggers) {
    this.loggers = loggers;
    // Find the first logger with read methods (SqliteLogger).
    this.reader = loggers.find((l) => typeof l.getCheckpoint === 'function' && l !== nullLogger) ?? nullLogger;
  }
  log(event) {
    let seq;
    for (const l of this.loggers) {
      const r = l.log(event);
      if (r !== undefined) seq = r;
    }
    return seq;
  }
  close() {
    for (const l of this.loggers) l.close?.();
  }
  startRun(runId, sessionId) { this.reader.startRun?.(runId, sessionId); }
  saveCheckpoint(id, runId, seq, resumePositions) { this.reader.saveCheckpoint(id, runId, seq, resumePositions); }
  getCheckpoint(runId) { return this.reader.getCheckpoint(runId); }
  deleteCheckpoint(runId) { this.reader.deleteCheckpoint(runId); }
  getEvents(runId) { return this.reader.getEvents(runId); }
  readRow(seq) { return this.reader.readRow?.(seq) ?? null; }
}

export function createLogger(opt, logLevel = 'none') {
  const loggers = [];

  if (opt !== false) {
    if (opt && typeof opt.log === 'function') {
      loggers.push(opt);
    } else {
      const dbPath = typeof opt === 'string'
        ? opt
        : opt?.path ?? path.join(process.cwd(), 'logs', 'grandma-kat.db');
      loggers.push(new SqliteLogger(dbPath));
    }
  }

  if (logLevel === 'info' || logLevel === 'debug') {
    loggers.push(new ConsoleLogger(logLevel));
  }

  if (loggers.length === 0) return nullLogger;
  if (loggers.length === 1) return loggers[0];
  return new CompositeLogger(loggers);
}
