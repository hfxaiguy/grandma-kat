// Run-log reader: a host tool over the `calls` table (see logger.mjs) so an
// agent can recall what actually happened — and what the user said — in past runs.
//
//   condensed — recent log rows, newest first, with basic filters: `type`
//               (one kind or a list; omit = every kind), `id` (one row by its
//               seq), `run_id`, `limit`, and `before`/`after` (seq bounds).
//               Emits are the semantic index — the bot's own user-facing
//               summaries, written in the app's words ("This phone is for
//               Rhonda Pakkala") — so `type:"emit"` is the old emit timeline,
//               while `type:"human"` is what the user actually said.
//   expanded  — the trace around one row: the llm calls, tool calls, results
//               and records that produced it. You don't pay for those payloads
//               until you have picked a row worth reading.
//   deps      — the provenance graph around one `llm_call`/`record`: the memory
//               slots it read (`content.reads`) and, for each, the row that
//               wrote it — walked `depth` levels back. Answers "why did the
//               prompt say that".
//
// The read is by `seq` (the table's primary key); condensed returns each row's
// seq so it can be handed to expanded.
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
 * The readable text of an event row. Emits carry value.text; a delivered human
 * reply carries value (what the user said); tool results carry result; llm
 * calls carry content (the model's output); records carry value; failures carry
 * error. A Human() that is still waiting carries no value, so it reads as a
 * short "(waiting at …)" marker rather than raw JSON.
 */
function eventText(content) {
  const c = parse(content);
  if (c == null || typeof c !== 'object') return String(c ?? '');
  if (typeof c.value?.text === 'string') return c.value.text;
  if (c.value !== undefined) return typeof c.value === 'string' ? c.value : JSON.stringify(c.value);
  if (c.result !== undefined) return typeof c.result === 'string' ? c.result : JSON.stringify(c.result);
  if (typeof c.content === 'string') return c.content;
  if (typeof c.error === 'string') return c.error;
  // A Human() pause row: { child, context, buttons } with no value yet.
  if (c.child !== undefined && c.buttons !== undefined) return `(waiting at ${c.child})`;
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

const SELECT_ROWS = 'SELECT run_id, definition_id, seq, branch_path, kind, content FROM calls';

// expanded: anchor a row by seq, then the enclosing step (or ±window) of rows.
const SQL = {
  anchor: 'SELECT run_id, definition_id, seq, kind, content FROM calls WHERE seq = ?',
  prevEmit:
    "SELECT seq FROM calls WHERE run_id = ? AND kind = 'emit' AND seq < ? ORDER BY seq DESC LIMIT 1",
  nextEmit:
    "SELECT seq FROM calls WHERE run_id = ? AND kind = 'emit' AND seq > ? ORDER BY seq ASC LIMIT 1",
  range: 'SELECT seq, kind, branch_path, content FROM calls WHERE run_id = ? AND seq >= ? AND seq <= ? ORDER BY seq',
};

/** A row in the recent-rows view — any kind, reduced to a readable line. */
const shapeRow = (r) => ({
  seq: r.seq,
  when: when(r.run_id),
  run_id: r.run_id,
  definition_id: r.definition_id,
  kind: r.kind,
  child: eventChild(r.content),
  text: truncate(eventText(r.content)),
});

const shapeTraceEvent = (r) => ({
  seq: r.seq,
  kind: r.kind,
  child: eventChild(r.content),
  snippet: truncate(eventText(r.content)),
});

// ── deps mode: the read-graph (provenance) ──────────────────────────────

const MAX_DEPTH = 8;

/** The `reads` array on a logged llm_call / record (provenance), or []. */
const parseReads = (content) => {
  const c = parse(content);
  return c && typeof c === 'object' && Array.isArray(c.reads) ? c.reads : [];
};

/** deps mode: one node of the read-graph. */
const shapeDepNode = (r) => ({
  seq: r.seq,
  kind: r.kind,
  child: eventChild(r.content),
  text: truncate(eventText(r.content)),
});

/** deps mode: one read edge — `from` read slot `name` from `to`'s write. */
const depEdge = (from, read, producer) => ({
  from,
  to: Number.isInteger(read.seq) ? read.seq : null,
  name: read.name ?? null,
  scope: read.scope ?? null,
  kind: producer?.kind ?? null,
  child: producer ? eventChild(producer.content) : null,
  text: producer ? truncate(eventText(producer.content)) : null,
});

const clampDepth = (depth) => Math.min(Math.max(Number.isInteger(depth) && depth > 0 ? depth : 1, 1), MAX_DEPTH);

const depsResult = (root, edges) => ({
  run_id: root.run_id,
  when: when(root.run_id),
  root: shapeDepNode(root),
  edges,
});

function takeLimit(limit) {
  return Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_LIMIT;
}

/** `type` may be one kind or a list; absent means "every kind". */
function normalizeTypes(type) {
  const list = Array.isArray(type) ? type : type == null ? [] : [type];
  return list.map((t) => String(t)).filter(Boolean);
}

function intOrNull(value, name) {
  if (value == null) return null;
  if (!Number.isInteger(value)) throw new Error(`${name} filter must be an integer`);
  return value;
}

/**
 * Build the filtered recent-rows query. Every filter is optional; with none,
 * it is "the most recent rows of any kind, newest first". `before`/`after`
 * bound seq; `id` selects one row by seq.
 */
function buildRecent(args = {}) {
  const where = [];
  const params = [];
  const id = intOrNull(args.id, 'id');
  if (id != null) {
    where.push('seq = ?');
    params.push(id);
  }
  const before = intOrNull(args.before, 'before');
  if (before != null) {
    where.push('seq < ?');
    params.push(before);
  }
  const after = intOrNull(args.after, 'after');
  if (after != null) {
    where.push('seq > ?');
    params.push(after);
  }
  if (args.run_id) {
    where.push('run_id = ?');
    params.push(args.run_id);
  }
  const types = normalizeTypes(args.type);
  if (types.length) {
    where.push(`kind IN (${types.map(() => '?').join(',')})`);
    params.push(...types);
  }
  const sql = `${SELECT_ROWS}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY seq DESC LIMIT ?`;
  params.push(takeLimit(args.limit));
  return { sql, params };
}

/** The [from, to] seq span for expanded: the enclosing step, or ±window. */
function spanFor(seq, prev, next, window) {
  if (Number.isInteger(window) && window > 0) return [seq - window, seq + window];
  return [prev ? prev.seq + 1 : 0, next ? next.seq - 1 : Number.MAX_SAFE_INTEGER];
}

/** expanded/deps need a numeric anchor seq. */
function requireAnchor(args, mode = 'expanded') {
  if (!Number.isInteger(args.seq)) throw new Error(`${mode} mode needs the row's numeric seq`);
  return args.seq;
}

const expandedResult = (anchorRow, rows) => ({
  run_id: anchorRow.run_id,
  when: when(anchorRow.run_id),
  definition_id: anchorRow.definition_id,
  emit: { seq: anchorRow.seq, kind: anchorRow.kind, text: truncate(eventText(anchorRow.content)) },
  events: rows.map(shapeTraceEvent),
});

const READ_RUNS_DESCRIPTION =
  'Recall what the agent actually did — and what the user said — from the run log. ' +
  'mode "condensed" (default): the most recent log rows of ALL kinds, newest first, ' +
  'with basic filters — `type` (one kind or a list: "emit" for what the bot told the user, ' +
  '"human" for what the user said, "tool_call"/"record"/"llm_call" for internals), ' +
  '`id` (one row by its seq), `run_id` (one run), `limit`, and `before`/`after` (seq bounds). ' +
  'For "what have we been doing", "who did I talk to recently", "what did you save / update", ' +
  'call with `type:"emit"` (the bot\'s own summaries, so recall does not depend on spelling). ' +
  'mode "expanded": given a row seq from a condensed result, the trace around it ' +
  '(llm calls, tool calls, results, records) that produced it — including the exact change ' +
  'a tool made, e.g. an upsert_contact diff of added/replaced fields. ' +
  'mode "deps": given the seq of an llm_call or record, the memory slots it read and, for each, ' +
  'the row that produced it (`edges`), walking back `depth` levels — why a prompt said what it said. ' +
  "The log records what the agent DID; for a contact's CURRENT state use the contacts tree " +
  'or get_contact instead.';

const readRunsParameters = (defaultLimit) => ({
  type: 'object',
  properties: {
    mode: {
      type: 'string',
      enum: ['condensed', 'expanded', 'deps'],
      description:
        'condensed (default) = the most recent log rows, all kinds unless `type` is given; expanded = the trace around one row; deps = the memory slots one row read. Call condensed first.',
    },
    type: {
      oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
      description:
        'condensed: row kind(s) to include — e.g. "emit" (what the bot said), "human" (what the user said), "tool_call", "record", "llm_call". Omit for every kind.',
    },
    id: { type: 'integer', description: 'condensed: return just the row with this seq.' },
    limit: {
      type: 'integer',
      description: `condensed: how many rows to return (default ${defaultLimit}).`,
    },
    before: { type: 'integer', description: 'condensed: only rows with seq < before (older).' },
    after: { type: 'integer', description: 'condensed: only rows with seq > after (newer).' },
    run_id: { type: 'string', description: 'condensed: restrict to one run (e.g. a caller-list session).' },
    seq: { type: 'integer', description: 'expanded/deps: the seq of the row to read (copy it from a condensed result).' },
    window: { type: 'integer', description: 'expanded: take ±N events around the row instead of the enclosing step.' },
    depth: { type: 'integer', description: `deps: how many levels of the read-graph to walk back (default 1, max ${MAX_DEPTH}).` },
  },
});

// ── Node path: synchronous over DatabaseSync ────────────────────────────

function expandSync(db, args) {
  const anchor = requireAnchor(args);
  const anchorRow = db.prepare(SQL.anchor).get(anchor);
  if (!anchorRow) throw new Error(`no event at seq ${anchor}`);
  const [prev] = db.prepare(SQL.prevEmit).all(anchorRow.run_id, anchor);
  const [next] = db.prepare(SQL.nextEmit).all(anchorRow.run_id, anchor);
  const [from, to] = spanFor(anchor, prev, next, args.window);
  const rows = db.prepare(SQL.range).all(anchorRow.run_id, from, to);
  return expandedResult(anchorRow, rows);
}

function depsSync(db, args) {
  const anchor = requireAnchor(args, 'deps');
  const getEvent = (seq) => db.prepare(SQL.anchor).get(seq);
  const root = getEvent(anchor);
  if (!root) throw new Error(`no event at seq ${anchor}`);
  const depth = clampDepth(args.depth);
  const edges = [];
  const visited = new Set([anchor]);
  let frontier = [anchor];
  for (let d = 0; d < depth && frontier.length; d += 1) {
    const next = [];
    for (const from of frontier) {
      for (const read of parseReads(getEvent(from)?.content)) {
        const producer = Number.isInteger(read.seq) ? getEvent(read.seq) : null;
        edges.push(depEdge(from, read, producer));
        if (Number.isInteger(read.seq) && !visited.has(read.seq)) { visited.add(read.seq); next.push(read.seq); }
      }
    }
    frontier = next;
  }
  return depsResult(root, edges);
}

function runSync(db, args = {}) {
  if (args.mode === 'expanded') return expandSync(db, args);
  if (args.mode === 'deps') return depsSync(db, args);
  const { sql, params } = buildRecent(args);
  return { rows: db.prepare(sql).all(...params).map(shapeRow) };
}

// ── Browser path: async over an injected query ──────────────────────────

async function expandAsync(query, args) {
  const anchor = requireAnchor(args);
  const [anchorRow] = await query(SQL.anchor, [anchor]);
  if (!anchorRow) throw new Error(`no event at seq ${anchor}`);
  const [prev] = await query(SQL.prevEmit, [anchorRow.run_id, anchor]);
  const [next] = await query(SQL.nextEmit, [anchorRow.run_id, anchor]);
  const [from, to] = spanFor(anchor, prev, next, args.window);
  const rows = await query(SQL.range, [anchorRow.run_id, from, to]);
  return expandedResult(anchorRow, rows);
}

async function depsAsync(query, args) {
  const anchor = requireAnchor(args, 'deps');
  const getEvent = async (seq) => (await query(SQL.anchor, [seq]))[0];
  const root = await getEvent(anchor);
  if (!root) throw new Error(`no event at seq ${anchor}`);
  const depth = clampDepth(args.depth);
  const edges = [];
  const visited = new Set([anchor]);
  let frontier = [anchor];
  for (let d = 0; d < depth && frontier.length; d += 1) {
    const next = [];
    for (const from of frontier) {
      for (const read of parseReads((await getEvent(from))?.content)) {
        const producer = Number.isInteger(read.seq) ? await getEvent(read.seq) : null;
        edges.push(depEdge(from, read, producer));
        if (Number.isInteger(read.seq) && !visited.has(read.seq)) { visited.add(read.seq); next.push(read.seq); }
      }
    }
    frontier = next;
  }
  return depsResult(root, edges);
}

async function runAsync(query, args = {}) {
  if (args.mode === 'expanded') return expandAsync(query, args);
  if (args.mode === 'deps') return depsAsync(query, args);
  const { sql, params } = buildRecent(args);
  const rows = await query(sql, params);
  return { rows: rows.map(shapeRow) };
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
