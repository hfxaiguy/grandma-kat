// The runner: grandma.knit(pattern, runtime) validates the definition and
// runtime, then executes the tree with an injected runtime (models, tools,
// memory, logger).

import { Scope, makeView, lookupChain, resetScopeIdCounter } from './memory.mjs';
import { callLlm, normalizeMessages } from './llm.mjs';
import { createLogger, createRunId, definitionId } from './logger.mjs';
import { unwrap, Tree } from './tree.mjs';

export class PauseSignal {
  constructor(checkpointId, humanSlot, context) {
    this.checkpointId = checkpointId;
    this.humanSlot = humanSlot;
    this.context = context;
  }
}

export class KnitError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'KnitError';
    this.details = details;
  }
}

const RESERVED_MEMORY_KEYS = new Set(['prev', 'branch', 'raw', 'error']);

export async function knit(rootInput, runtime = {}) {
  const def = finalize(rootInput, runtime);
  validateRuntime(def, runtime);

  const logger = createLogger(runtime.logger ?? false, runtime.logLevel ?? 'none');
  const callerOwnsLogger = typeof runtime.logger === 'object' && runtime.logger !== null && typeof runtime.logger.log === 'function';
  const exec = {
    runtime,
    logger,
    runId: createRunId(),
    defId: definitionId(def),
    stack: [], // [{ name, tree, childIndex, pass, edgeCounters: Map }]
    seq: 0,
  };

  let rootScope;
  let resumeState = null;

  if (runtime._continuation) {
    // Resume from checkpoint: reconstruct state from event log.
    const result = await resume(runtime._continuation, runtime);
    return result;
  } else {
    resetScopeIdCounter(0);
    rootScope = new Scope(null);
    logEvent(exec, 'scope_init', { scopeId: rootScope.id, parentScopeId: null }, rootScope);
    for (const [k, v] of Object.entries(runtime.memory ?? {})) {
      rootScope.slots[k] = v;
    }
  }

  try {
    const outcome = await execTree(exec, def, rootScope, rootScope, resumeState);
    return { result: outcome.value, memory: rootScope.slots, runId: exec.runId };
  } catch (err) {
    if (err instanceof PauseSignal) {
      return {
        status: 'waiting',
        humanSlot: err.humanSlot,
        context: err.context,
        continuation: err.checkpointId,
      };
    }
    throw err;
  } finally {
    if (!callerOwnsLogger) logger.close();
  }
}

// --- resume from checkpoint ---

