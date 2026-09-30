// Tree factory: Tree(...elements) accumulates an immutable definition (plain
// data) — the element form is the only authoring surface. Execution happens
// separately, via grandma.knit().
//
//   export default Tree(
//     name('call_outcome'), Model('strong'),
//     Prompt('response', textFn, when(cond), max(6)),
//     Register('note_phone', 'Save a phone note', body, calls('contacts__get_contact')),
//     Branch(outcomeTree),
//     Until(() => false, max(100000)),
//   )
//
// Elements are validated where they are written (records.mjs); application is
// copy-on-write: every element returns a fresh definition, so sharing a tree
// across parents is bulletproof.

import { isElement } from './records.mjs';

const registry = new Map();

function makeDef() {
  return { kind: 'tree', name: null, children: [], models: [], tools: [], untils: [], needs: [] };
}

// Copy-on-write: each element returns a new definition over a fresh one.
function next(def, patch) {
  const d = {
    ...def,
    children: [...def.children],
    models: [...def.models],
    tools: [...def.tools],
    untils: [...def.untils],
    needs: [...def.needs],
    // Registers are carried only once used: a def that never registers must
    // keep the exact same JSON shape — definition ids and host session
    // hashes are computed over the def and must not churn on upgrade.
    ...(def.registers ? { registers: [...def.registers] } : {}),
  };
  patch(d);
  if (d.name != null) registry.set(d.name, d);
  return d;
}

// Apply one element: steps append their prebuilt record; directives patch the
// def-level arrays; registers append to the declarations.
function applyElement(def, el) {
  if (!isElement(el)) {
    throw new TypeError(
      'Tree(...): every argument must be an element — name(), Model(), Tools(), Needs(), Human(), ' +
      'Prompt(), Memory(), Register(), Branch(), Each(), Call(), Check(), Emit(), Return(), Until()',
    );
  }
  switch (el.element) {
    case 'name':
      return next(def, (d) => { d.name = el.value; });
    case 'model':
      return next(def, (d) => { d.models.push({ cond: el.gate, value: el.value }); });
    case 'tools':
      // `position` is the index of the next child to run: the rule applies
      // from that point onward, and so do the register names it may
      // reference (Register is positional — see knit.mjs validation).
      return next(def, (d) => { d.tools.push({ cond: el.gate, value: [...el.names], position: d.children.length }); });
    case 'needs':
      return next(def, (d) => {
        for (const n of el.names) if (!d.needs.includes(n)) d.needs.push(n);
      });
    case 'register':
      // Positional: `position` is the index of the next child to run, so the
      // tool is usable from there onward and a reference before it is a
      // build error (enforced by knit.mjs validation).
      return next(def, (d) => {
        d.registers = [...(d.registers ?? []), { ...el.entry, position: d.children.length }];
      });
    default:
      return next(def, (d) => { d.children.push(el.record); });
  }
}

// Tree is the factory AND the namespace: Tree(element, …) builds a tree;
// Tree.from()/Tree.has() use the registry. An unnamed tree needs no name():
// knit() auto-names subtrees after their child (see autoname in knit.mjs) and
// registers them so resume can find them.
export function Tree(...elements) {
  let def = makeDef();
  for (const el of elements) def = applyElement(def, el);
  return def;
}

// Retrieve a registered tree by name (for reuse).
Tree.from = (id) => {
  const def = registry.get(id);
  if (!def) throw new Error(`no tree registered under name '${id}'`);
  return def;
};
Tree.has = (id) => registry.has(id);

/** Register a tree def under its (possibly auto-assigned) name. */
export function registerTree(tree) {
  if (tree?.name != null) registry.set(tree.name, tree);
}

export { unwrap } from './records.mjs';
