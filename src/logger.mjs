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

const INFO_KINDS = new Set(['llm_call', 'tool_call', 'tool_result', 'flow', 'memory']);

const KIND_LABELS = {
  llm_call: 'LLM',
  tool_call: 'tool',
  tool_result: 'result',
  check: 'check',
  gate: 'gate',
  flow: 'flow',
  memory: 'memory',
  skip: 'skip',
  human: 'human',
};

class ConsoleLogger {
  constructor(level) {
    this.level = level; // 'info' or 'debug'
  }

  log(event) {
    if (this.level === 'info' && !INFO_KINDS.has(event.kind)) return;

    const label = KIND_LABELS[event.kind] ?? event.kind;
    const path = event.branch_path ? ` [${event.branch_path}]` : '';
    const iter = event.iteration > 1 ? ` #${event.iteration}` : '';
    const c = event.content ?? {};

    switch (event.kind) {
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
      case 'flow':
        console.error(`  ${label}${path}: ${c.type}${c.n ? ` goback(${c.n})` : ''}${c.child ? ` from '${c.child}'` : ''}${c.used ? ` (${c.used}/${c.max ?? '?'})` : ''}`);
        break;
      case 'memory':
        console.error(`  ${label}${path}: ${c.child} = ${truncate(JSON.stringify(c.value), 60)}`);
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
      default:
        if (this.level === 'debug') console.error(`  ${label}${path}: ${JSON.stringify(c)}`);
    }
  }

  close() {}
}

function truncate(s, max) {
  if (!s) return '';
  s = String(s).replace(/\n/g, ' ');
  return s.length > max ? s.slice(0, max) + '…' : s;
}

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

class CompositeLogger {
  constructor(loggers) {
    this.loggers = loggers;
  }
  log(event) {
    for (const l of this.loggers) l.log(event);
  }
  close() {
    for (const l of this.loggers) l.close?.();
  }
}

export function createLogger(opt, logLevel = 'none') {
  const loggers = [];

  if (opt !== false) {
    if (opt && typeof opt.log === 'function') {
      loggers.push({ log: (e) => opt.log(e), close: () => opt.close?.() });
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
