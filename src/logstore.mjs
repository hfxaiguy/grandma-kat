// Portable session log store: the engine's synchronous logger contract over an
// asynchronous durable driver.
//
// The engine logs synchronously (`log()` returns the row's seq — refs are
// addresses) and reads synchronously during a turn (`readRow`, `getEvents`,
// `getCheckpoint` are consumed in the same tick). A durable store need not be
// synchronous, though: this store keeps the rows in memory — the replica the
// engine reads — and shadows them to the driver asynchronously.
//
// The replica is complete by construction:
//
//   - `log()` appends the row before returning its seq, so every address the
//     engine can mint is already readable.
//   - checkpoints are shadowed too (see `saveCheckpoint`), with one ordering
//     rule: a checkpoint row is enqueued only after every call row it depends
//     on, so "the checkpoint exists on disk" implies "its run's rows do".
//   - `restore()` rebuilds the replica from the driver after a process
//     restart (a page reload, a worker reboot) — the engine stays untouched.
//
// Hosts keep the policy: which checkpoint a conversation resumes, session
// labels, retention budgets. The engine-facing mechanism lives here.

/** The engine's call + checkpoint tables. Drivers add their own indexes. */
export const LOG_TABLES = `
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
);`;

function parseContent(content) {
  if (typeof content !== "string") return content ?? null;
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/** A driver row (content possibly still JSON) as the engine's in-memory row. */
function normalizeRow(row) {
  if (!row || typeof row !== "object") return null;
  const seq = Number(row.seq);
  if (!Number.isFinite(seq)) return null;
  return { ...row, seq, content: parseContent(row.content) };
}

/** A checkpoint (`resume_positions` coerced to the JSON string resume parses). */
function normalizeCheckpoint(cp) {
  if (!cp || typeof cp !== "object") return null;
  const id = typeof cp.id === "string" ? cp.id : "";
  const runId = typeof cp.run_id === "string" ? cp.run_id : "";
  const seq = Number(cp.seq);
  if (!id || !runId || !Number.isFinite(seq)) return null;
  const resume =
    typeof cp.resume_positions === "string"
      ? cp.resume_positions
      : JSON.stringify(cp.resume_positions ?? []);
  return { id, run_id: runId, seq, resume_positions: resume };
}

const defaultError = (err) => {
  console.warn("[logstore] write failed:", err instanceof Error ? err.message : String(err));
};

/**
 * Build a session log store.
 *
 * @param {object} options
 * @param {object} options.driver
 *   Durable, asynchronous store for one log database:
 *     appendCalls(rows)                       persist a batch of event rows
 *     upsertCheckpoint(row)                   persist a checkpoint row
 *     deleteCheckpointRow(id)                 drop a consumed checkpoint
 *     getCheckpoint(id)                       one checkpoint row by id
 *     getEvents(runId, { upToSeq })           a run's rows, ordered by seq
 *     headSeq()                               current MAX(seq) (when allocateSeq is omitted)
 *     startRun(runId, sessionId)              optional session attribution
 * @param {() => number} [options.allocateSeq]
 *   Synchronous seq allocator. Pass the host's allocator when other writers
 *   share the database (markers, a bridged host); omit to let the store seed
 *   its counter from `driver.headSeq()` in `ready`.
 * @param {(row: object) => void} [options.onEvent]
 *   Receives each row after it is appended (live streaming).
 * @param {(err: unknown) => void} [options.onError]
 *   Write failure sink. Failures never break a run; the default warns.
 * @param {number} [options.flushDelayMs]
 *   Batch window for call rows (default 150 ms, or 0 to write synchronously).
 * @returns {object} the synchronous logger surface plus `ready`, `flush`,
 *   `restore` and `events`.
 */
export function createSessionLogStore(options = {}) {
  const { driver, allocateSeq, onEvent, onError = defaultError, flushDelayMs = 150 } = options;
  if (!driver || typeof driver.appendCalls !== "function") {
    throw new TypeError("createSessionLogStore: driver.appendCalls is required");
  }

  const events = [];
  /** seq → row, for `readRow` (the engine's ref store). */
  const bySeq = new Map();
  const checkpoints = new Map();
  let pending = [];
  let timer = null;
  let chain = Promise.resolve();
  let localSeq = 0;

  const ready =
    typeof allocateSeq === "function"
      ? Promise.resolve()
      : (async () => {
          if (typeof driver.headSeq === "function") {
            const seq = Number(await driver.headSeq());
            localSeq = Number.isFinite(seq) ? seq : 0;
          }
        })();

  function appendRow(row) {
    events.push(row);
    if (typeof row.seq === "number") bySeq.set(row.seq, row);
  }

  function enqueue(task) {
    chain = chain.then(task).catch((err) => {
      onError(err);
    });
    return chain;
  }

  /** Enqueue the buffered call rows (used before a checkpoint shadow write). */
  function flushPending() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!pending.length) return;
    const batch = pending;
    pending = [];
    enqueue(() => driver.appendCalls(batch));
  }

  function scheduleFlush() {
    if (flushDelayMs <= 0) {
      flushPending();
      return;
    }
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      flushPending();
    }, flushDelayMs);
    // Node: a pending batch must not hold the process open.
    if (typeof timer.unref === "function") timer.unref();
  }

  /** Append one engine event; returns its seq (the engine's row address). */
  function log(event) {
    const seq = typeof allocateSeq === "function" ? allocateSeq() : ++localSeq;
    const row = { ...event, seq };
    appendRow(row);
    pending.push(row);
    scheduleFlush();
    onEvent?.(row);
    return seq;
  }

  /** One row by seq — the store behind `ref://` handles. Synchronous. */
  function readRow(seq) {
    const hit = bySeq.get(seq);
    if (hit) return hit;
    // A driver may re-key a buffered batch onto the database's max seq; the
    // row object and its seq stay together, but the map key can go stale.
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].seq === seq) return events[i];
    }
    return null;
  }

  /**
   * Persist a pause point. The in-memory row is available immediately (the
   * engine's resume within this process reads it synchronously); the shadow
   * write is ordered after every call row it depends on, so a restored
   * checkpoint always has its replay window on disk.
   */
  function saveCheckpoint(id, runId, seq, resumePositions) {
    const row = normalizeCheckpoint({ id, run_id: runId, seq, resume_positions: resumePositions });
    if (!row) return;
    checkpoints.set(row.id, row);
    flushPending();
    enqueue(() => driver.upsertCheckpoint({ ...row }));
  }

  /** A checkpoint row by id (synchronous; the engine's resume consumes it). */
  function getCheckpoint(id) {
    return checkpoints.get(id) ?? null;
  }

  /** Drop a consumed checkpoint (memory now, row after the pending writes). */
  function deleteCheckpoint(id) {
    checkpoints.delete(id);
    flushPending();
    enqueue(() => driver.deleteCheckpointRow?.(id));
  }

  /** The rows of one run, oldest first (the engine's resume replay). */
  function getEvents(runId) {
    return events.filter((row) => row.run_id === runId).sort((a, b) => a.seq - b.seq);
  }

  /** Attribute a run to the host's opaque session key. */
  function startRun(runId, sessionId) {
    if (typeof driver.startRun !== "function") return;
    enqueue(() => driver.startRun(runId, sessionId));
  }

  /** Settle every buffered call row and shadow write (checkpoints included). */
  function flush() {
    flushPending();
    return chain;
  }

  /**
   * Rebuild the in-memory replica from the driver after a restart.
   *
   * The host resolves *which* checkpoint a conversation resumes (its policy);
   * this loads the row and the run's replay window, validates that the pause
   * row is present, and hydrates memory so `resume()` can run synchronously.
   *
   * @param {string|object} checkpoint  checkpoint id or an already-loaded row
   * @returns {Promise<{ok:true, checkpoint:object, events:number}
   *   | {ok:false, reason:string}>}
   */
  async function restore(checkpoint) {
    await flush();
    let cp =
      typeof checkpoint === "string"
        ? checkpoints.get(checkpoint) ??
          (typeof driver.getCheckpoint === "function"
            ? await driver.getCheckpoint(checkpoint).catch(() => null)
            : null)
        : checkpoint;
    cp = normalizeCheckpoint(cp);
    if (!cp) return { ok: false, reason: "checkpoint not found" };
    if (typeof driver.getEvents !== "function") {
      return { ok: false, reason: "driver cannot read events" };
    }
    let raw;
    try {
      raw = await driver.getEvents(cp.run_id, { upToSeq: cp.seq });
    } catch (err) {
      return { ok: false, reason: `event read failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    const seen = new Set();
    const rows = [];
    for (const value of Array.isArray(raw) ? raw : []) {
      const row = normalizeRow(value);
      if (!row || row.run_id !== cp.run_id || row.seq > cp.seq) continue;
      if (seen.has(row.seq)) continue;
      seen.add(row.seq);
      rows.push(row);
    }
    rows.sort((a, b) => a.seq - b.seq);
    if (!rows.length) return { ok: false, reason: "no events for the paused run" };
    const last = rows[rows.length - 1];
    if (last.seq !== cp.seq) {
      return {
        ok: false,
        reason: `pause row ${cp.seq} missing from the log (last is ${last.seq})`,
      };
    }
    for (const row of rows) {
      if (!bySeq.has(row.seq)) appendRow(row);
    }
    checkpoints.set(cp.id, cp);
    return { ok: true, checkpoint: cp, events: rows.length };
  }

  /** Best-effort final flush; drivers own their connections. */
  function close() {
    flushPending();
  }

  return {
    ready,
    log,
    readRow,
    saveCheckpoint,
    getCheckpoint,
    deleteCheckpoint,
    getEvents,
    startRun,
    flush,
    restore,
    close,
    get events() {
      return events;
    },
  };
}
