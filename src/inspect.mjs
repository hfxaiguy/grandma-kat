// inspect_memory — a host tool that hands a model a BOUNDED view of a value it
// holds only by handle.
//
// A tool result too big for context is passed between trees as a
// `ref://<name>.<seq>` handle (see refs.mjs), and a live slot is addressable by
// its `m.<name>`. Both are opaque to the model: a ref is a string, and a slot
// it never read is invisible. This tool resolves either and returns a small,
// valid-JSON view — a type/size summary plus a random sample (or the head) of
// rows — so the model can decide what to do next without the whole value ever
// entering its context.
//
// It is an ordinary host tool (merged into `runtime.tools` like runLogTools),
// but it leans on two engine capabilities the engine passes in `ctx`:
// `ctx.view` (the live call-site scope chain), `ctx.readRef(ref)` (resolve a
// handle against this run's log), and `ctx.scopeInfo()` (the slot inventory,
// with each slot's write `seq`). Nothing here mutates memory or the log.

import { walk } from './refs.mjs';

/** Rows sampled when an array is read without an explicit `sample`/`head`. */
export const DEFAULT_SAMPLE = 5;
/** Char budget for the returned JSON when `maxChars` is not given. */
export const DEFAULT_MAX_CHARS = 2000;

const DESCRIPTION =
  'Look inside a value you hold by handle, without loading it into context. ' +
  'Pass `ref` for a ref://<name>.<seq> handle you were given, or `name` for a live ' +
  'memory slot (m.<name>); or `name: "*"` to list every slot in scope. Returns a ' +
  'type/size summary plus a small random sample of rows (use `head` for the first ' +
  'rows, `path` to walk into the value). The full value stays in memory / the run log.';

/**
 * The `inspect_memory` tool. `sample` and `maxChars` are the defaults for an
 * array read and the output budget; a call may override either.
 */
