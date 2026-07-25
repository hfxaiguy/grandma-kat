// The runner: grandma.knit(pattern, runtime) validates the definition and
// runtime, then executes the tree with an injected runtime (models, tools,
// memory, logger).

import { Scope, makeView, lookupChain } from './memory.mjs';
import { callLlm, normalizeMessages } from './llm.mjs';
import { createLogger, createRunId, definitionId } from './logger.mjs';
import { unwrap } from './tree.mjs';

export class KnitError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'KnitError';
    this.details = details;
  }
}

const RESERVED_MEMORY_KEYS = new Set(['prev', 'branch', 'raw', 'error']);
const DEFAULT_MAX_TOOL_ROUNDS = 5;

export async function knit(rootInput, runtime = {}) {
  const def = finalize(rootInput, runtime);
  validateRuntime(def, runtime);

  const logger = createLogger(runtime.logger ?? false, runtime.logLevel ?? 'none');
  const exec = {
    runtime,
    logger,
    runId: createRunId(),
    defId: definitionId(def),
    stack: [], // [{ name, tree, pass, edgeCounters: Map }]
  };

  const rootScope = new Scope(null);
  for (const [k, v] of Object.entries(runtime.memory ?? {})) {
    rootScope.slots[k] = v;
  }

  try {
    const outcome = await execTree(exec, def, rootScope, rootScope);
    return { result: outcome.value, memory: rootScope.slots, runId: exec.runId };
  } finally {
    logger.close();
  }
}

// --- execution ---

async function execTree(exec, tree, scope, parentScope) {
  // Declared inputs must resolve via the scope chain (ancestors may satisfy
  // them even when a sibling producer was skipped).
  for (const need of tree.needs) {
    if (lookupChain(parentScope, need) === undefined) {
      throw new KnitError(`tree '${tree.name}' needs '${need}', but it does not resolve in scope`);
    }
  }

  const state = { name: tree.name, tree, pass: 0, edgeCounters: new Map() };
  exec.stack.push(state);
  try {
    const view = makeView(scope);

    for (;;) {
      state.pass++;
      // .until() rewinds m.prev at the start of each pass (current-path log).
      scope.prev = [];
      scope.prevRaw = [];

      let i = 0;
      while (i < tree.children.length) {
        const child = tree.children[i];

        // Gates re-evaluate lazily whenever the child is reached.
        if (child.gate && !(await callFn(child.gate, view, `gate of '${child.name}'`))) {
          logEvent(exec, 'gate', { child: child.name, result: 'skipped' });
          i++;
          continue;
        }

        if (child.kind === 'check') {
          const r = await callFn(child.check, view, `check '${child.name}'`);
          if (r === true) {
            scope.error = undefined; // cleared when a check passes
            logEvent(exec, 'check', { child: child.name, pass: true });
            i++;
            continue;
          }
          scope.error = typeof r === 'string' ? r : 'check failed';
          logEvent(exec, 'check', { child: child.name, pass: false, feedback: scope.error });

          const key = `check:${i}`;
          const used = (state.edgeCounters.get(key) ?? 0) + 1;
          state.edgeCounters.set(key, used);
          if (used > child.flow.max.count) {
            logEvent(exec, 'flow', { type: 'exhausted', child: child.name, used });
            throw new KnitError(await exhaustionMessage(child.flow.max, view,
              `check '${child.name}' failed after ${child.flow.max.count} retries: ${scope.error}`));
          }
          const cut = i - child.flow.n;
          if (cut < 0) {
            throw new KnitError(`goback(${child.flow.n}) from '${child.name}' rewinds past the first child`);
          }
          logEvent(exec, 'flow', { type: 'goback', n: child.flow.n, from: child.name, used });
          rewind(scope, cut);
          i = cut;
          continue;
        }

        let outcome;
        if (child.kind === 'branch') {
          const childScope = new Scope(scope);
          const out = await execTree(exec, child.tree, childScope, scope);
          outcome = {
            value: out.value,
            record: { content: out.value ?? null, children: { ...childScope.raw } },
          };
        } else if (child.kind === 'prompt') {
          outcome = await execPrompt(exec, child, scope);
        } else if (child.kind === 'memory') {
          await execMemory(exec, child, scope);
          i++;
          continue;
        } else {
          outcome = await execCall(exec, child, scope);
        }
        record(scope, i, child.name, outcome);
        i++;
      }

      const until = await selectRule(tree.untils, view, 'until condition');
      if (!until) return exportOutcome(scope);
      if (await callFn(until.check, view, `until check of '${tree.name}'`)) {
        return exportOutcome(scope);
      }

      const used = (state.edgeCounters.get('until') ?? 0) + 1;
      state.edgeCounters.set('until', used);
      if (used > until.max.count) {
        logEvent(exec, 'flow', { type: 'exhausted', child: 'until', used });
        throw new KnitError(await exhaustionMessage(until.max, view,
          `until loop of '${tree.name}' exhausted after ${until.max.count} rewinds`));
      }
      logEvent(exec, 'flow', { type: 'until-rewind', used });
      // next pass: prev is reset at the top of the loop
    }
  } finally {
    exec.stack.pop();
  }
}