export async function resume(checkpointId, runtime) {
  const logger = createLogger(runtime.logger ?? false, runtime.logLevel ?? 'none');
  const callerOwnsLogger = typeof runtime.logger === 'object' && runtime.logger !== null && typeof runtime.logger.log === 'function';
  try {
    const cp = logger.getCheckpoint(checkpointId);
    if (!cp) throw new KnitError(`checkpoint '${checkpointId}' not found`);
    const cpRunId = cp.run_id;
    const events = logger.getEvents(cpRunId);
    const resumePositions = JSON.parse(cp.resume_positions);

    // Reconstruct scope chain from events.
    const scopes = new Map();
    let rootScope = null;
    let humanScopeId = null;

    for (const ev of events) {
      if (ev.seq > cp.seq) break;
      const c = ev.content;

      if (ev.kind === 'scope_init') {
        const scope = new Scope(null);
        scope.id = c.scopeId;
        if (c.parentScopeId != null && scopes.has(c.parentScopeId)) {
          scope.parent = scopes.get(c.parentScopeId);
        }
        scopes.set(c.scopeId, scope);
        if (!rootScope && c.parentScopeId === null) rootScope = scope;
      }

      const scope = scopes.get(ev.scope_id);
      if (!scope) continue;

      if (ev.kind === 'record') {
        scope.slots[c.child] = c.value;
        scope.prev.unshift({ childIndex: c.childIndex, name: c.child, value: c.value });
      } else if (ev.kind === 'check') {
        scope.error = c.pass ? undefined : c.feedback;
      } else if (ev.kind === 'memory' && !c.update) {
        scope.slots[c.child] = c.value;
      } else if (ev.kind === 'human') {
        humanScopeId = ev.scope_id;
      }
    }

    // Detect iteration boundaries: when iteration increments, reset prev.
    let lastIteration = new Map();
    for (const ev of events) {
      if (ev.seq > cp.seq) break;
      if (!ev.scope_id) continue;
      const prev = lastIteration.get(ev.scope_id);
      if (prev !== undefined && ev.iteration > prev) {
        const scope = scopes.get(ev.scope_id);
        if (scope) { scope.prev = []; scope.prevRaw = []; }
      }
      lastIteration.set(ev.scope_id, ev.iteration);
    }

    // Detect goback: filter prev by cut index.
    for (const ev of events) {
      if (ev.seq > cp.seq) break;
      if (ev.kind === 'flow' && ev.content.type === 'goback') {
        const scope = scopes.get(ev.scope_id);
        if (scope) {
          const checkIdx = scope.prev.findIndex(e => e.name === ev.content.from);
          const cut = (checkIdx >= 0 ? checkIdx : scope.prev.length) - ev.content.n;
          scope.prev = scope.prev.filter(e => e.childIndex < cut);
        }
      }
    }

    // Reconstruct execution stack from branch_path of the human event.
    const humanEvent = events.find(e => e.seq === cp.seq && e.kind === 'human');
    if (!humanEvent) throw new KnitError(`checkpoint '${checkpointId}': no human event found at seq ${cp.seq}`);
    const treeNames = humanEvent.branch_path.split('/');

    // Find max scope ID for counter reset.
    let maxScopeId = 0;
    for (const id of scopes.keys()) {
      if (id > maxScopeId) maxScopeId = id;
    }
    resetScopeIdCounter(maxScopeId + 1);

    // Inject human input into ALL scopes.
    const humanInput = runtime.humanInput ?? {};
    for (const [, s] of scopes) {
      for (const [k, v] of Object.entries(humanInput)) {
        s.slots[k] = v;
        s.raw[k] = { content: v };
      }
    }

    // Build the resume stack.
    const stack = treeNames.map((name, idx) => ({
      name,
      tree: registryGet(name),
      childIndex: 0,
      pass: 0,
      edgeCounters: new Map(),
      resumeChildStart: resumePositions[idx],
    }));

    const resumeState = {
      scopes,
      current: scopes.get(humanScopeId),
      stack,
      stackIdx: 0,
    };

    const exec = {
      runtime,
      logger,
      runId: cp.run_id,
      defId: definitionId(rootScope ? registryGet(treeNames[0]) : null),
      stack: [],
      seq: cp.seq,
    };
    try {
      const outcome = await execTree(exec, registryGet(treeNames[0]), rootScope, rootScope, resumeState);
      logger.deleteCheckpoint(checkpointId);
      return { result: outcome.value, memory: rootScope.slots, runId: exec.runId };
    } catch (err) {
      if (err instanceof PauseSignal) {
        // Delete the OLD checkpoint we resumed from (new one was saved by execTreeInner).
        logger.deleteCheckpoint(checkpointId);
        return {
          status: 'waiting',
          humanSlot: err.humanSlot,
          context: err.context,
          continuation: err.checkpointId,
        };
      }
      logger.deleteCheckpoint(checkpointId);
      throw err;
    }
  } finally {
    if (!callerOwnsLogger) logger.close();
  }
}

// --- execution ---

