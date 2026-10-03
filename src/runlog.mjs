// Run-log reader: a host tool over the `calls` table (see logger.mjs) so an
// agent can recall what actually happened in past runs.
//
// Two modes, deliberately no full-text search:
//
//   condensed — only `emit` rows, newest first. Emits are the log's semantic
//               index: the bot's own user-facing summaries, written in the
//               app's words ("This phone is for Rhonda Pakkala"), so recall
//               never depends on the user's spelling and only a small slice of
//               rows is read.
//   expanded  — the trace around one emit: the llm calls, tool calls, results
//               and records that produced it. You don't pay for those payloads
//               until you have picked a row worth reading.
//
// The read is by `seq` (the table's primary key); condensed returns each
// emit's seq so it can be handed to expanded.
//
// Two entry points, same tool shape:
//   runLogTools(dbPath)        — Node, synchronous (DatabaseSync).
//   runLogToolFromQuery(query) — browser, async over OPFS/WASM SQLite.

import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const DEFAULT_LIMIT = 20;
const SNIPPET = 500;

const parse = (raw) => {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
};

/**
 * The readable text of an event row. Emits carry value.text; tool results
 * carry result; llm calls carry content (the model's output); records carry
 * value; failures carry error. Anything else is JSON.
 */
function eventText(content) {
  const c = parse(content);
  if (c == null || typeof c !== 'object') return String(c ?? '');
  if (typeof c.value?.text === 'string') return c.value.text;
  if (c.value !== undefined) return typeof c.value === 'string' ? c.value : JSON.stringify(c.value);
  if (c.result !== undefined) return typeof c.result === 'string' ? c.result : JSON.stringify(c.result);
  if (typeof c.content === 'string') return c.content;
  if (typeof c.error === 'string') return c.error;
  return JSON.stringify(c);
}

/** The child/tool an event is associated with, for the trace view. */
function eventChild(content) {
  const c = parse(content);
  return c && typeof c === 'object' ? c.child ?? c.tool ?? null : null;
}

