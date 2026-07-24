// Memory is a scope chain: every branch owns a memory (Scope), linked to its
// parent's. Reads resolve upward; nearest binding wins. Writes flow up one
// level (a completed child's result lands in its parent's slots).

export class Scope {
  constructor(parent = null) {
    this.parent = parent;
    this.slots = Object.create(null); // name → exported value
    this.raw = Object.create(null); // name → record view
    this.prev = []; // { childIndex, name, value } — most-recent-first
    this.prevRaw = []; // { childIndex, name, record }
    this.error = undefined; // check feedback channel
  }
}

export function lookupChain(scope, name) {
  let s = scope;
  while (s) {
    if (Object.prototype.hasOwnProperty.call(s.slots, name)) return s.slots[name];
    s = s.parent;
  }
  return undefined;
}

function rawLookupChain(scope, name) {
  let s = scope;
  while (s) {
    if (Object.prototype.hasOwnProperty.call(s.raw, name)) return s.raw[name];
    s = s.parent;
  }
  return undefined;
}

function collectKeys(scope) {
  const keys = new Set();
  let s = scope;
  while (s) {
    for (const k of Object.keys(s.slots)) keys.add(k);
    s = s.parent;
  }
  return [...keys];
}

// The memory object handed to prompt/gate/check/args functions. Framework
// keys (prev, branch, raw, error) are intercepted; everything else resolves
// up the scope chain (root inputs, ancestor slots).
export function makeView(scope) {
  const branchProxy = new Proxy(Object.create(null), {
    get: (_, key) => lookupChain(scope, key),
    has: (_, key) => lookupChain(scope, key) !== undefined,
    ownKeys: () => collectKeys(scope),
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
  });

  const rawBranchProxy = new Proxy(Object.create(null), {
    get: (_, key) => rawLookupChain(scope, key),
    has: (_, key) => rawLookupChain(scope, key) !== undefined,
  });

  return new Proxy(Object.create(null), {
    get(_, key) {
      if (key === 'prev') return scope.prev.map((e) => e.value);
      if (key === 'branch') return branchProxy;
      if (key === 'raw') {
        return {
          prev: scope.prevRaw.map((e) => e.record),
          branch: rawBranchProxy,
        };
      }
      if (key === 'error') return scope.error;
      return lookupChain(scope, key);
    },
    has(_, key) {
      return key === 'prev' || key === 'branch' || key === 'raw' || key === 'error'
        || lookupChain(scope, key) !== undefined;
    },
  });
}
