// Tree factory: chained builder methods accumulate an immutable definition
// (plain data). Execution happens separately, via grandma.knit().

import { isWhen, isGoback, isMax, goback, resolveMax } from './markers.mjs';

const BUILDER = Symbol('grandma-kat/builder');
const registry = new Map();

function makeDef() {
  return { kind: 'tree', name: null, children: [], models: [], tools: [], untils: [], needs: [] };
}

function isBuilder(v) {
  return v != null && v[BUILDER] === true;
}

function unwrap(v) {
  if (isBuilder(v)) return v.def;
  if (v != null && v.kind === 'tree') return v;
  throw new TypeError('expected a Tree definition');
}

// Copy-on-write: each method returns a new builder over a fresh definition,
// so sharing a tree across parents is bulletproof.
function next(def, patch) {
  const d = {
    ...def,
    children: [...def.children],
    models: [...def.models],
    tools: [...def.tools],
    untils: [...def.untils],
    needs: [...def.needs],
  };
  patch(d);
  if (d.name != null) registry.set(d.name, d);
  return makeBuilder(d);
}

function makeBuilder(def) {
  const api = {
    [BUILDER]: true,
    def,

    name(id) {
      assertValidName(id, '.name()');
      return next(def, (d) => { d.name = id; });
    },

    // Accumulative: attach a named subtree.
    branch(...rawArgs) {
      const { gate, args } = takeGate(rawArgs, '.branch()');
      if (args.length !== 1) throw new TypeError('.branch() expects a single tree argument');
      const tree = unwrap(args[0]);
      if (tree.name == null) {
        throw new TypeError('.branch(): child tree must be named (call .name() first)');
      }
      const child = { kind: 'branch', name: tree.name, tree, gate };
      return next(def, (d) => { d.children.push(child); });
    },

    // Accumulative: append a prompt leaf (anonymous or named).
    prompt(...rawArgs) {
      const { gate, args } = takeGate(rawArgs, '.prompt()');
      const name = takeName(args, '.prompt()');
      const value = args.shift();
      if (typeof value !== 'string' && !Array.isArray(value) && typeof value !== 'function') {
        throw new TypeError('.prompt(): value must be a string, message array, or function');
      }
      const options = takeOptions(args, '.prompt()');
      if (args.length !== 0) throw new TypeError('.prompt(): too many arguments');
      const child = { kind: 'prompt', name, prompt: value, gate, options };
      return next(def, (d) => { d.children.push(child); });
    },

    // Accumulative: append a direct tool-call leaf.
    //   .call('toolName', argsFn, options?)
    //   .call('name', 'toolName', argsFn, options?)
    call(...rawArgs) {
      const { gate, args } = takeGate(rawArgs, '.call()');

      // Detect 3-arg form: name, tool, argsFn (all positional args are strings/...).
      // takeGate already consumed the when(), so args are the bare positional
      // args. If args[0] and args[1] are both strings we have the named form.
      let name = null;
      if (args.length >= 3 && typeof args[0] === 'string' && typeof args[1] === 'string') {
        name = args.shift();
        assertValidName(name, '.call()');
      }

      const tool = args.shift();
      if (typeof tool !== 'string' || tool.length === 0) {
        throw new TypeError(".call(): tool name must be a non-empty string, e.g. .call('navigate', m => ({ url }))");
      }
      const argsFn = args.shift();
      if (argsFn === undefined) {
        throw new TypeError('.call(): missing args (function or plain value)');
      }
      const options = takeOptions(args, '.call()');
      if (args.length !== 0) throw new TypeError('.call(): too many arguments');
      const child = { kind: 'call', name, tool, argsFn, gate, options };
      return next(def, (d) => { d.children.push(child); });
    },

    // Accumulative: append a check leaf with a flow (goback) on failure.
    check(...rawArgs) {
      const { gate, args } = takeGate(rawArgs, '.check()');
      const checkFn = args.shift();
      if (typeof checkFn !== 'function') {
        throw new TypeError('.check(): first argument must be the check function');
      }
      let flow = args.shift();
      if (flow === undefined) flow = goback(1);
      if (!isGoback(flow)) {
        throw new TypeError('.check(): flow must be goback(n, max?)');
      }
      const options = takeOptions(args, '.check()');
      if (args.length !== 0) throw new TypeError('.check(): too many arguments');
      const child = {
        kind: 'check',
        name: null,
        check: checkFn,
        flow: { n: flow.n, max: resolveMax(flow.max) },
        gate,
        options,
      };
      return next(def, (d) => { d.children.push(child); });
    },

    // Selective: model rules, last match wins.
    model(...rawArgs) {
      const { gate, args } = takeGate(rawArgs, '.model()');
      if (args.length !== 1 || typeof args[0] !== 'string') {
        throw new TypeError(".model() expects a model name, e.g. .model('cheap')");
      }
      const rule = { cond: gate, value: args[0] };
      return next(def, (d) => { d.models.push(rule); });
    },

    // Selective: tool whitelist rules, last match wins.
    tools(...rawArgs) {
      const { gate, args } = takeGate(rawArgs, '.tools()');
      if (args.length === 0 || args.some((t) => typeof t !== 'string')) {
        throw new TypeError(".tools() expects tool names, e.g. .tools('navigate', 'click')");
      }
      const rule = { cond: gate, value: [...args] };
      return next(def, (d) => { d.tools.push(rule); });
    },

    // Accumulative: declared memory inputs (validation story).
    needs(...names) {
      if (names.length === 0 || names.some((n) => typeof n !== 'string')) {
        throw new TypeError(".needs() expects branch names, e.g. .needs('draft', 'navigate')");
      }
      return next(def, (d) => {
        for (const n of names) if (!d.needs.includes(n)) d.needs.push(n);
      });
    },

    // Selective: loop-until rules, last match wins.
    until(...rawArgs) {
      const { gate, args } = takeGate(rawArgs, '.until()');
      const checkFn = args.shift();
      if (typeof checkFn !== 'function') {
        throw new TypeError('.until(): first argument must be the condition function');
      }
      const maxMarker = args.shift();
      if (maxMarker !== undefined && !isMax(maxMarker)) {
        throw new TypeError('.until(): second argument must be max(count[, errFn])');
      }
      if (args.length !== 0) throw new TypeError('.until(): too many arguments');
      const rule = { cond: gate, check: checkFn, max: resolveMax(maxMarker) };
      return next(def, (d) => { d.untils.push(rule); });
    },
  };
  return api;
}

