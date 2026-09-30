// Marker factories: when(), update(), goback(), goto(), max(), calls(),
// parameters().
// Each marker is a distinct type so the builder can validate argument slots
// at build time (e.g. reject a bare function in a condition slot).

const WHEN = Symbol('grandma-kat/when');
const UPDATE = Symbol('grandma-kat/update');
const GOBACK = Symbol('grandma-kat/goback');
const GOTO = Symbol('grandma-kat/goto');
const MAX = Symbol('grandma-kat/max');

export const DEFAULT_MAX = 3;

export function when(cond) {
  if (typeof cond !== 'function') {
    throw new TypeError('when(cond) expects a function');
  }
  return Object.freeze({ [WHEN]: true, cond });
}

export const isWhen = (v) => v != null && v[WHEN] === true;

/**
 * Marker for .memory(update(), name, fn) — the .memoryUpdate() leaf in
 * .memory() clothing. Positioned like when(): first or second argument.
 */
export function update() {
  return Object.freeze({ [UPDATE]: true });
}

export const isUpdate = (v) => v != null && v[UPDATE] === true;

export function goback(n, maxMarker) {
  if (!Number.isInteger(n) || n < 1) {
    throw new TypeError('goback(n) expects a positive integer');
  }
  if (maxMarker !== undefined && !isMax(maxMarker)) {
    throw new TypeError('goback(n, max): second argument must be max(count[, errFn])');
  }
  return Object.freeze({ [GOBACK]: true, n, max: maxMarker ?? null });
}

export const isGoback = (v) => v != null && v[GOBACK] === true;

export function goto(target, maxMarker) {
  if (typeof target !== 'string' || target.length === 0) {
    throw new TypeError('goto(target) expects a non-empty string (child name)');
  }
  if (maxMarker !== undefined && !isMax(maxMarker)) {
    throw new TypeError('goto(target, max): second argument must be max(count[, errFn])');
  }
  return Object.freeze({ [GOTO]: true, target, max: maxMarker ?? null });
}

export const isGoto = (v) => v != null && v[GOTO] === true;

export function max(count, errFn) {
  if (!Number.isInteger(count) || count < 1) {
    throw new TypeError('max(count) expects a positive integer');
  }
  if (errFn !== undefined && typeof errFn !== 'function') {
    throw new TypeError('max(count, errFn): errFn must be a function');
  }
  return Object.freeze({ [MAX]: true, count, errFn: errFn ?? null });
}

export const isMax = (v) => v != null && v[MAX] === true;

// Resolve a max marker (or absence) to { count, errFn }.
export function resolveMax(marker) {
  if (marker == null) return { count: DEFAULT_MAX, errFn: null };
  return { count: marker.count, errFn: marker.errFn };
}

const CALLS = Symbol('grandma-kat/calls');
const PARAMETERS = Symbol('grandma-kat/parameters');

/**
 * Marker for `.register(name, description, fn, calls("sql_query", ...))` —
 * the host tools the register body may invoke, handed to the fn as
 * `tools.<name>(args)`. Resolved once, on the register's home path (its
 * declaring scope chain's registers, then the runtime's tools); only
 * function-kind tools qualify.
 */
export function calls(...names) {
  const list = names.flat();
  if (list.length === 0 || list.some((n) => typeof n !== 'string' || n.length === 0)) {
    throw new TypeError('calls(...names) expects one or more non-empty tool names');
  }
  return Object.freeze({ [CALLS]: true, names: list });
}

export const isCalls = (v) => v != null && v[CALLS] === true;

/**
 * Marker for `.register(name, description, fn, parameters(schema))` — the
 * JSON schema the model sees for this inline tool.
 */
export function parameters(schema) {
  if (schema == null || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new TypeError('parameters(schema) expects a JSON-schema object');
  }
  return Object.freeze({ [PARAMETERS]: true, schema });
}

export const isParameters = (v) => v != null && v[PARAMETERS] === true;