async function execTree(exec, tree, scope, parentScope, resumeState = null) {
  if (resumeState) {
    // Resume path: reconstruct scope, then continue execution.
    const restoredScope = resumeState.current;
    if (restoredScope && restoredScope !== scope) {
      Object.assign(scope.slots, restoredScope.slots);
      Object.assign(scope.raw, restoredScope.raw);
      scope.prev = restoredScope.prev;
      scope.prevRaw = restoredScope.prevRaw;
      scope.error = restoredScope.error;
    }
    // Inject human input into ALL scopes in the continuation.
    const humanInput = exec.runtime.humanInput ?? {};
    if (Object.keys(humanInput).length > 0) {
      for (const [, s] of resumeState.scopes) {
        for (const [k, v] of Object.entries(humanInput)) {
          s.slots[k] = v;
          s.raw[k] = { content: v };
        }
      }
      for (const [k, v] of Object.entries(humanInput)) {
        scope.slots[k] = v;
        scope.raw[k] = { content: v };
      }
    }
    // Push the stack entry for THIS tree level (using stackIdx).
    const entry = resumeState.stack[resumeState.stackIdx];
    resumeState.stackIdx++;
    exec.stack.push(entry);
    try {
      return await execTreeInner(exec, tree, scope, parentScope, resumeState);
    } finally {
      exec.stack.pop();
    }
  }

  // Initial run path.
  const state = { name: tree.name, tree, childIndex: 0, pass: 0, edgeCounters: new Map() };
  exec.stack.push(state);
  try {
    return await execTreeInner(exec, tree, scope, parentScope, null);
  } finally {
    exec.stack.pop();
  }
}