async function execPrompt(exec, child, scope) {
  const view = makeView(scope);
  const value = typeof child.prompt === 'function'
    ? await callFn(child.prompt, view, `prompt fn of '${child.name}'`)
    : child.prompt;
  const messages = normalizeMessages(value);

  const modelName = (await resolveInherited(exec, 'models', view)) ?? runtimeDefaultModel(exec);
  const modelEntry = exec.runtime.models?.[modelName];
  if (!modelEntry) {
    throw new KnitError(`model '${modelName}' (used by '${child.name}') not found in runtime models`);
  }

  const toolNames = child.options.tools ?? (await resolveInherited(exec, 'tools', view)) ?? [];
  const tools = toolNames.map((n) => ({
    type: 'function',
    function: {
      name: n,
      description: exec.runtime.tools?.[n]?.description ?? '',
      parameters: exec.runtime.tools?.[n]?.parameters ?? { type: 'object', properties: {} },
    },
  }));

  const maxRounds = child.options.maxRounds ?? DEFAULT_MAX_TOOL_ROUNDS;
  const record = { content: null, reasoning: null, toolCalls: [], toolResults: [], calls: [], model: modelName };

  for (let round = 1; ; round++) {
    const response = await callLlm(modelEntry, messages, { tools });
    record.calls.push({
      round,
      messages: messages.map((m) => ({ ...m })),
      response: { content: response.content, reasoning: response.reasoning, tool_calls: response.tool_calls ?? null },
    });
    logEvent(exec, 'llm_call', {
      child: child.name, round, model: modelName,
      content: response.content, toolCalls: response.tool_calls ?? null,
    });

    if (!response.tool_calls?.length) {
      record.content = response.content;
      record.reasoning = response.reasoning || null;
      return { value: response.content, record };
    }
    if (round >= maxRounds) {
      throw new KnitError(`prompt '${child.name}' exceeded max tool rounds (${maxRounds})`);
    }

    // Internal agentic loop: execute tool calls, feed results back.
    messages.push({ role: 'assistant', content: response.content || null, tool_calls: response.tool_calls });
    for (const tc of response.tool_calls) {
      const name = tc.function?.name;
      record.toolCalls.push({ id: tc.id, name, arguments: tc.function?.arguments });
      const args = (() => { try { return JSON.parse(tc.function.arguments); } catch { return tc.function.arguments; } })();
      let result;
      let isError = false;
      try {
        const tool = exec.runtime.tools?.[name];
        if (!tool) throw new KnitError(`unknown tool '${name}'`);
        result = await tool.execute(args);
      } catch (err) {
        // Tool errors are fed back to the model, not fatal to the tree.
        isError = true;
        result = `error: ${err.message}`;
      }
      record.toolResults.push({ name, result, isError });
      logEvent(exec, 'tool_result', { child: child.name, tool: name, args, result, isError });
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: typeof result === 'string' ? result : JSON.stringify(result),
      });
    }
  }
}

