// compile.mjs — source ↔ definition plumbing for the smith.
//
// The authored source is a plain function body: the element factories are
// injected as parameters of a `new Function`, so `pattern` falls out as a
// tree definition (plain data) with no module system involved. Evaluation
// errors are the cheapest feedback loop — the smith's repair Check feeds
// `err.message` straight back to the authoring model.
//
// FACTORY_NAMES is the single source of truth for "what's in scope" — the
// guide renders its list and the evaluator binds exactly these names.

import * as gk from '../../src/index.mjs';

export const FACTORY_NAMES = [
  'Tree', 'name', 'Needs', 'Model', 'Tools', 'Branch', 'From', 'Prompt',
  'Call', 'Check', 'Until', 'Memory', 'Return', 'Each', 'Emit', 'Human',
  'Register', 'goback', 'max', 'goto', 'when', 'update', 'memory',
  'disableAuto', 'parameters', 'calls', 'toolHookBefore', 'toolHookAfter',
];
const FACTORY_VALUES = FACTORY_NAMES.map((n) => gk[n]);

// Models like to wrap code in a ```js fence even when told not to; accept it.
export function stripFences(text) {
  const m = String(text).match(/```[a-z]*\s*\n?([\s\S]*?)```/i);
  return (m ? m[1] : String(text)).trim();
}

// Evaluate the authored source. `pattern` is the name the guide pins for the
// final definition; anything else (or an eval error) comes back as undefined
// or a thrown error — the caller turns both into `{ error }` feedback.
export function evaluatePattern(source) {
  const body = stripFences(source).replace(/^[ \t]*export\s+/gm, '');
  const fn = new Function(...FACTORY_NAMES,
    `'use strict';\n${body}\n;return typeof pattern === 'undefined' ? undefined : pattern;`);
  return fn(...FACTORY_VALUES);
}

// Walk the def and report unknown tool/model references before we run it.
// The framework validates these when the tree is knit, but a generated tree
// starts mid-run — catching typos here routes them through the repair loop
// instead of failing the whole smith. Registers declared anywhere in the
// generated def count as known (a flat set is fine for an example).
//
// From(...) imports arrive as branch records carrying the resolved tree, so
// the walk recurses into them too — an imported tree answers to the same
// surface as the tree that imports it. The inventory is SURFACE.tools, not
// the live registry: the smith's own plumbing (`run_live`, `define_tree`) is
// deliberately off-limits so a generated tree can't recurse into the smith
// by accident.
export function validateDef(def, surface) {
  const problems = [];
  const tools = new Set(Object.keys(surface.tools));
  const models = new Set(Object.keys(surface.models));
  const registers = new Set();

  const walk = (t, path) => {
    for (const r of t.registers ?? []) registers.add(r.name);
    for (const rule of t.tools) {
      for (const n of rule.value) {
        if (!tools.has(n) && !registers.has(n)) {
          problems.push(`${path}: unknown tool '${n}' — available: ${[...tools].join(', ')}`);
        }
      }
    }
    for (const rule of t.models) {
      if (!models.has(rule.value)) {
        problems.push(`${path}: unknown model '${rule.value}' — available: ${[...models].join(', ')}`);
      }
    }
    for (const c of t.children ?? []) {
      if (c.kind === 'call' && !tools.has(c.tool) && !registers.has(c.tool)) {
        problems.push(`${path}: unknown tool '${c.tool}' (Call)`);
      }
      if (c.kind === 'branch' || c.kind === 'map') {
        walk(c.tree, `${path}/${c.name ?? '#'}`);
      }
    }
  };

  walk(def, def.name ?? 'pattern');
  return problems;
}
