// refs.mjs — `ref://<seq>/<path>` handles into the run log.
//
// A tool result too large to show the model is truncated, and the note that
// replaces it can carry a ref (minted by the trunk's note — see
// tests/flows/tool-policy.mjs). The ref names the run-log row that already
// holds the FULL value (an `Each` item's `map_item` row, a `tool_call` row),
// so nothing needs to be stashed: the log is the store.
//
// A tree tool called with a ref in its args gets the real value: resolution
// happens here, at the tree-tool boundary in knit.mjs, BEFORE the args are
// seeded into the child scope — the app never sees a ref string.
//
// Grammar: `ref://<digits>` selects the row's payload whole; a trailing
// `/`-separated path walks into it (object keys and array indices). The trunk
// mints `…/list` for `{ …, list: […] }` results and the bare form otherwise.
//
// Guards: the row must exist and belong to THIS run (a ref can never address
// another session's rows), and the path must find a value. Anything else
// throws — the message reaches the model as a normal tool error, so it can
// re-query instead of silently working on the wrong data.

const REF = /^ref:\/\/(\d+)(?:\/([\w.\-/]*))?$/;

/** True for the exact ref grammar (a plain string). */
export function isRef(value) {
  return typeof value === 'string' && REF.test(value);
}

/**
 * True when this run's logger can read rows back — the precondition for refs:
 * minting happens only then, and resolution re-reads the same store.
 */
export function refsResolvable(exec) {
  return typeof exec?.logger?.readRow === 'function';
}

/** The parsed ref — { seq, path } — or null when the string is not one. */
export function parseRef(value) {
  const m = typeof value === 'string' ? REF.exec(value) : null;
  if (!m) return null;
  return { seq: Number(m[1]), path: (m[2] ?? '').split('/').filter((p) => p !== '') };
}

/** The payload of a log row: map_item/tool_call rows carry `.value`/`.result`;
 *  a record row carries `.value`; anything else is its own content. */
function payloadOf(content) {
  if (content == null || typeof content !== 'object') return content;
  if (content.value !== undefined) return content.value;
  if (content.result !== undefined) return content.result;
  return content;
}

/** Walk a path into a value (object keys and array indices). */
function walk(value, path) {
  let cur = value;
  for (const step of path) {
    if (cur == null) return undefined;
    cur = Array.isArray(cur) ? cur[Number(step)] : cur[step];
  }
  return cur;
}

/**
 * Resolve one ref against the run log.
 * @param {object} exec  the walker's exec (needs `logger` and `runId`)
 * @param {string} ref   the `ref://…` string
 * @returns the addressed value
 * @throws when the row is missing, belongs to another run, or the path misses
 */
export function resolveRef(exec, ref) {
  const parsed = parseRef(ref);
  if (!parsed) throw new Error(`not a ref: ${ref}`);
  const row = exec?.logger?.readRow?.(parsed.seq) ?? null;
  if (!row) throw new Error(`ref ${ref}: no run-log row at seq ${parsed.seq}`);
  if (exec.runId && row.run_id !== exec.runId) {
    throw new Error(`ref ${ref}: row ${parsed.seq} belongs to another run`);
  }
  const value = walk(payloadOf(row.content), parsed.path);
  if (value === undefined) {
    throw new Error(`ref ${ref}: path '${parsed.path.join('/')}' not found in row ${parsed.seq}`);
  }
  return value;
}

/**
 * Substitute every ref in a tree-tool argument value. Structural sharing:
 * a value with no refs is returned as-is, so big plain arrays are never
 * copied on the way in. Plain objects are rebuilt with Object.fromEntries
 * (safe for `__proto__` keys that arrive from model-written JSON).
 */
export function resolveRefs(exec, value) {
  if (isRef(value)) return resolveRef(exec, value);
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((v) => {
      const next = resolveRefs(exec, v);
      if (next !== v) changed = true;
      return next;
    });
    return changed ? out : value;
  }
  if (value != null && typeof value === 'object') {
    let changed = false;
    const entries = Object.entries(value).map(([k, v]) => {
      const next = resolveRefs(exec, v);
      if (next !== v) changed = true;
      return [k, next];
    });
    return changed ? Object.fromEntries(entries) : value;
  }
  return value;
}
