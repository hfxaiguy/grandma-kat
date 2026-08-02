// Marker factories: when(), goback(), goto(), max().
// Each marker is a distinct type so the builder can validate argument slots
// at build time (e.g. reject a bare function in a condition slot).

const WHEN = Symbol('grandma-kat/when');
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