export function inspectMemoryTool({ sample = DEFAULT_SAMPLE, maxChars = DEFAULT_MAX_CHARS } = {}) {
  const defaults = { sample, maxChars };
  return {
    name: 'inspect_memory',
    description: DESCRIPTION,
    parameters: inspectParameters(defaults),
    execute(args = {}, ctx = {}) {
      // A host tool reports a bad name/ref as an ordinary tool error (the
      // shape isErrorResult recognises), so the model can recover in-loop.
      try {
        return inspect(args, ctx, defaults);
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

function inspect(args, ctx, defaults) {
  if (args.list === true || args.name === '*') return inventory(ctx);
  const { value, source } = resolveTarget(args, ctx);
  const walked = applyPath(value, args.path);
  return shape(walked, args, source, defaults);
}

// ── resolution ──────────────────────────────────────────────────────────────

/** Resolve the addressed value: `ref` against the run log, else a live slot. */
function resolveTarget(args, ctx) {
  if (typeof args.ref === 'string' && args.ref.trim()) {
    const ref = args.ref.trim();
    if (typeof ctx.readRef !== 'function') {
      throw new Error('this run has no readable run log; ref:// handles are unavailable');
    }
    return { value: ctx.readRef(ref), source: { ref } };
  }
  if (typeof args.name === 'string' && args.name.trim()) {
    const name = args.name.trim();
    const info = typeof ctx.scopeInfo === 'function' ? ctx.scopeInfo() : { slots: [] };
    const hit = info.slots.find((slot) => slot.name === name);
    if (!hit) {
      const have = info.slots.map((slot) => slot.name).join(', ');
      throw new Error(
        `no memory slot '${name}' in scope${have ? ` (have: ${have})` : ' (the scope is empty)'}`,
      );
    }
    if (ctx.view == null) throw new Error('live memory is unavailable in this run');
    return { value: ctx.view[name], source: { name, seq: hit.seq } };
  }
  throw new Error(
    'inspect_memory needs a `name` (a live memory slot) or a `ref` (a run-log handle); ' +
    'pass { list: true } to see what is in scope',
  );
}

/** The listing mode: every slot visible from here, with a ref when it has one. */
function inventory(ctx) {
  const info = typeof ctx.scopeInfo === 'function' ? ctx.scopeInfo() : { scopeId: null, slots: [] };
  return {
    type: 'inventory',
    scopeId: info.scopeId ?? null,
    slots: info.slots.map(({ name, ownerScopeId, seq }) => ({
      name,
      ownerScopeId,
      ...describe(ctx.view?.[name]),
      ...(Number.isFinite(seq) ? { ref: refFor(name, seq) } : {}),
    })),
    note: 'read one with { name }; pass a slot\'s ref as a tree tool\'s input for the whole value',
  };
}

function applyPath(value, path) {
  const steps = normalizePath(path);
  return steps.length ? walk(value, steps) : value;
}

function normalizePath(path) {
  if (Array.isArray(path)) return path.map(String).filter((s) => s !== '');
  if (typeof path === 'string' && path.trim()) return path.trim().split('/').filter((s) => s !== '');
  return [];
}

// ── shaping ─────────────────────────────────────────────────────────────────

/** Bound a value for the model: an array is sampled, a small value is shown
 *  whole, a big one is summarised; the result is always valid JSON. */
function shape(value, args, source, defaults) {
  const budget = budgetFor(args.maxChars, defaults.maxChars);
  let out;
  if (Array.isArray(value)) out = shapeArray(value, args, budget, defaults);
  else if (typeof value === 'string') out = shapeString(value, budget);
  else if (value !== null && typeof value === 'object') out = shapeObject(value, budget);
  else out = { type: value === null ? 'null' : typeof value, value };

  const ref = sourceRef(source);
  if (ref) out.ref = ref;
  return out;
}

function shapeArray(list, args, budget, defaults) {
  const head = toCount(args.head);
  const sampled = head == null;
  const want = head ?? toCount(args.sample) ?? defaults.sample;
  const picked = sampled ? sampleRows(list, want, args.seed) : list.slice(0, want);
  const kept = budgetRows(picked, budget);
  const out = {
    type: 'array',
    length: list.length,
    rows: kept,
    rowsShown: kept.length,
    order: sampled ? 'sample' : 'head',
  };
  if (kept.length < list.length) {
    out.truncated = true;
    out.note =
      `${kept.length} of ${list.length} rows shown (${out.order}) — raise sample/maxChars, ` +
      'or pass a ref as a tree tool\'s input for the whole array';
  }
  return out;
}

function shapeObject(obj, budget) {
  const keys = Object.keys(obj);
  if (jsonSize(obj) <= budget) return { type: 'object', size: keys.length, value: obj };
  const shown = [];
  let used = 2;
  for (const key of keys) {
    const cost = jsonSize(obj[key]) + key.length + 4;
    if (shown.length > 0 && used + cost > budget) break;
    shown.push(key);
    used += cost;
  }
  return {
    type: 'object',
    size: keys.length,
    keys: shown,
    keysShown: shown.length,
    truncated: true,
    note: `${shown.length} of ${keys.length} keys listed — raise maxChars to see the values`,
  };
}

function shapeString(str, budget) {
  if (str.length <= budget) return { type: 'string', length: str.length, value: str };
  return {
    type: 'string',
    length: str.length,
    value: str.slice(0, budget),
    truncated: true,
    note: `first ${budget} of ${str.length} chars shown — raise maxChars for more`,
  };
}

/** Add whole rows while they fit, but always keep at least one. */
function budgetRows(rows, budget) {
  const kept = [];
  let size = 2;
  for (const row of rows) {
    const cost = jsonSize(row);
    if (kept.length > 0 && size + cost + 1 > budget) break;
    kept.push(row);
    size += cost + 1;
  }
  return kept;
}

/** A uniform random sample of `n` rows (reservoir), or the whole list when
 *  `n` covers it. `seed` makes the draw reproducible; without one it is
 *  random. */
function sampleRows(list, n, seed) {
  const count = Math.min(Math.max(0, Math.trunc(n) || 0), list.length);
  if (count >= list.length) return list.slice();
  if (count === 0) return [];
  const rand = seed == null ? Math.random : mulberry32(seed >>> 0);
  const out = list.slice(0, count);
  for (let i = count; i < list.length; i++) {
    const j = Math.floor(rand() * (i + 1));
    if (j < count) out[j] = list[i];
  }
  return out;
}

/** Small deterministic PRNG, so a seeded sample is reproducible. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function describe(value) {
  if (Array.isArray(value)) return { type: 'array', size: value.length };
  if (value === null || value === undefined) return { type: value === null ? 'null' : 'undefined' };
  if (typeof value === 'string') return { type: 'string', size: value.length };
  if (typeof value === 'object') return { type: 'object', size: Object.keys(value).length };
  return { type: typeof value };
}

function jsonSize(value) {
  try {
    return (JSON.stringify(value) ?? 'null').length;
  } catch {
    return 1;
  }
}

function toCount(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : null;
}

function budgetFor(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** The handle a value can be addressed by: the ref it was read through, or the
 *  live slot's `ref://<name>.<seq>` when the slot has a write row. */
function sourceRef({ ref, name, seq } = {}) {
  if (typeof ref === 'string' && ref) return ref;
  if (typeof name === 'string' && Number.isFinite(seq)) return refFor(name, seq);
  return null;
}

function refFor(name, seq) {
  return `ref://${name}.${seq}`;
}

function inspectParameters({ sample, maxChars }) {
  return {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: `A live memory slot to read (the m.<name> the tree sees). Use "*" to list every slot in scope.`,
      },
      ref: {
        type: 'string',
        description: 'A ref://<name>.<seq>[/path] handle to a run-log value (as handed to you in a truncated tool result).',
      },
      path: {
        type: 'string',
        description: "A '/'-separated path to walk into the value (object keys and array indices), e.g. 'list/0/email'.",
      },
      sample: {
        type: 'integer',
        description: `How many rows to sample at random from an array (default ${sample}).`,
      },
      head: {
        type: 'integer',
        description: 'Take the first N rows instead of a random sample.',
      },
      seed: {
        type: 'integer',
        description: 'Seed the random sample for a reproducible draw.',
      },
      maxChars: {
        type: 'integer',
        description: `Bound on the returned JSON, in characters (default ${maxChars}).`,
      },
      list: {
        type: 'boolean',
        description: 'List every memory slot visible from here instead of reading one.',
      },
    },
    required: [],
  };
}