/** The run start time encoded in the run id (2026-10-02_19-56-16-15). */
function when(runId) {
  const m = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/.exec(String(runId ?? ''));
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}` : String(runId ?? '');
}

const truncate = (s, n = SNIPPET) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

function open(dbPath) {
  if (!fs.existsSync(dbPath)) throw new Error(`no run log at ${dbPath}`);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

// ── shared SQL + row shaping ────────────────────────────────────────────

const SQL = {
  emitsAll: "SELECT run_id, definition_id, seq, content FROM calls WHERE kind = 'emit' ORDER BY seq DESC LIMIT ?",
  emitsRun:
    "SELECT run_id, definition_id, seq, content FROM calls WHERE kind = 'emit' AND run_id = ? ORDER BY seq DESC LIMIT ?",
  emitBySeq: 'SELECT run_id, definition_id, seq, content FROM calls WHERE seq = ?',
  prevEmit:
    "SELECT seq FROM calls WHERE run_id = ? AND kind = 'emit' AND seq < ? ORDER BY seq DESC LIMIT 1",
  nextEmit:
    "SELECT seq FROM calls WHERE run_id = ? AND kind = 'emit' AND seq > ? ORDER BY seq ASC LIMIT 1",
  range: 'SELECT seq, kind, branch_path, content FROM calls WHERE run_id = ? AND seq >= ? AND seq <= ? ORDER BY seq',
};

const shapeEmit = (r) => ({
  seq: r.seq,
  when: when(r.run_id),
  run_id: r.run_id,
  definition_id: r.definition_id,
  text: truncate(eventText(r.content)),
});

const shapeTraceEvent = (r) => ({
  seq: r.seq,
  kind: r.kind,
  child: eventChild(r.content),
  snippet: truncate(eventText(r.content)),
});

function takeLimit(limit) {
  return Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_LIMIT;
}

/** The [from, to] seq span for expanded: the enclosing step, or ±window. */
function spanFor(seq, prev, next, window) {
  if (Number.isInteger(window) && window > 0) return [seq - window, seq + window];
  return [prev ? prev.seq + 1 : 0, next ? next.seq - 1 : Number.MAX_SAFE_INTEGER];
}

const READ_RUNS_DESCRIPTION =
  "Recall what the agent actually did in past sessions, from its run log. " +
  'mode "condensed" (default): the recent emit timeline — what the bot told the user, ' +
  'newest first — for "what have we been doing", "who did I talk to recently", ' +
  '"I just spoke to her", "what did you save / update", "what was the last change to a contact". ' +
  'mode "expanded": given an emit seq from a condensed result, the trace around it ' +
  '(llm calls, tool calls, results, records) that produced it — including the exact change ' +
  'a tool made, e.g. an upsert_contact diff of added/replaced fields. ' +
  'The log records what the agent DID; for a contact\'s CURRENT state use the contacts tree ' +
  'or get_contact instead. Emits carry the names the apps resolved, so recall does not ' +
  'depend on spelling.';

const readRunsParameters = (defaultLimit) => ({
  type: 'object',
  properties: {
    mode: {
      type: 'string',
      enum: ['condensed', 'expanded'],
      description: 'condensed (default) = recent emits; expanded = the trace around one emit. Call condensed first.',
    },
    limit: { type: 'integer', description: `condensed: how many emits to return (default ${defaultLimit}).` },
    run_id: { type: 'string', description: 'condensed: restrict to one run (e.g. a caller-list session).' },
    seq: { type: 'integer', description: 'expanded: the seq of the emit to expand (copy it from a condensed result).' },
    window: { type: 'integer', description: 'expanded: take ±N events around the emit instead of the enclosing step.' },
  },
});

// ── Node path: synchronous over DatabaseSync ────────────────────────────

function runSync(db, args = {}) {
  if (args.mode === 'expanded') {
    if (!Number.isInteger(args.seq)) return { error: "expanded mode needs the emit's numeric seq" };
    const emit = db.prepare(SQL.emitBySeq).get(args.seq);
    if (!emit) throw new Error(`no event at seq ${args.seq}`);
    const [prev] = db.prepare(SQL.prevEmit).all(emit.run_id, args.seq);
    const [next] = db.prepare(SQL.nextEmit).all(emit.run_id, args.seq);
    const [from, to] = spanFor(args.seq, prev, next, args.window);
    const rows = db.prepare(SQL.range).all(emit.run_id, from, to);
    return {
      run_id: emit.run_id,
      when: when(emit.run_id),
      definition_id: emit.definition_id,
      emit: { seq: emit.seq, text: truncate(eventText(emit.content)) },
      events: rows.map(shapeTraceEvent),
    };
  }
  const take = takeLimit(args.limit);
  const rows = args.run_id
    ? db.prepare(SQL.emitsRun).all(args.run_id, take)
    : db.prepare(SQL.emitsAll).all(take);
  return { emits: rows.map(shapeEmit) };
}

// ── Browser path: async over an injected query ──────────────────────────

async function runAsync(query, args = {}) {
  if (args.mode === 'expanded') {
    if (!Number.isInteger(args.seq)) return { error: "expanded mode needs the emit's numeric seq" };
    const [emit] = await query(SQL.emitBySeq, [args.seq]);
    if (!emit) throw new Error(`no event at seq ${args.seq}`);
    const [prev] = await query(SQL.prevEmit, [emit.run_id, args.seq]);
    const [next] = await query(SQL.nextEmit, [emit.run_id, args.seq]);
    const [from, to] = spanFor(args.seq, prev, next, args.window);
    const rows = await query(SQL.range, [emit.run_id, from, to]);
    return {
      run_id: emit.run_id,
      when: when(emit.run_id),
      definition_id: emit.definition_id,
      emit: { seq: emit.seq, text: truncate(eventText(emit.content)) },
      events: rows.map(shapeTraceEvent),
    };
  }
  const take = takeLimit(args.limit);
  const rows = args.run_id
    ? await query(SQL.emitsRun, [args.run_id, take])
    : await query(SQL.emitsAll, [take]);
  return { emits: rows.map(shapeEmit) };
}

// ── tool envelopes ──────────────────────────────────────────────────────

/**
 * The read_runs tool over an injected query. `query(sql, params)` returns an
 * array of rows (sync or async), so a host with an async/OPFS SQLite (the
 * browser) can serve the same tool without node:sqlite.
 */
export function runLogToolFromQuery(query, { defaultLimit = DEFAULT_LIMIT } = {}) {
  return {
    name: 'read_runs',
    description: READ_RUNS_DESCRIPTION,
    parameters: readRunsParameters(defaultLimit),
    async execute(args = {}) {
      try {
        return await runAsync(query, args);
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

/**
 * The run-log tool(s) for a Node host. `dbPath` is the same path handed to
 * `createLogger`. Returns AppTool-shaped entries (name/description/parameters/
 * execute), ready to merge into a host's tool set.
 */
export function runLogTools(dbPath, { defaultLimit = DEFAULT_LIMIT } = {}) {
  return [
    {
      name: 'read_runs',
      description: READ_RUNS_DESCRIPTION,
      parameters: readRunsParameters(defaultLimit),
      execute(args = {}) {
        let db;
        try {
          db = open(dbPath);
          return runSync(db, args);
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        } finally {
          db?.close();
        }
      },
    },
  ];
}