async function execCall(exec, child, scope) {
  const view = makeView(scope);
  const args = typeof child.argsFn === 'function'
    ? await callFn(child.argsFn, view, `args fn of '${child.name}'`)
    : child.argsFn;
  const tool = exec.runtime.tools?.[child.tool];
  if (!tool) throw new KnitError(`unknown tool '${child.tool}' (called from '${child.name}')`);
  const result = await tool.execute(args);
  logEvent(exec, 'tool_call', { child: child.name, tool: child.tool, args, result });
  return { value: result, record: { content: result, tool: child.tool, args, toolResults: [result] } };
}

// Side-effect only: writes to a named memory slot, produces no m.prev output.
async function execMemory(exec, child, scope) {
  const view = makeView(scope);
  const current = scope.slots[child.name]; // read before write (may be undefined)
  const value = await callFn(child.fn, view, `memory fn of '${child.name}'`, current);
  scope.slots[child.name] = value;
  logEvent(exec, 'memory', { child: child.name, value });
}

// --- memory helpers ---

function record(scope, childIndex, name, outcome) {
  scope.slots[name] = outcome.value;
  scope.raw[name] = outcome.record;
  scope.prev.unshift({ childIndex, name, value: outcome.value });
  scope.prevRaw.unshift({ childIndex, name, record: outcome.record });
}

// goback rewinds m.prev to the jump point; named slots are NOT rewound
// (they persist until a re-run overwrites them).
function rewind(scope, cut) {
  scope.prev = scope.prev.filter((e) => e.childIndex < cut);
  scope.prevRaw = scope.prevRaw.filter((e) => e.childIndex < cut);
}

// A container's value = its last executed child's result.
function exportOutcome(scope) {
  const value = scope.prev.length ? scope.prev[0].value : undefined;
  return { value, record: { content: value ?? null, children: { ...scope.raw } } };
}

// --- rule evaluation ---

// Selective rules: last matching rule wins (conditional assignment).
async function selectRule(rules, view, label) {
  for (let i = rules.length - 1; i >= 0; i--) {
    const r = rules[i];
    if (r.cond == null || (await callFn(r.cond, view, label))) return r;
  }
  return null;
}

// Inheritance up the tree stack: innermost tree with a matching rule wins.
async function resolveInherited(exec, kind, view) {
  for (let i = exec.stack.length - 1; i >= 0; i--) {
    const rules = exec.stack[i].tree[kind];
    if (!rules?.length) continue;
    const rule = await selectRule(rules, view, `${kind} rule condition`);
    if (rule) return rule.value;
  }
  return null;
}

function runtimeDefaultModel(exec) {
  const models = exec.runtime.models ?? {};
  if (models.default) return 'default';
  const keys = Object.keys(models);
  if (keys.length === 1) return keys[0];
  throw new KnitError('no model resolved (no .model() anywhere and no runtime default)');
}

async function callFn(fn, view, label, ...extra) {
  try {
    return await fn(view, ...extra);
  } catch (err) {
    throw new KnitError(`${label} threw: ${err.message}`, { cause: err });
  }
}

async function exhaustionMessage(maxRule, view, fallback) {
  if (!maxRule.errFn) return fallback;
  return String(await callFn(maxRule.errFn, view, 'max errFn'));
}

function logEvent(exec, kind, content) {
  exec.logger.log({
    run_id: exec.runId,
    definition_id: exec.defId,
    branch_path: exec.stack.map((s) => s.name).join('/'),
    iteration: exec.stack[exec.stack.length - 1]?.pass ?? 0,
    kind,
    content,
  });
}

// --- build-time finalization & validation ---

function finalize(rootInput, runtime) {
  const root = unwrap(rootInput);
  const warnings = [];
  autoname(root);
  validateTree(root, warnings);
  validateNeeds(root, runtime, warnings);
  for (const w of warnings) console.warn(`[grandma-kat] ${w}`);
  return root;
}

// Auto-names are assigned at build time: `${parentName}#${k}`, k = 1-based
// position among ALL children (uniform, collision-free; `#` is reserved).
function autoname(tree) {
  tree.children.forEach((child, idx) => {
    if (child.name == null) child.name = `${tree.name}#${idx + 1}`;
    if (child.kind === 'branch') autoname(child.tree);
  });
}