async function execTreeInner(exec, tree, scope, parentScope, resumeState) {
  // Declared inputs must resolve via the scope chain (ancestors may satisfy
  // them even when a sibling producer was skipped).
  if (!resumeState) {
    for (const need of tree.needs) {
      if (lookupChain(parentScope, need) === undefined) {
        throw new KnitError(`tree '${tree.name}' needs '${need}', but it does not resolve in scope`);
      }
    }
  }

  const state = exec.stack[exec.stack.length - 1];
  const view = makeView(scope);
  const resumeStart = state.resumeChildStart; // saved before consumed
  const savedResume = resumeState; // kept for passing to branch children

  for (;;) {
    if (!resumeState) {
      state.pass++;
      // .until() rewinds m.prev at the start of each pass (current-path log).
      scope.prev = [];
      scope.prevRaw = [];
    }

    // On resume, start from the saved position (per stack entry).
    // After the first iteration, resumeChildStart is cleared so
    // subsequent loop passes start from 0.
    let i = state.resumeChildStart ?? 0;
    if (state.resumeChildStart != null) {
      state.resumeChildStart = undefined;
      resumeState = null; // consumed
    }

    while (i < tree.children.length) {
      state.childIndex = i;
      const child = tree.children[i];

      // Gates re-evaluate lazily whenever the child is reached.
      if (child.gate && !(await callFn(child.gate, view, `gate of '${child.name}'`))) {
        logEvent(exec, 'gate', { child: child.name, result: 'skipped' }, scope);
        i++;
        continue;
      }

      if (child.kind === 'check') {
        const r = await callFn(child.check, view, `check '${child.name}'`);
        if (r === true) {
          scope.error = undefined; // cleared when a check passes
          logEvent(exec, 'check', { child: child.name, pass: true }, scope);
          i++;
          continue;
        }
        scope.error = typeof r === 'string' ? r : 'check failed';
        logEvent(exec, 'check', { child: child.name, pass: false, feedback: scope.error }, scope);

        const key = `check:${i}`;
        const used = (state.edgeCounters.get(key) ?? 0) + 1;
        state.edgeCounters.set(key, used);
        if (used > child.flow.max.count) {
          logEvent(exec, 'flow', { type: 'exhausted', child: child.name, used }, scope);
          throw new KnitError(await exhaustionMessage(child.flow.max, view,
            `check '${child.name}' failed after ${child.flow.max.count} retries: ${scope.error}`));
        }
        if (child.flow.type === 'goto') {
          const targetIdx = tree.children.findIndex(c => c.name === child.flow.target);
          if (targetIdx === -1) {
            throw new KnitError(`check goto('${child.flow.target}'): no child with that name in tree '${tree.name}'`);
          }
          logEvent(exec, 'flow', { type: 'goto', target: child.flow.target, from: child.name, childIndex: targetIdx, used }, scope);
          rewind(scope, targetIdx);
          i = targetIdx;
        } else {
          // goback (default)
          const cut = i - child.flow.n;
          if (cut < 0) {
            throw new KnitError(`goback(${child.flow.n}) from '${child.name}' rewinds past the first child`);
          }
          logEvent(exec, 'flow', { type: 'goback', n: child.flow.n, from: child.name, used }, scope);
          rewind(scope, cut);
          i = cut;
        }
        continue;
      }

      let outcome;
      if (child.kind === 'branch') {
        const childScope = new Scope(scope);
        logEvent(exec, 'scope_init', { scopeId: childScope.id, parentScopeId: scope.id }, childScope);
        // On resume, pass the resume state to the branch child that's
        // at the resume position so the inner tree can continue from its
        // saved position. stackIdx ensures each tree level reads the
        // right entry from the continuation.
        const branchResume = (resumeStart != null && i === resumeStart) ? savedResume : null;
        const out = await execTree(exec, child.tree, childScope, scope, branchResume);
        outcome = {
          value: out.value,
          record: { content: out.value ?? null, children: { ...childScope.raw } },
        };
      } else if (child.kind === 'prompt') {
        outcome = await execPrompt(exec, child, scope);
      } else if (child.kind === 'memory') {
        outcome = await execMemory(exec, child, scope);
      } else if (child.kind === 'memoryUpdate') {
        outcome = await execMemoryUpdate(exec, child, scope);
      } else if (child.kind === 'return') {
        const view = makeView(scope);
        const val = await callFn(child.fn, view, `return fn of '${child.name}'`);
        if (val !== undefined && val !== null) {
          const outcome = { value: val, record: { content: val } };
          record(exec, scope, i, child.name, outcome);
          logEvent(exec, 'return', { child: child.name, value: val }, scope);
          return exportOutcome(scope);
        }
        i++;
        continue;
      } else if (child.kind === 'map') {
        outcome = await execMap(exec, child, scope);
      } else if (child.kind === 'human') {
        const context = child.contextFn
          ? await callFn(child.contextFn, view, `human context of '${child.name}'`)
          : {};
        const humanSeq = logEvent(exec, 'human', { child: child.name, context }, scope);
        // Emit context before pausing — bots only need onEmit to talk.
        if (Object.keys(context).length > 0 && typeof exec.runtime.onEmit === 'function') {
          await exec.runtime.onEmit(context);
        }
        // Compute per-entry resume positions. Each stack entry resumes at
        // the child that led to this tree level. The innermost entry
        // (current tree) resumes at i + 1 (past the .human() child).
        // Outer entries resume at the branch/map child's index within
        // THEIR OWN tree (exec.stack[idx].childIndex), so the branch
        // that led here is re-entered with the saved resume state.
        const resumePositions = exec.stack.map((s, idx) => {
          if (idx === exec.stack.length - 1) return i + 1;
          return exec.stack[idx].childIndex;
        });
        // Save checkpoint with a unique ID.
        const checkpointId = `${exec.runId}:${humanSeq}`;
        exec.logger.saveCheckpoint(checkpointId, exec.runId, humanSeq, resumePositions);
        throw new PauseSignal(checkpointId, child.name, context);
      } else if (child.kind === 'emit') {
        await execEmit(exec, child, scope);
        i++;
        continue;
      } else if (child.kind === 'until') {
        const view = makeView(scope);
        const passed = await callFn(child.check, view, `until check '${child.name}'`);
        if (passed) {
          scope.error = undefined;
          logEvent(exec, 'until', { child: child.name, pass: true }, scope);
          i++;
          continue;
        }
        scope.error = typeof passed === 'string' ? passed : 'until condition not met';
        logEvent(exec, 'until', { child: child.name, pass: false, feedback: scope.error }, scope);

        const key = `until:${i}`;
        const used = (state.edgeCounters.get(key) ?? 0) + 1;
        state.edgeCounters.set(key, used);
        if (used > child.max.count) {
          logEvent(exec, 'flow', { type: 'exhausted', child: child.name, used }, scope);
          throw new KnitError(await exhaustionMessage(child.max, view,
            `until '${child.name}' exhausted after ${child.max.count} iterations: ${scope.error}`));
        }

        // Compute jump target.
        if (child.jumpType === 'goto') {
          const targetIdx = tree.children.findIndex(c => c.name === child.jumpTarget);
          if (targetIdx === -1) {
            throw new KnitError(`until goto('${child.jumpTarget}'): no child with that name in tree '${tree.name}'`);
          }
          logEvent(exec, 'flow', { type: 'until-goto', target: child.jumpTarget, from: child.name, childIndex: targetIdx, used }, scope);
          rewind(scope, targetIdx);
          i = targetIdx;
        } else if (child.jumpType === 'goback') {
          const cut = i - child.jumpTarget;
          if (cut < 0) {
            throw new KnitError(`until goback(${child.jumpTarget}) from '${child.name}' rewinds past the first child`);
          }
          logEvent(exec, 'flow', { type: 'until-goback', n: child.jumpTarget, from: child.name, used }, scope);
          rewind(scope, cut);
          i = cut;
        } else {
          // Default: loop to top.
          logEvent(exec, 'flow', { type: 'until-rewind', from: child.name, used }, scope);
          rewind(scope, 0);
          i = 0;
        }
        continue;
      } else {
        outcome = await execCall(exec, child, scope);
      }
      record(exec, scope, i, child.name, outcome);
      i++;
    }

    // All children processed — no until looped back. Exit the tree.
    return exportOutcome(scope);
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

  const record = { content: null, reasoning: null, toolCalls: [], toolResults: [], calls: [], model: modelName };

  // One LLM call. If the model returns tool calls, execute them — but do
  // NOT loop. The tree controls retries via .check() + goback().
  const response = await callLlm(modelEntry, messages, { tools });
  record.calls.push({
    round: 1,
    messages: messages.map((m) => ({ ...m })),
    response: { content: response.content, reasoning: response.reasoning, tool_calls: response.tool_calls ?? null },
  });
  logEvent(exec, 'llm_call', {
    child: child.name, round: 1, model: modelName,
    messages,
    content: response.content, reasoning: response.reasoning, toolCalls: response.tool_calls ?? null,
  }, scope);

  if (!response.tool_calls?.length) {
    // No tool calls — text-only response.
    record.content = response.content;
    record.reasoning = response.reasoning || null;
    return { value: response.content, record };
  }

  // Execute tool calls (one round), then return.
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
      // Tools may return error-shaped results instead of throwing.
      if (result && typeof result === 'object' && 'error' in result) {
        isError = true;
      } else if (typeof result === 'string' && result.toLowerCase().startsWith('error')) {
        isError = true;
      }
    } catch (err) {
      isError = true;
      result = `error: ${err.message}`;
    }
    record.toolResults.push({ name, result, isError });
    logEvent(exec, 'tool_result', { child: child.name, tool: name, args, result, isError }, scope);
  }

  // The value is the text the model returned alongside the tool calls,
  // or empty string if it only returned tool calls. The tree reads
  // tool results via m.raw.prev[0].toolResults.
  record.content = response.content || '';
  record.reasoning = response.reasoning || null;
  return { value: record.content, record };
}