// --- argument parsing helpers ---

const valueLike = (v) =>
  typeof v === 'function' || typeof v === 'string' || Array.isArray(v);

// when() may appear in the first or second argument position. A bare
// function in the condition slot is rejected with a "did you mean when()?"
// error — the mistake LLM authors will make.
function takeGate(rawArgs, method) {
  const args = [...rawArgs];
  const whenIndex = args.findIndex(isWhen);
  if (whenIndex > 1) {
    throw new TypeError(`${method}: when() must be the first or second argument`);
  }
  if (whenIndex === -1 && args.length > 1 && typeof args[0] === 'function' && valueLike(args[1])) {
    throw new TypeError(`${method}: bare function in condition slot — did you mean when()?`);
  }
  if (whenIndex === -1) return { gate: null, args };
  const [marker] = args.splice(whenIndex, 1);
  return { gate: marker.cond, args };
}

// A leading string is a name only if another value-ish argument follows it
// (so `.prompt('just a static string')` is a value, not a name).
function takeName(args, method) {
  if (typeof args[0] !== 'string') return null;
  if (args.length > 1 && valueLike(args[1])) {
    const name = args.shift();
    assertValidName(name, method);
    return name;
  }
  return null;
}

function assertValidName(name, method) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new TypeError(`${method}: name must be a non-empty string`);
  }
  if (name.includes('#')) {
    throw new TypeError(`${method}: '#' is reserved in names (used by auto-naming)`);
  }
}

function takeOptions(args, method) {
  if (args.length === 0) return {};
  const opts = args[args.length - 1];
  if (typeof opts !== 'object' || opts === null || Array.isArray(opts) || typeof opts === 'function') {
    return {};
  }
  args.pop();
  const allowed = new Set(['tools', 'maxRounds']);
  for (const k of Object.keys(opts)) {
    if (!allowed.has(k)) throw new TypeError(`${method}: unknown option '${k}'`);
  }
  if (opts.tools !== undefined && (!Array.isArray(opts.tools) || opts.tools.some((t) => typeof t !== 'string'))) {
    throw new TypeError(`${method}: options.tools must be an array of strings`);
  }
  if (opts.maxRounds !== undefined && (!Number.isInteger(opts.maxRounds) || opts.maxRounds < 1)) {
    throw new TypeError(`${method}: options.maxRounds must be a positive integer`);
  }
  return opts;
}

export const Tree = {
  name(id) {
    return makeBuilder(makeDef()).name(id);
  },
  // Retrieve a registered tree by name (for reuse).
  from(id) {
    const def = registry.get(id);
    if (!def) throw new Error(`no tree registered under name '${id}'`);
    return makeBuilder(def);
  },
  has(id) {
    return registry.has(id);
  },
};

export { isBuilder, unwrap };
