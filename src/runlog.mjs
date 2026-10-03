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

/** Recent emits — the readable timeline. Newest first, across runs or one run. */
function condensed(db, { limit, runId } = {}) {
  const take = Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_LIMIT;
  const rows = runId
    ? db
        .prepare("SELECT run_id, definition_id, seq, content FROM calls WHERE kind = 'emit' AND run_id = ? ORDER BY seq DESC LIMIT ?")
        .all(runId, take)
    : db
        .prepare("SELECT run_id, definition_id, seq, content FROM calls WHERE kind = 'emit' ORDER BY seq DESC LIMIT ?")
        .all(take);
  return rows.map((r) => ({
    seq: r.seq,
    when: when(r.run_id),
    run_id: r.run_id,
    definition_id: r.definition_id,
    text: truncate(eventText(r.content)),
  }));
}

/**
 * The trace around one emit. Default span is the enclosing step: everything
 * after the previous emit and before the next one in the same run. Pass
 * `window` to take ±N events around the emit instead.
 */
function expanded(db, { seq, window } = {}) {
  const emit = db
    .prepare('SELECT run_id, definition_id, seq, content FROM calls WHERE seq = ?')
    .get(seq);
  if (!emit) throw new Error(`no event at seq ${seq}`);
  const runId = emit.run_id;

  let from;
  let to;
  if (Number.isInteger(window) && window > 0) {
    from = seq - window;
    to = seq + window;
  } else {
    const prev = db
      .prepare("SELECT seq FROM calls WHERE run_id = ? AND kind = 'emit' AND seq < ? ORDER BY seq DESC LIMIT 1")
      .get(runId, seq);
    const next = db
      .prepare("SELECT seq FROM calls WHERE run_id = ? AND kind = 'emit' AND seq > ? ORDER BY seq ASC LIMIT 1")
      .get(runId, seq);
    from = prev ? prev.seq + 1 : 0;
    to = next ? next.seq - 1 : Number.MAX_SAFE_INTEGER;
  }

  const rows = db
    .prepare('SELECT seq, kind, branch_path, content FROM calls WHERE run_id = ? AND seq >= ? AND seq <= ? ORDER BY seq')
    .all(runId, from, to);

  return {
    run_id: runId,
    when: when(runId),
    definition_id: emit.definition_id,
    emit: { seq: emit.seq, text: truncate(eventText(emit.content)) },
    events: rows.map((r) => ({
      seq: r.seq,
      kind: r.kind,
      child: eventChild(r.content),
      snippet: truncate(eventText(r.content)),
    })),
  };
}

/**
 * The run-log tool(s) for a host. `dbPath` is the same path handed to
 * `createLogger`. Returns AppTool-shaped entries (name/description/parameters/
 * execute), ready to merge into a host's tool set.
 */
export function runLogTools(dbPath, { defaultLimit = DEFAULT_LIMIT } = {}) {
  return [
    {
      name: 'read_runs',
      description:
        "Recall what the agent actually did in past sessions, from its run log. " +
        'mode "condensed" (default): the recent emit timeline — what the bot told the user, ' +
        'newest first — for "what have we been doing", "who did I talk to recently", ' +
        '"I just spoke to her", "what did you save / update", "what was the last change to a contact". ' +
        'mode "expanded": given an emit seq from a condensed result, the trace around it ' +
        '(llm calls, tool calls, results, records) that produced it — including the exact change ' +
        'a tool made, e.g. an upsert_contact diff of added/replaced fields. ' +
        'The log records what the agent DID; for a contact\'s CURRENT state use the contacts tree ' +
        'or get_contact instead. Emits carry the names the apps resolved, so recall does not ' +
        'depend on spelling.',
      parameters: {
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
      },
      execute(args = {}) {
        const mode = args.mode === 'expanded' ? 'expanded' : 'condensed';
        let db;
        try {
          db = open(dbPath);
          if (mode === 'expanded') {
            if (!Number.isInteger(args.seq)) return { error: "expanded mode needs the emit's numeric seq" };
            return expanded(db, { seq: args.seq, window: args.window });
          }
          return { emits: condensed(db, { limit: args.limit, runId: args.run_id }) };
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        } finally {
          db?.close();
        }
      },
    },
  ];
}