async function execCall(exec, child, scope) {
  const view = makeView(scope);
  const args = typeof child.argsFn === 'function'
    ? await callFn(child.argsFn, view, `args fn of '${child.name}'`)
    : child.argsFn;
  const tool = exec.runtime.tools?.[child.tool];
  if (!tool) throw new KnitError(`unknown tool '${child.tool}' (called from '${child.name}')`);
  const result = await tool.execute(args);
  logEvent(exec, 'tool_call', { child: child.name, tool: child.tool, args, result }, scope);
  return { value: result, record: { content: result, tool: child.tool, args, toolResults: [result] } };
}

// Calls runtime.onEmit(value) then continues. No state mutation.
async function execEmit(exec, child, scope) {
  const view = makeView(scope);
  const value = await callFn(child.fn, view, `emit fn of '${child.name}'`);
  logEvent(exec, 'emit', { child: child.name, value }, scope);
  if (typeof exec.runtime.onEmit === 'function') {
    await exec.runtime.onEmit(value);
  }
}

// Writes to a named memory slot AND produces m.prev output (like a prompt).
async function execMemory(exec, child, scope) {
  const view = makeView(scope);
  const current = scope.slots[child.name]; // read before write (may be undefined)
  const value = await callFn(child.fn, view, `memory fn of '${child.name}'`, current);
  logEvent(exec, 'memory', { child: child.name, value }, scope);
  return { value, record: { content: value } };
}