function validateTree(tree, warnings) {
  if (tree.name == null) {
    throw new KnitError('every tree needs a name (call .name() first)');
  }
  if (tree.children.length === 0) {
    throw new KnitError(`tree '${tree.name}' has zero children — a named tree with no children is a build error`);
  }

  const seen = new Set();
  for (const child of tree.children) {
    if (seen.has(child.name)) {
      warnings.push(`tree '${tree.name}' has duplicate child name '${child.name}' — the second overwrites the first's memory slot`);
    }
    seen.add(child.name);
    if (child.kind === 'branch') validateTree(child.tree, warnings);
  }

  for (const kind of ['models', 'tools', 'untils']) {
    warnShadowedRules(tree, kind, warnings);
  }
}

// Under last-match-wins, an unconditional rule shadows every earlier rule.
function warnShadowedRules(tree, kind, warnings) {
  const rules = tree[kind];
  for (let j = rules.length - 1; j >= 0; j--) {
    if (rules[j].cond == null && j > 0) {
      warnings.push(`tree '${tree.name}': ${j} shadowed ${kind} rule(s) — an unconditional ${kind} rule overwrites all earlier rules (last match wins)`);
      return;
    }
  }
}

function validateNeeds(tree, runtime, warnings) {
  const produced = new Set();
  collectNames(tree, produced);
  const injected = new Set(Object.keys(runtime.memory ?? {}));

  const walk = (t) => {
    for (const need of t.needs) {
      if (need.includes('#')) {
        warnings.push(`tree '${t.name}' needs auto-named slot '${need}' — give that child an explicit name ("if you reference it, you name it")`);
      }
      if (!produced.has(need) && !injected.has(need)) {
        throw new KnitError(`tree '${t.name}' needs '${need}', but no branch produces it and it is not in the injected memory`);
      }
    }
    for (const child of t.children) {
      if (child.kind === 'branch') walk(child.tree);
    }
  };
  walk(tree);
}

function collectNames(tree, set) {
  set.add(tree.name);
  for (const child of tree.children) {
    set.add(child.name);
    if (child.kind === 'branch') collectNames(child.tree, set);
  }
}

function validateRuntime(def, runtime) {
  // Reserved framework keys may not be injected as root memory.
  for (const k of Object.keys(runtime.memory ?? {})) {
    if (RESERVED_MEMORY_KEYS.has(k)) {
      throw new KnitError(`injected memory key '${k}' is reserved by the framework (${[...RESERVED_MEMORY_KEYS].join(', ')})`);
    }
  }

  // Every referenced model name must exist in the runtime models.
  const modelRefs = new Set();
  const toolRefs = []; // [{ name, path }]
  const callRefs = []; // [{ name, path }]
  const collect = (t, path) => {
    for (const r of t.models) modelRefs.add(r.value);
    for (const r of t.tools) {
      for (const n of r.value) toolRefs.push({ name: n, path });
    }
    for (const c of t.children) {
      if (c.kind === 'call') callRefs.push({ name: c.tool, path });
      if (c.kind === 'branch') collect(c.tree, `${path}/${c.name}`);
    }
  };
  collect(def, def.name);

  const models = runtime.models ?? {};
  for (const name of modelRefs) {
    if (!models[name]) {
      throw new KnitError(`.model('${name}') references a model not in runtime models (available: ${Object.keys(models).join(', ') || 'none'})`);
    }
  }
  if (modelRefs.size === 0 && !models.default && Object.keys(models).length !== 1) {
    throw new KnitError('no model resolvable: no .model() rules anywhere and no runtime default (set models.default or provide exactly one model)');
  }
  for (const [name, entry] of Object.entries(models)) {
    if (typeof entry.handler !== 'function' && !entry.baseURL) {
      throw new KnitError(`model '${name}' needs either a handler (mock) or a baseURL`);
    }
  }

  const tools = runtime.tools ?? {};
  const missing = [];
  for (const { name, path } of [...toolRefs, ...callRefs]) {
    if (!tools[name]) missing.push(`${path} references unknown tool '${name}'`);
  }
  if (missing.length) {
    const available = Object.keys(tools).join(', ') || 'none';
    throw new KnitError(`unknown tools:\n  ${missing.join('\n  ')}\navailable: ${available}`);
  }
}
