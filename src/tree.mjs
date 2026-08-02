// Tree factory: chained builder methods accumulate an immutable definition
// (plain data). Execution happens separately, via grandma.knit().

import { isWhen, isGoback, isGoto, isMax, goback, goto, resolveMax } from './markers.mjs';

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

    // Accumulative: append a check leaf with a flow (goback or goto) on failure.
    check(...rawArgs) {
      const { gate, args } = takeGate(rawArgs, '.check()');
      const checkFn = args.shift();
      if (typeof checkFn !== 'function') {
        throw new TypeError('.check(): first argument must be the check function');
      }
      let flow = args.shift();
      if (flow === undefined) flow = goback(1);
      if (!isGoback(flow) && !isGoto(flow)) {
        throw new TypeError('.check(): flow must be goback(n, max?) or goto(target, max?)');
      }
      const options = takeOptions(args, '.check()');
      if (args.length !== 0) throw new TypeError('.check(): too many arguments');
      const flowDef = isGoback(flow)
        ? { type: 'goback', n: flow.n, max: resolveMax(flow.max) }
        : { type: 'goto', target: flow.target, max: resolveMax(flow.max) };
      const child = {
        kind: 'check',
        name: null,
        check: checkFn,
        flow: flowDef,
        gate,
        options,
      };
      return next(def, (d) => { d.children.push(child); });
    },

    // Accumulative: append a memory-write leaf.
    //   .memory(name, fn)               — fn(m) or fn(m, currentValue) → stored value, appears in m.prev
    //   .memory(when(cond), name, fn)
    memory(...rawArgs) {
      const { gate, args } = takeGate(rawArgs, '.memory()');
      const name = args.shift();
      if (typeof name !== 'string' || name.length === 0) {
        throw new TypeError(".memory(): first argument must be the slot name (string), e.g. .memory('tried', (m, cur) => [...cur ?? [], m.prev[0]])");
      }
      assertValidName(name, '.memory()');
      const fn = args.shift();
      if (typeof fn !== 'function') {
        throw new TypeError('.memory(): second argument must be a function');
      }
      if (args.length !== 0) throw new TypeError('.memory(): too many arguments');
      const child = { kind: 'memory', name, fn, gate };
      return next(def, (d) => { d.children.push(child); });
    },

    // Accumulative: append a memory-update leaf. The slot must already exist
    // in the scope chain (current tree or an ancestor). Errors at runtime if
    // the slot is missing.
    //   .memoryUpdate(name, fn)               — fn(m, currentValue) → stored value
    //   .memoryUpdate(when(cond), name, fn)
    memoryUpdate(...rawArgs) {
      const { gate, args } = takeGate(rawArgs, '.memoryUpdate()');
      const name = args.shift();
      if (typeof name !== 'string' || name.length === 0) {
        throw new TypeError(".memoryUpdate(): first argument must be the slot name (string), e.g. .memoryUpdate('tried', (m, cur) => [...cur, m.prev[0]])");
      }
      assertValidName(name, '.memoryUpdate()');
      const fn = args.shift();
      if (typeof fn !== 'function') {
        throw new TypeError('.memoryUpdate(): second argument must be a function');
      }
      if (args.length !== 0) throw new TypeError('.memoryUpdate(): too many arguments');
      const child = { kind: 'memoryUpdate', name, fn, gate };
      return next(def, (d) => { d.children.push(child); });
    },

    // Accumulative: append a return leaf (early exit).
    //   .return(fn)              — fn(m) → value; tree stops if value != null
    //   .return(when(cond), fn)  — gated
    // If fn returns undefined/null, the tree continues to the next child.
    // If fn returns a value, remaining children are skipped and the tree
    // exports that value.
    return(...rawArgs) {
      const { gate, args } = takeGate(rawArgs, '.return()');
      const fn = args.shift();
      if (typeof fn !== 'function') {
        throw new TypeError('.return(): first argument must be a function, e.g. .return(m => "done")');
      }
      if (args.length !== 0) throw new TypeError('.return(): too many arguments');
      const child = { kind: 'return', name: null, fn, gate };
      return next(def, (d) => { d.children.push(child); });
    },

    // Accumulative: append a map leaf (runs a subtree per array element).
    //   .map(name, arrayFn, tree)               — collect results under name
    //   .map(when(cond), name, arrayFn, tree)
    // Each element gets `m.item` injected. Results collected into an array
    // in the parent scope under `name`. Empty array → no invocations.
    map(...rawArgs) {
      const { gate, args } = takeGate(rawArgs, '.map()');
      const name = args.shift();
      if (typeof name !== 'string' || name.length === 0) {
        throw new TypeError(".map(): first argument must be the collection name (string), e.g. .map('rated', m => arr, tree)");
      }
      assertValidName(name, '.map()');
      const arrayFn = args.shift();
      if (typeof arrayFn !== 'function') {
        throw new TypeError('.map(): second argument must be a function returning an array');
      }
      const tree = unwrap(args.shift());
      if (tree.name == null) {
        throw new TypeError('.map(): subtree must be named (call .name() first)');
      }
      if (args.length !== 0) throw new TypeError('.map(): too many arguments');
      const child = { kind: 'map', name, arrayFn, tree, gate };
      return next(def, (d) => { d.children.push(child); });
    },

    // Accumulative: append a human-in-the-loop leaf (pauses execution).
    //   .human(name)                    — pauses, stores human input in m.branch.name
    //   .human(name, contextFn)         — contextFn(m) → data shown to the human
    //   .human(when(cond), name, ...)   — gated
    human(...rawArgs) {
      const { gate, args } = takeGate(rawArgs, '.human()');
      const name = args.shift();
      if (typeof name !== 'string' || name.length === 0) {
        throw new TypeError(".human(): first argument must be the slot name (string), e.g. .human('approve')");
      }
      assertValidName(name, '.human()');
      const contextFn = args.shift() ?? null;
      if (contextFn !== null && typeof contextFn !== 'function') {
        throw new TypeError('.human(): second argument (contextFn) must be a function if provided');
      }
      if (args.length !== 0) throw new TypeError('.human(): too many arguments');
      const child = { kind: 'human', name, contextFn, gate };
      return next(def, (d) => { d.children.push(child); });
    },

    // Accumulative: append an emit leaf (non-blocking output).
    //   .emit(fn)              — fn(m) → value; calls runtime.onEmit(value), continues
    //   .emit(when(cond), fn)  — gated
    emit(...rawArgs) {
      const { gate, args } = takeGate(rawArgs, '.emit()');
      const fn = args.shift();
      if (typeof fn !== 'function') {
        throw new TypeError('.emit(): first argument must be a function, e.g. .emit(m => ({ text: "hi" }))');
      }
      if (args.length !== 0) throw new TypeError('.emit(): too many arguments');
      const child = { kind: 'emit', name: null, fn, gate };
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

    // Accumulative: append an until leaf (mid-sequence loop guard).
    //   .until(checkFn, max?)                     — loop back to top
    //   .until(goto('name'), checkFn, max?)       — loop back to named child
    //   .until(goback(n), checkFn, max?)          — loop back by n children
    // Evaluates at its position in the child sequence. If checkFn returns
    // true, execution continues to the next child. If false, jumps back.
    until(...rawArgs) {
      const { gate, args } = takeGate(rawArgs, '.until()');
      let jumpTarget = null;
      let jumpType = null;
      // Optional first arg: goto() or goback() marker
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
        throw new TypeError('.until(): first argument must be the condition function (or a goto/goback marker followed by the condition)');
      }
      const maxMarker = args.shift();
      if (maxMarker !== undefined && !isMax(maxMarker)) {
        throw new TypeError('.until(): second argument must be max(count[, errFn])');
      }
      if (args.length !== 0) throw new TypeError('.until(): too many arguments');
      const child = {
        kind: 'until',
        name: null,
        check: checkFn,
        max: resolveMax(maxMarker),
        jumpType,
        jumpTarget,
        gate,
      };
      return next(def, (d) => { d.children.push(child); });
    },

    // Accumulative: unconditional jump to a named child (used with .check()).
    //   .goto('name')              — jump to child 'name'
    //   .goto('name', max(n))      — with retry limit
    goto(...rawArgs) {
      const { gate, args } = takeGate(rawArgs, '.goto()');
      if (gate) throw new TypeError('.goto() does not support when() — use it inside .check() or .until()');
      const target = args.shift();
      if (typeof target !== 'string' || target.length === 0) {
        throw new TypeError(".goto(): first argument must be the target child name (string)");
      }
      const maxMarker = args.shift() ?? null;
      if (maxMarker !== null && !isMax(maxMarker)) {
        throw new TypeError('.goto(): second argument must be max(count[, errFn])');
      }
      if (args.length !== 0) throw new TypeError('.goto(): too many arguments');
      return goto(target, maxMarker);
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
  const allowed = new Set(['tools']);
  for (const k of Object.keys(opts)) {
    if (!allowed.has(k)) throw new TypeError(`${method}: unknown option '${k}'`);
  }
  if (opts.tools !== undefined && (!Array.isArray(opts.tools) || opts.tools.some((t) => typeof t !== 'string'))) {
    throw new TypeError(`${method}: options.tools must be an array of strings`);
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
