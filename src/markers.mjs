// Marker factories: when(), update(), goback(), goto(), max(), calls(),
// parameters(), disableAuto(), onEmit(), onHuman(), toolBefore(), toolAfter(),
// memory().
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

const MEMORY = Symbol('grandma-kat/memory');

/**
 * Marker for From('name', memory(fn)) — the slots to seed into the imported
 * tree's own scope when it is entered. `fn(m)` returns an object of slot
 * writes: memory(m => ({ input: m.item })), or memory(m => ({ ...m })) to
 * snapshot the chain into the import's scope. Positioned like when().
 */
export function memory(fn) {
  if (typeof fn !== 'function') {
    throw new TypeError('memory(fn) expects a function returning the slots to seed, e.g. memory(m => ({ input: m.item }))');
  }
  return Object.freeze({ [MEMORY]: true, fn });
}

export const isMemory = (v) => v != null && v[MEMORY] === true;

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

const DESCRIPTION = Symbol('grandma-kat/description');

/**
 * Marker for Needs('input', description('...')) — a caller-facing note on one
 * required input slot. It attaches to the name immediately before it. A host
 * that turns the tree into a tool (e.g. a function-calling schema) can surface
 * the text as that parameter's description; hosts that ignore it lose nothing.
 */
export function description(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new TypeError('description(text) expects a non-empty string');
  }
  return Object.freeze({ [DESCRIPTION]: true, text });
}

export const isDescription = (v) => v != null && v[DESCRIPTION] === true;

const OPTIONAL = Symbol('grandma-kat/optional');

/**
 * Marker for Needs('name', optional()) — declare an input slot that is
 * documented and may be seeded, but is NOT required: knitting without it does
 * not throw, and a host building a tool schema leaves it out of `required`.
 * It attaches to the name before it; combine with description('...') in either
 * order.
 */
export function optional() {
  return Object.freeze({ [OPTIONAL]: true });
}

const VERSION = Symbol('grandma-kat/version');

/**
 * Marker for From('name', version('v1')) — pin the imported tree to a
 * snapshot. Values: 'vN', 'prod', or 'draft'. Unlike an unversioned From(),
 * a versioned one is NOT resolved from the build-time registry: the host
 * resolves `name@version` from disk at run time (see runtime.loadTree), so a
 * name the process never imported still works. Positioned like memory().
 */
export function version(text) {
  if (typeof text !== 'string' || !/^(v[0-9]+|prod|draft)$/.test(text)) {
    throw new TypeError("version(text) expects 'vN', 'prod' or 'draft'");
  }
  return Object.freeze({ [VERSION]: true, text });
}

export const isVersion = (v) => v != null && v[VERSION] === true;

export const isOptional = (v) => v != null && v[OPTIONAL] === true;

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

const DISABLE_AUTO = Symbol('grandma-kat/disableAuto');

/**
 * Marker for `.prompt(disableAuto(), …)` — keep that prompt single-round:
 * tool calls execute and are recorded, but their results are never fed back
 * to the model. The default is the auto tool-execution loop.
 */
export function disableAuto() {
  return Object.freeze({ [DISABLE_AUTO]: true });
}

export const isDisableAuto = (v) => v != null && v[DISABLE_AUTO] === true;

const HOOK_TRIGGER = Symbol('grandma-kat/hookTrigger');

/**
 * Markers for the event a Hook() tree fires on. onEmit() fires once per Emit()
 * the declaring tree (or a descendant) runs, seeded with the emitted value as
 * `input`. onHuman() fires when human input arrives at a Human() pause within
 * that coverage, seeded with the reply. toolBefore() / toolAfter() fire once
 * per tool call executed by a covered prompt, seeded with the call as `call`.
 * A hook is positional (like Register) and runs in the declarer's scope, as if
 * From()'d at its point; hook trees must be pause-free.
 */
export function onEmit() {
  return Object.freeze({ [HOOK_TRIGGER]: true, trigger: 'emit' });
}

export function onHuman() {
  return Object.freeze({ [HOOK_TRIGGER]: true, trigger: 'human' });
}

export function toolBefore() {
  return Object.freeze({ [HOOK_TRIGGER]: true, trigger: 'toolBefore' });
}

export function toolAfter() {
  return Object.freeze({ [HOOK_TRIGGER]: true, trigger: 'toolAfter' });
}

export const isHookTrigger = (v) => v != null && v[HOOK_TRIGGER] === true;
