// The canonical tree IR: record builders, field parsers, and the element
// surface — the arguments of Tree(...):
//
//   Tree(
//     Name("call_outcome"), Model("strong"),
//     Prompt("response", textFn, when(cond), max(6)),
//     Register("note_phone", "…", body, calls("contacts__get_contact")),
//     Branch(when(cond), subtree),
//     Until(() => false, max(100000)),
//   )
//
// Markers sit anywhere among an element's arguments; when(cond) is always
// explicit. Field parsers take a label so build errors name the element that
// was written ('Prompt(): …').

import {
  isWhen, isUpdate, isGoback, isGoto, isMax, isCalls, isParameters,
  isDisableAuto, isToolHookBefore, isToolHookAfter, goback, resolveMax,
} from './markers.mjs';

// --- tree defs ------------------------------------------------------------

export function unwrap(v) {
  if (v != null && v.kind === 'tree') return v;
  throw new TypeError('expected a Tree definition');
}

// --- shared argument helpers ----------------------------------------------

export const valueLike = (v) =>
  typeof v === 'function' || typeof v === 'string' || Array.isArray(v);

export function assertValidName(name, label) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new TypeError(`${label}: name must be a non-empty string`);
  }
  if (name.includes('#')) {
    throw new TypeError(`${label}: '#' is reserved in names (used by auto-naming)`);
  }
}

// A leading string is a name only if another value-ish argument follows it
// (so `Prompt('just a static string')` is a value, not a name).
export function takeName(args, label) {
  if (typeof args[0] !== 'string') return null;
  if (args.length > 1 && valueLike(args[1])) {
    const name = args.shift();
    assertValidName(name, label);
    return name;
  }
  return null;
}

export function takeOptions(args, label, extraAllowed = []) {
  if (args.length === 0) return {};
  const opts = args[args.length - 1];
  if (typeof opts !== 'object' || opts === null || Array.isArray(opts) || typeof opts === 'function') {
    return {};
  }
  args.pop();
  const allowed = new Set(['tools', ...extraAllowed]);
  for (const k of Object.keys(opts)) {
    if (!allowed.has(k)) throw new TypeError(`${label}: unknown option '${k}'`);
  }
  if (opts.tools !== undefined && (!Array.isArray(opts.tools) || opts.tools.some((t) => typeof t !== 'string'))) {
    throw new TypeError(`${label}: options.tools must be an array of strings`);
  }
  if (opts.parameters !== undefined && (typeof opts.parameters !== 'object' || opts.parameters === null || Array.isArray(opts.parameters))) {
    throw new TypeError(`${label}: options.parameters must be a JSON-schema object`);
  }
  return opts;
}

// when() may appear anywhere among the arguments. A bare function in the
// condition slot is rejected with a "did you mean when()?" error — the
// mistake LLM authors will make.
export function takeGate(rawArgs, label) {
  const args = [...rawArgs];
  const whenIndex = args.findIndex(isWhen);
  if (whenIndex === -1 && args.length > 1 && typeof args[0] === 'function' && valueLike(args[1])) {
    throw new TypeError(`${label}: bare function in condition slot — did you mean when()?`);
  }
  if (whenIndex === -1) return { gate: null, args };
  const [marker] = args.splice(whenIndex, 1);
  if (args.some(isWhen)) throw new TypeError(`${label}: when() may appear only once`);
  return { gate: marker.cond, args };
}

// Splice the auto-loop markers (disableAuto(), max(), toolHookBefore/After())
// out of an argument list, wherever they sit.
export function takeAuto(args, label) {
  const auto = {};
  const before = [];
  const after = [];
  let sawDisable = false;
  let sawMax = false;
  for (let i = 0; i < args.length; ) {
    const a = args[i];
    if (isDisableAuto(a)) {
      if (sawDisable) throw new TypeError(`${label}: duplicate disableAuto()`);
      sawDisable = true;
      auto.disabled = true;
      args.splice(i, 1);
      continue;
    }
    if (isToolHookBefore(a)) { before.push(a); args.splice(i, 1); continue; }
    if (isToolHookAfter(a)) { after.push(a); args.splice(i, 1); continue; }
    if (isMax(a)) {
      if (sawMax) throw new TypeError(`${label}: duplicate max()`);
      sawMax = true;
      auto.max = resolveMax(a);
      args.splice(i, 1);
      continue;
    }
    i++;
  }
  if (before.length || after.length) {
    auto.hooks = {};
    if (before.length) auto.hooks.before = before.map((h) => ({ fn: h.fn, gate: h.gate }));
    if (after.length) auto.hooks.after = after.map((h) => ({ fn: h.fn, gate: h.gate }));
  }
  return auto;
}