// Like execMemory but the slot must already exist in the scope chain.
// Updates the slot in the scope where it was found (ancestor or current).
async function execMemoryUpdate(exec, child, scope) {
  const view = makeView(scope);
  // Walk the scope chain to find where the slot lives.
  let target = scope;
  while (target) {
    if (Object.prototype.hasOwnProperty.call(target.slots, child.name)) break;
    target = target.parent;
  }
  if (!target) {
    throw new KnitError(`memoryUpdate('${child.name}'): slot '${child.name}' does not exist in the scope chain — declare it with .memory() first or inject it`);
  }
  const current = target.slots[child.name];
  const value = await callFn(child.fn, view, `memoryUpdate fn of '${child.name}'`, current);
  logEvent(exec, 'memory', { child: child.name, value, update: true }, target);
  return { value, record: { content: value }, _slotScope: target };
}

// Runs a subtree per element of an array. Each invocation gets `m.item`
// injected. Results are collected into an array in the parent scope.
async function execMap(exec, child, scope) {
  const view = makeView(scope);
  const items = await callFn(child.arrayFn, view, `array fn of '${child.name}'`);

  if (!Array.isArray(items) || items.length === 0) {
    const empty = [];
    logEvent(exec, 'map', { child: child.name, count: 0 }, scope);
    return { value: empty, record: { content: empty } };
  }

  const results = [];
  for (let idx = 0; idx < items.length; idx++) {
    const itemScope = new Scope(scope);
    logEvent(exec, 'scope_init', { scopeId: itemScope.id, parentScopeId: scope.id }, itemScope);
    itemScope.slots.item = items[idx];
    const out = await execTree(exec, child.tree, itemScope, scope);
    results.push(out.value);
    logEvent(exec, 'map_item', { child: child.name, index: idx, value: out.value }, scope);
  }

  logEvent(exec, 'map', { child: child.name, count: results.length }, scope);
  return { value: results, record: { content: results } };
}

// --- memory helpers ---

function record(exec, scope, childIndex, name, outcome) {
  const slotScope = outcome._slotScope ?? scope;
  slotScope.slots[name] = outcome.value;
  scope.raw[name] = outcome.record;
  scope.prev.unshift({ childIndex, name, value: outcome.value });
  scope.prevRaw.unshift({ childIndex, name, record: outcome.record });
  logEvent(exec, 'record', { child: name, childIndex, value: outcome.value }, slotScope);
}

// goback rewinds m.prev to the jump point; named slots are NOT rewound
// (they persist until a re-run overwrites them).
function rewind(scope, cut) {
  scope.prev = scope.prev.filter((e) => e.childIndex < cut);
  scope.prevRaw = scope.prevRaw.filter((e) => e.childIndex < cut);
}

// Serialize a stack entry for pause/resume (strip non-serializable tree ref).
function serializeStackEntry(entry, resumeChildStart) {
  return {
    name: entry.name,
    treeName: entry.name,
    childIndex: entry.childIndex,
    pass: entry.pass,
    edgeCounters: [...entry.edgeCounters.entries()],
    resumeChildStart,
  };
}

// Look up a registered tree by name (from the builder's global registry).
function registryGet(name) {
  if (!Tree.has(name)) {
    throw new KnitError(`cannot resume: tree '${name}' is not registered (call .name() to register)`);
  }
  return Tree.from(name).def;
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

function logEvent(exec, kind, content, scope) {
  exec.seq++;
  return exec.logger.log({
    run_id: exec.runId,
    definition_id: exec.defId,
    branch_path: exec.stack.map((s) => s.name).join('/'),
    iteration: exec.stack[exec.stack.length - 1]?.pass ?? 0,
    scope_id: scope?.id ?? null,
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
    if (child.kind === 'map') autoname(child.tree);
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
    if (child.kind === 'map') validateTree(child.tree, warnings);
  }

  for (const kind of ['models', 'tools']) {
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
    if (child.kind === 'map') collectNames(child.tree, set);
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
      if (c.kind === 'map') collect(c.tree, `${path}/${c.name}`);
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