// --- field parsers --------------------------------------------------------
//
// One parser per chunk kind: marker splicing, argument-shape validation, and
// the defaults. Every caller is an element constructor.

export function promptFields(rawArgs, label) {
  const { gate, args } = takeGate(rawArgs, label);
  const auto = takeAuto(args, label);
  const name = takeName(args, label);
  const value = args.shift();
  if (typeof value !== 'string' && !Array.isArray(value) && typeof value !== 'function') {
    throw new TypeError(`${label}: value must be a string, message array, or function`);
  }
  const options = takeOptions(args, label);
  if (args.length !== 0) throw new TypeError(`${label}: too many arguments`);
  return { name, value, gate, auto, options };
}

export function branchFields(rawArgs, label) {
  const { gate, args } = takeGate(rawArgs, label);
  if (args.length !== 1) throw new TypeError(`${label} expects a single tree argument`);
  const tree = unwrap(args[0]);
  return { name: tree.name, tree, gate };
}

export function callFields(rawArgs, label) {
  const { gate, args } = takeGate(rawArgs, label);
  // If the first two positional args are both strings, the first is the
  // call's name (the 3-arg form); otherwise the tool name comes first.
  let name = null;
  if (args.length >= 3 && typeof args[0] === 'string' && typeof args[1] === 'string') {
    name = args.shift();
    assertValidName(name, label);
  }
  const tool = args.shift();
  if (typeof tool !== 'string' || tool.length === 0) {
    throw new TypeError(`${label}: tool name must be a non-empty string, e.g. .call('navigate', m => ({ url }))`);
  }
  const argsFn = args.shift();
  if (argsFn === undefined) {
    throw new TypeError(`${label}: missing args (function or plain value)`);
  }
  const options = takeOptions(args, label);
  if (args.length !== 0) throw new TypeError(`${label}: too many arguments`);
  return { name, tool, argsFn, gate, options };
}

export function registerFields(rawArgs, label) {
  const { gate, args } = takeGate(rawArgs, label);
  if (gate != null) {
    throw new TypeError(`${label}: registers are declarations — remove when() and let the tool itself decide`);
  }
  const name = args.shift();
  if (typeof name !== 'string' || name.length === 0) {
    throw new TypeError(`${label}: first argument must be the tool name (string), e.g. .register("lookup", "Find a person", (m, args) => …)`);
  }
  assertValidName(name, label);
  const description = args.shift();
  if (typeof description !== 'string' || description.length === 0) {
    throw new TypeError(`${label}: second argument must be a non-empty description (string) — the model reads it`);
  }
  const fn = args.shift();
  if (typeof fn !== 'function') {
    throw new TypeError(`${label}: third argument must be the tool function, e.g. (m, args) => result`);
  }
  let callsList = null;
  let schema = null;
  for (const arg of args) {
    if (isCalls(arg)) {
      if (callsList) throw new TypeError(`${label}: calls(...) may only appear once`);
      callsList = arg.names;
    } else if (isParameters(arg)) {
      if (schema) throw new TypeError(`${label}: parameters(...) may only appear once`);
      schema = arg.schema;
    } else {
      throw new TypeError(`${label}: unexpected argument — the options are calls(...) and parameters(...)`);
    }
  }
  return {
    name,
    description,
    parameters: schema ?? { type: 'object', properties: {} },
    ...(callsList ? { calls: callsList } : {}),
    fn,
  };
}

export function checkFields(rawArgs, label) {
  const { gate, args } = takeGate(rawArgs, label);
  const checkFn = args.shift();
  if (typeof checkFn !== 'function') {
    throw new TypeError(`${label}: first argument must be the check function`);
  }
  let flow = args.shift();
  if (flow === undefined) flow = goback(1);
  if (!isGoback(flow) && !isGoto(flow)) {
    throw new TypeError(`${label}: flow must be goback(n, max?) or goto(target, max?)`);
  }
  const options = takeOptions(args, label);
  if (args.length !== 0) throw new TypeError(`${label}: too many arguments`);
  const flowDef = isGoback(flow)
    ? { type: 'goback', n: flow.n, max: resolveMax(flow.max) }
    : { type: 'goto', target: flow.target, max: resolveMax(flow.max) };
  return { check: checkFn, flow: flowDef, gate, options };
}

export function memoryFields(rawArgs, label) {
  const { gate, args } = takeGate(rawArgs, label);
  const updateIndex = args.findIndex(isUpdate);
  const updating = updateIndex !== -1;
  if (updating) args.splice(updateIndex, 1);
  const name = args.shift();
  if (typeof name !== 'string' || name.length === 0) {
    throw new TypeError(
      updating
        ? `${label.replace('()', '(update(), …)')}: the slot name (string) must follow update(), e.g. .memory(update(), 'tried', fn)`
        : `${label}: first argument must be the slot name (string), e.g. .memory('tried', (m, cur) => [...cur ?? [], m.prev[0]])`,
    );
  }
  assertValidName(name, label);
  const fn = args.shift();
  if (typeof fn !== 'function') {
    throw new TypeError(
      updating
        ? `${label.replace('()', '(update(), name, fn)')}: fn must be a function`
        : `${label}: second argument must be a function`,
    );
  }
  if (args.length !== 0) throw new TypeError(`${label}: too many arguments`);
  return { updating, name, fn, gate };
}

export function memoryUpdateFields(rawArgs, label) {
  const { gate, args } = takeGate(rawArgs, label);
  const name = args.shift();
  if (typeof name !== 'string' || name.length === 0) {
    throw new TypeError(`${label}: first argument must be the slot name (string), e.g. .memoryUpdate('tried', (m, cur) => [...cur, m.prev[0]])`);
  }
  assertValidName(name, label);
  const fn = args.shift();
  if (typeof fn !== 'function') {
    throw new TypeError(`${label}: second argument must be a function`);
  }
  if (args.length !== 0) throw new TypeError(`${label}: too many arguments`);
  return { name, fn, gate };
}

export function returnFields(rawArgs, label) {
  const { gate, args } = takeGate(rawArgs, label);
  const fn = args.shift();
  if (typeof fn !== 'function') {
    throw new TypeError(`${label}: first argument must be a function, e.g. .return(m => "done")`);
  }
  if (args.length !== 0) throw new TypeError(`${label}: too many arguments`);
  return { fn, gate };
}

export function mapFields(rawArgs, label) {
  const { gate, args } = takeGate(rawArgs, label);
  const name = args.shift();
  if (typeof name !== 'string' || name.length === 0) {
    throw new TypeError(`${label}: first argument must be the collection name (string), e.g. .map('rated', m => arr, tree)`);
  }
  assertValidName(name, label);
  const arrayFn = args.shift();
  if (typeof arrayFn !== 'function') {
    throw new TypeError(`${label}: second argument must be a function returning an array`);
  }
  const tree = unwrap(args.shift());
  if (args.length !== 0) throw new TypeError(`${label}: too many arguments`);
  return { name, arrayFn, tree, gate };
}

export function humanFields(rawArgs, label) {
  const { gate, args } = takeGate(rawArgs, label);
  const name = args.shift();
  if (typeof name !== 'string' || name.length === 0) {
    throw new TypeError(`${label}: first argument must be the slot name (string), e.g. .human('approve')`);
  }
  assertValidName(name, label);
  const contextFn = args.shift() ?? null;
  if (contextFn !== null && typeof contextFn !== 'function') {
    throw new TypeError(`${label}: second argument (contextFn) must be a function if provided`);
  }
  if (args.length !== 0) throw new TypeError(`${label}: too many arguments`);
  return { name, contextFn, gate };
}

export function emitFields(rawArgs, label) {
  const { gate, args } = takeGate(rawArgs, label);
  const fn = args.shift();
  if (typeof fn !== 'function') {
    throw new TypeError(`${label}: first argument must be a function, e.g. .emit(m => ({ text: "hi" }))`);
  }
  if (args.length !== 0) throw new TypeError(`${label}: too many arguments`);
  return { fn, gate };
}

export function untilFields(rawArgs, label) {
  const { gate, args } = takeGate(rawArgs, label);
  let jumpTarget = null;
  let jumpType = null;
  // Optional first arg: goto() or goback(n) marker
  if (args.length > 1 && (isGoto(args[0]) || isGoback(args[0]))) {
    const marker = args.shift();
    if (isGoto(marker)) {
      jumpType = 'goto';
      jumpTarget = marker.target;
    } else {
      jumpType = 'goback';
      jumpTarget = marker.n;
    }
  }
  const checkFn = args.shift();
  if (typeof checkFn !== 'function') {
    throw new TypeError(`${label}: first argument must be the condition function (or a goto/goback marker followed by the condition)`);
  }
  const maxMarker = args.shift();
  if (maxMarker !== undefined && !isMax(maxMarker)) {
    throw new TypeError(`${label}: second argument must be max(count[, errFn])`);
  }
  if (args.length !== 0) throw new TypeError(`${label}: too many arguments`);
  return { check: checkFn, max: resolveMax(maxMarker), jumpType, jumpTarget, gate };
}

// Selective rules (last match wins) and declared inputs.
export function modelRule(rawArgs, label) {
  const { gate, args } = takeGate(rawArgs, label);
  if (args.length !== 1 || typeof args[0] !== 'string') {
    throw new TypeError(`${label} expects a model name, e.g. .model('cheap')`);
  }
  return { cond: gate, value: args[0] };
}

export function toolsRule(rawArgs, label) {
  const { gate, args } = takeGate(rawArgs, label);
  if (args.length === 0 || args.some((t) => typeof t !== 'string')) {
    throw new TypeError(`${label} expects tool names, e.g. .tools('navigate', 'click')`);
  }
  return { cond: gate, value: [...args] };
}

export function needsList(names, label) {
  if (names.length === 0 || names.some((n) => typeof n !== 'string')) {
    throw new TypeError(`${label} expects branch names, e.g. .needs('draft', 'navigate')`);
  }
  return [...names];
}

// --- record builders ------------------------------------------------------
//
// The shapes knit() executes. A def that never registers must not carry the
// key (definition ids and host session hashes are computed over the def and
// must not churn), and a plain prompt must not carry `auto`.

export function promptRecord({ name = null, value, gate = null, auto = null, options = {} }) {
  const child = { kind: 'prompt', name, prompt: value, gate, options };
  if (auto && Object.keys(auto).length) child.auto = auto;
  return child;
}

export const branchRecord = ({ name = null, tree, gate = null }) => ({ kind: 'branch', name, tree, gate });

export const callRecord = ({ name = null, tool, argsFn, gate = null, options = {} }) => ({ kind: 'call', name, tool, argsFn, gate, options });

export const checkRecord = ({ check, flow, gate = null, options = {} }) => ({ kind: 'check', name: null, check, flow, gate, options });

export const memoryRecord = ({ updating, name, fn, gate = null }) => ({ kind: updating ? 'memoryUpdate' : 'memory', name, fn, gate });

export const memoryUpdateRecord = ({ name, fn, gate = null }) => ({ kind: 'memoryUpdate', name, fn, gate });

export const returnRecord = ({ fn, gate = null }) => ({ kind: 'return', name: null, fn, gate });

export const mapRecord = ({ name, arrayFn, tree, gate = null }) => ({ kind: 'map', name, arrayFn, tree, gate });

export const humanRecord = ({ name, contextFn = null, gate = null }) => ({ kind: 'human', name, contextFn, gate });

export const emitRecord = ({ fn, gate = null }) => ({ kind: 'emit', name: null, fn, gate });

export const untilRecord = ({ check, max, jumpType = null, jumpTarget = null, gate = null }) =>
  ({ kind: 'until', name: null, check, max, jumpType, jumpTarget, gate });

// --- the element surface --------------------------------------------------

const ELEMENT = Symbol('grandma-kat/element');

const element = (kind, fields) => Object.freeze({ [ELEMENT]: true, element: kind, ...fields });

export const isElement = (v) => v != null && v[ELEMENT] === true;

export const Prompt = (...rawArgs) => element('prompt', { record: promptRecord(promptFields(rawArgs, 'Prompt()')) });
export const Branch = (...rawArgs) => element('branch', { record: branchRecord(branchFields(rawArgs, 'Branch()')) });
export const Call = (...rawArgs) => element('call', { record: callRecord(callFields(rawArgs, 'Call()')) });
export const Register = (...rawArgs) => element('register', { entry: registerFields(rawArgs, 'Register()') });
export const Check = (...rawArgs) => element('check', { record: checkRecord(checkFields(rawArgs, 'Check()')) });
export const Memory = (...rawArgs) => element('memory', { record: memoryRecord(memoryFields(rawArgs, 'Memory()')) });
export const Return = (...rawArgs) => element('return', { record: returnRecord(returnFields(rawArgs, 'Return()')) });
export const Map = (...rawArgs) => element('map', { record: mapRecord(mapFields(rawArgs, 'Map()')) });
export const Human = (...rawArgs) => element('human', { record: humanRecord(humanFields(rawArgs, 'Human()')) });
export const Emit = (...rawArgs) => element('emit', { record: emitRecord(emitFields(rawArgs, 'Emit()')) });
export const Until = (...rawArgs) => element('until', { record: untilRecord(untilFields(rawArgs, 'Until()')) });

export const Name = (value) => {
  assertValidName(value, 'Name()');
  return element('name', { value });
};
export const Model = (...rawArgs) => {
  const rule = modelRule(rawArgs, 'Model()');
  return element('model', { gate: rule.cond, value: rule.value });
};
export const Tools = (...rawArgs) => {
  const rule = toolsRule(rawArgs, 'Tools()');
  return element('tools', { gate: rule.cond, names: rule.value });
};
export const Needs = (...names) => element('needs', { names: needsList(names, 'Needs()') });
