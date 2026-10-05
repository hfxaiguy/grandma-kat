// The runner: grandma.knit(pattern, runtime) validates the definition and
// runtime, then executes the tree with an injected runtime (models, tools,
// memory, logger).

import { Scope, makeView, lookupChain, resetScopeIdCounter } from './memory.mjs';
import { callLlm, normalizeMessages } from './llm.mjs';
import { createLogger, createRunId, definitionId } from './logger.mjs';
import { unwrap, Tree, registerTree, registered } from './tree.mjs';
import { DEFAULT_MAX } from './markers.mjs';

export class PauseSignal {
  constructor(checkpointId, humanSlot, context) {
    this.checkpointId = checkpointId;
    this.humanSlot = humanSlot;
    this.context = context;
  }
}

/**
 * Thrown by a Goto() element. It unwinds to (and is caught by) the frame that
 * owns the named Human() slot — possibly several trees up — where the slot is
 * armed with the value (if any) and execution continues. An unhandled signal
 * (no such Human in scope) is a build error, surfaced by knit()/resume().
 */
export class GotoSignal {
  constructor(target, value) {
    this.target = target;
    this.value = value;
    this.applied = value !== undefined;
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
    // Per-run tool table: the runtime's tools. Registers are not installed
    // here — they live on the scopes that declare them (see resolveTool).
    tools: { ...(runtime.tools ?? {}) },
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
    if (err instanceof GotoSignal) {
      throw new KnitError(`Goto('${err.target}'): no Human() slot with that name in scope`);
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
        // scope_id is the slot's scope; execScopeId (when present) is the
        // scope that ran the child, which is where prev/raw entries belong.
        const execScope = c.execScopeId != null ? (scopes.get(c.execScopeId) ?? scope) : scope;
        scope.slots[c.child] = c.value;
        // A register memory patch is a slot write with no prev entry — it
        // does not come from the child loop.
        if (!c.patch) {
          execScope.prev.unshift({ childIndex: c.childIndex, name: c.child, value: c.value });
        }
      } else if (ev.kind === 'memory' && !c.update) {
        // Legacy rows: memory writes used to be logged as their own kind, and
        // old checkpoints must still resume from them.
        scope.slots[c.child] = c.value;
      } else if (ev.kind === 'check') {
        scope.error = c.pass ? undefined : c.feedback;
      } else if (ev.kind === 'human') {
        humanScopeId = ev.scope_id;
      }
    }

    // Detect iteration boundaries: when iteration increments, reset prev.
    // prev lives on the executing scope, which for memoryUpdate records is
    // execScopeId rather than the slot's scope_id.
    let lastIteration = new Map();
    for (const ev of events) {
      if (ev.seq > cp.seq) break;
      if (!ev.scope_id) continue;
      const prevScopeId = ev.content?.execScopeId ?? ev.scope_id;
      const prev = lastIteration.get(prevScopeId);
      if (prev !== undefined && ev.iteration > prev) {
        const scope = scopes.get(prevScopeId);
        if (scope) { scope.prev = []; scope.prevRaw = []; }
      }
      lastIteration.set(prevScopeId, ev.iteration);
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

    // Reconstruct completed Each() item results (keyed by the map's location
    // so a paused map can resume from the right item index with its prior
    // results intact). Each completed item logs a `map_item` event with its
    // index + value in the map child's parent scope.
    const mapItemResults = new Map();
    for (const ev of events) {
      if (ev.seq > cp.seq) break;
      if (ev.kind === 'map_item' && ev.content?.child != null) {
        const key = `${ev.branch_path ?? ''}/${ev.content.child}`;
        if (!mapItemResults.has(key)) mapItemResults.set(key, []);
        mapItemResults.get(key).push({ index: ev.content.index, value: ev.content.value });
      }
    }

    // Find max scope ID for counter reset.
    let maxScopeId = 0;
    for (const id of scopes.keys()) {
      if (id > maxScopeId) maxScopeId = id;
    }
    resetScopeIdCounter(maxScopeId + 1);

    // Host seeds (runtime.memory) are applied on the initial knit but are not
    // logged, so a resumed turn would otherwise lose them (workspace path,
    // tool guidance, host constants). Re-apply them to the root scope.
    if (rootScope) {
      for (const [k, v] of Object.entries(runtime.memory ?? {})) {
        rootScope.slots[k] = v;
      }
    }

    // Route the human's reply into the scopes. Keyed objects keep the
    // legacy per-slot API; a raw reply is filled into the paused slot that
    // the checkpoint's human event already named (see injectHumanInput).
    injectHumanInput(runtime.humanInput, scopes, humanEvent.content?.child ?? "main_input");

    // Build the resume stack. Each level resolves by name: the registry
    // holds the build the run started with (hosts reload it every turn),
    // and loadTree is the fallback for trees that were loaded dynamically
    // and are gone from the registry after a restart.
    const stack = [];
    for (let idx = 0; idx < treeNames.length; idx += 1) {
      stack.push({
        name: treeNames[idx],
        tree: await resolveTreeForResume(treeNames[idx], runtime),
        childIndex: 0,
        pass: 0,
        edgeCounters: new Map(),
        resumeChildStart: resumePositions[idx],
      });
    }

    // A prompt that led into a paused tree tool must replay its logged
    // round instead of calling the model again. Attach the logged llm_call
    // (plus the tool results it already produced) to the level whose resume
    // position points at that prompt child.
    for (let idx = 0; idx < stack.length - 1; idx += 1) {
      const level = stack[idx];
      const promptChild = level.tree?.children?.[level.resumeChildStart];
      if (!promptChild || promptChild.kind !== 'prompt') continue;
      const path = treeNames.slice(0, idx + 1).join('/');
      let llmCall = null;
      const doneResults = [];
      for (const ev of events) {
        if (ev.seq > cp.seq) break;
        if (ev.branch_path !== path) continue;
        if (ev.kind === 'llm_call' && ev.content?.child === promptChild.name) {
          llmCall = ev.content;
          doneResults.length = 0;
        } else if (llmCall && ev.kind === 'tool_result' && ev.content?.child === promptChild.name) {
          doneResults.push(ev.content);
        }
      }
      if (llmCall) level.replay = { llmCall, doneResults };
    }

    const resumeState = {
      scopes,
      current: scopes.get(humanScopeId),
      // One reconstructed scope per tree level (agent → knowledge → … →
      // the paused branch). Each keeps ITS OWN slots — ancestor scopes
      // (e.g. a parent loop's Memory() state) must survive the resume.
      // Fallback: a fresh scope when the chain doesn't match.
      levelScopes: (() => {
        // Walk up from the paused scope so each tree level gets the scope it
        // actually ran in. Matching children by parent order picks the wrong
        // sibling when several branches share a parent (e.g. a nested tree
        // under a classify branch), which loses the ancestor slots on resume.
        const chain = [];
        for (let s = scopes.get(humanScopeId); s; s = s.parent) chain.push(s);
        chain.reverse();
        const levels = chain.length ? chain : [rootScope];
        // Pad defensively if the event log is missing a level.
        while (levels.length < treeNames.length) {
          levels.push(new Scope(levels[levels.length - 1]));
        }
        return levels;
      })(),
      stack,
      stackIdx: 0,
      // Which slot is paused — carried so execTree's resume path can route
      // a raw human reply without the caller naming it.
      humanSlot: humanEvent.content?.child ?? "main_input",
      // Prior Each() items' results, keyed by `${branch_path}/${child}`.
      // Lets a paused map resume from the paused item instead of restarting.
      mapItemResults,
    };

    const exec = {
      runtime,
      logger,
      runId: cp.run_id,
      defId: definitionId(stack[0]?.tree ?? null),
      stack: [],
      seq: cp.seq,
      tools: { ...(runtime.tools ?? {}) },
    };
    // onHuman hooks fire before delivery: a hook may redirect (Goto) the reply
    // to an ancestor Human instead of the paused slot. A reply that exactly
    // equals a button value offered at the pause is a pressed button (an exact
    // answer) — it bypasses the hooks and is delivered.
    const offeredButtons = Array.isArray(humanEvent.content?.buttons) ? humanEvent.content.buttons : [];
    const isButton = typeof runtime.humanInput === 'string' && offeredButtons.includes(runtime.humanInput);
    const redirect = isButton ? null : await fireHumanHooks(exec, resumeState, runtime.humanInput);
    if (redirect) applyRedirect(resumeState, redirect);
    try {
      const outcome = await execTree(exec, stack[0].tree, rootScope, rootScope, resumeState);
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
      if (err instanceof GotoSignal) {
        throw new KnitError(`Goto('${err.target}'): no Human() slot with that name in scope`);
      }
      // Keep the checkpoint on failure: the pause is still the last good
      // state, so the same continuation can be retried (or the caller can
      // abandon it). Deleting here would strand a paused conversation.
      throw err;
    }
  } finally {
    if (!callerOwnsLogger) logger.close();
  }
}

// Route a human reply into the scope chain of a resumed run.
//
// Two forms:
//   keyed — an object like { approve: "yes" } (legacy API): every entry is
//           injected into every scope, so any slot name resolves.
//   raw   — a string or message array (preferred for new code): the reply
//           is filled into the single paused slot. The checkpoint's human
//           event already names that slot, so the caller never needs to
//           say which slot is waiting.
// `currentScope`, when given, receives the same injection directly (the
// restored tree root may not be in the scopes map yet).
function injectHumanInput(humanInput, scopes, pausedSlot, currentScope = null) {
  const keyed = humanInput !== null && typeof humanInput === "object" && !Array.isArray(humanInput);
  const targets = [...scopes.values()];
  if (currentScope) targets.push(currentScope);
  for (const s of targets) {
    if (keyed) {
      for (const [k, v] of Object.entries(humanInput)) {
        s.slots[k] = v;
        s.raw[k] = { content: v };
      }
    } else {
      s.slots[pausedSlot] = humanInput;
      s.raw[pausedSlot] = { content: humanInput };
    }
  }
}

// --- execution ---

async function execTree(exec, tree, scope, parentScope, resumeState = null) {
  // Registers are positional (see validateRuntime): every scope knows the
  // registers declared on its def, and resolution walks the scope chain (see
  // resolveTool). The before-use rule is enforced at knit() start, so the
  // table can be attached here whole. Re-attached on every entry, so resumed
  // levels get theirs back too.
  scope.registers = tree?.registers ?? null;
  // Hooks activate positionally: scope.hooks is the running set for this scope,
  // grown in execTreeInner as the child walk reaches each hook's point, and
  // inherited by descendants. An emit/pause before the hook cannot see it.
  scope.hooks = [];
  if (resumeState) {
    // Resume path: resume() already reconstructed a scope per tree level
    // with that level's own slots, so the scope passed in is correct —
    // no merging of the paused scope's slots into every level (that lost
    // ancestor scopes' state on deep-nested resumes).
    // Route the human's reply into the scopes in the continuation (same
    // semantics as resume(); the paused slot comes via resumeState).
    injectHumanInput(exec.runtime.humanInput, resumeState.scopes, resumeState.humanSlot, scope);
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
  // Declared inputs must resolve via the scope chain. For a static branch
  // the child scope is empty, so this is the parent chain; for a tree tool
  // the call args were seeded into the child scope first.
  if (!resumeState) {
    const optionalNeeds = new Set(tree.needsOptional ?? []);
    for (const need of tree.needs) {
      if (optionalNeeds.has(need)) continue; // declared but may be absent
      if (lookupChain(scope, need) === undefined) {
        throw new KnitError(`tree '${tree.name}' needs '${need}', but it does not resolve in scope`);
      }
    }
  }

  const state = exec.stack[exec.stack.length - 1];
  const view = makeView(scope);
  const resumeStart = state.resumeChildStart; // saved before consumed
  const savedResume = resumeState; // kept for passing to branch children

  for (;;) {
    // The resumed pass IS a pass: increment it even on resume so events
    // logged after a pause carry the same iteration as before it. Skipping
    // the increment logged fresh scopes as iteration 0 followed by their
    // records at iteration 1, which the resume-time iteration-boundary
    // heuristic then treated as a NEW pass and wiped their prev.
    state.pass++;
    if (!resumeState) {
      // Until() rewinds m.prev at the start of each pass (current-path log).
      // Never on the resumed pass — its prev was reconstructed from the log
      // and the paused subtree continues from it.
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

      // Positional like registers: a hook becomes active when the child walk
      // reaches its point, and stays active for this scope and descendants.
      if (!state.hookActivated) state.hookActivated = new Set();
      for (const h of tree.hooks ?? []) {
        if (h.position <= i && !state.hookActivated.has(h)) {
          state.hookActivated.add(h);
          scope.hooks.push({ ...h, home: scope });
        }
      }

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
      try {
      if (child.kind === 'branch') {
        // On resume, pass the resume state to the branch child that's
        // at the resume position so the inner tree can continue from its
        // saved position. stackIdx ensures each tree level reads the
        // right entry from the continuation.
        //
        // Guard: only descend with savedResume when there IS a deeper
        // level to resume into (levelScopes has an entry past stackIdx).
        // If the paused element was a leaf at THIS level (e.g. Human()
        // followed by a Branch()), resumeChildStart points at the next
        // sibling — which must run fresh, not consume a nested resume
        // entry it never had.
        const branchResume =
          resumeStart != null &&
          i === resumeStart &&
          savedResume !== null &&
          savedResume.levelScopes.length > savedResume.stackIdx
            ? savedResume
            : null;
        // The resumed level runs in its OWN reconstructed scope (with its
        // slots intact) — see resumeState.levelScopes. Only fresh branches
        // get a brand-new scope.
        const childScope = branchResume
          ? (branchResume.levelScopes[branchResume.stackIdx] ?? new Scope(scope))
          : new Scope(scope);
        if (!branchResume || childScope.parent !== scope) {
          logEvent(exec, 'scope_init', { scopeId: childScope.id, parentScopeId: scope.id }, childScope);
        }
        // A versioned From() carries a ref instead of a build-time tree:
        // resolve it from disk through the host loader, then run it exactly
        // like any imported branch (deferred ports work on resume too, since
        // the checkpoint's branch_path names the resolved internal tree).
        const branchTree =
          child.tree ?? (typeof child.ref === 'string' ? await loadNamedTree(exec.runtime, child.ref) : null);
        if (!branchTree) {
          throw new KnitError(`branch '${child.name}' has no tree (From() could not resolve)`);
        }
        // From('name', memory(fn)): seed the imported tree's own scope at
        // entry — an entry-time pulse, like Needs, so it is re-applied on
        // resume. A non-object return is ignored.
        if (typeof child.memory === 'function') {
          const patch = await callFn(
            child.memory,
            makeView(childScope),
            `memory fn of From('${branchTree.name ?? '?'}')`,
          );
          if (patch != null && typeof patch === 'object' && !Array.isArray(patch)) {
            for (const [key, value] of Object.entries(patch)) childScope.slots[key] = value;
          }
        }
        const out = await execTree(exec, branchTree, childScope, scope, branchResume);
        outcome = {
          value: out.value,
          record: { content: out.value ?? null, children: { ...childScope.raw } },
        };
      } else if (child.kind === 'prompt') {
        // On resume, a prompt that led into a paused tree tool replays its
        // logged round instead of calling the model again (same deeper-level
        // guard as branch children).
        const promptResume =
          resumeStart != null &&
          i === resumeStart &&
          savedResume !== null &&
          savedResume.levelScopes.length > savedResume.stackIdx
            ? savedResume
            : null;
        outcome = await execPrompt(exec, child, scope, promptResume);
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
        // On resume, a Each() that is (or contains) the paused element must
        // resume from the paused item rather than restart. Same guard as
        // branches: only descend with savedResume when a deeper level exists.
        const mapResume =
          resumeStart != null &&
          i === resumeStart &&
          savedResume !== null &&
          savedResume.levelScopes.length > savedResume.stackIdx
            ? savedResume
            : null;
        outcome = await execMap(exec, child, scope, mapResume);
      } else if (child.kind === 'human') {
        // An armed slot is a pending delivery (a filled Goto) — consume it
        // once and proceed instead of pausing. Slots are durable state; the
        // arm is the one-shot event, so a loop's rewind still waits.
        if (scope.armed && Object.prototype.hasOwnProperty.call(scope.armed, child.name)) {
          const value = scope.armed[child.name];
          delete scope.armed[child.name];
          scope.slots[child.name] = value;
          scope.raw[child.name] = { content: value };
          logEvent(exec, 'human', { child: child.name, delivered: true }, scope);
          outcome = { value, record: { content: value } };
        } else {
        const context = child.contextFn
          ? await callFn(child.contextFn, view, `human context of '${child.name}'`)
          : {};
        const offered = Array.isArray(exec.lastButtons) ? exec.lastButtons : [];
        exec.lastButtons = null;
        const humanSeq = logEvent(exec, 'human', { child: child.name, context, buttons: offered }, scope);
        // Emit context before pausing — bots only need onEmit to talk.
        if (Object.keys(context).length > 0 && typeof exec.runtime.onEmit === 'function') {
          await exec.runtime.onEmit(context);
        }
        // Compute per-entry resume positions. Each stack entry resumes at
        // the child that led to this tree level. The innermost entry
        // (current tree) resumes at i + 1 (past the Human() child).
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
        }
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
      } else if (child.kind === 'call') {
        // A Call() to a tree tool descends structurally — the same deeper
        // guard as branch children resumes a pause inside that subtree.
        const callResume =
          resumeStart != null &&
          i === resumeStart &&
          savedResume !== null &&
          savedResume.levelScopes.length > savedResume.stackIdx
            ? savedResume
            : null;
        outcome = await execCall(exec, child, scope, callResume);
      } else if (child.kind === 'goto') {
        const gview = makeView(scope);
        const value = child.valueFn
          ? await callFn(child.valueFn, gview, `goto value of '${child.name}'`)
          : undefined;
        logEvent(exec, 'flow', { type: 'goto-send', target: child.target, from: child.name }, scope);
        throw new GotoSignal(child.target, value);
      } else {
        outcome = await execCall(exec, child, scope);
      }
      record(exec, scope, i, child.name, outcome);
      i++;
      } catch (err) {
        // A Goto() unwinds to the frame that owns the target Human() slot.
        // Intermediate frames rethrow; this one arms the slot and jumps.
        if (err instanceof GotoSignal) {
          const targetIdx = tree.children.findIndex((c) => c.kind === 'human' && c.name === err.target);
          if (targetIdx !== -1) {
            logEvent(exec, 'flow', { type: 'goto', target: err.target, childIndex: targetIdx }, scope);
            rewind(scope, targetIdx);
            if (err.applied) {
              if (!scope.armed) scope.armed = Object.create(null);
              scope.armed[err.target] = err.value;
            }
            i = targetIdx;
            continue;
          }
        }
        throw err;
      }
    }

    // All children processed — no until looped back. Exit the tree.
    return exportOutcome(scope);
  }
}

async function execPrompt(exec, child, scope, promptResume = null) {
  const levelEntry = exec.stack[exec.stack.length - 1];
  const replay = promptResume ? (levelEntry?.replay ?? null) : null;
  if (promptResume && !replay) {
    throw new KnitError(
      `resume: no logged llm_call for prompt '${child.name}' — the checkpoint is missing replay data`,
    );
  }
  if (replay) levelEntry.replay = null;

  const view = makeView(scope);
  const auto = child.auto ?? null;
  const autoOn = auto?.disabled !== true;
  const bound = auto?.max ?? { count: DEFAULT_MAX, errFn: null };

  const record = {
    content: null, reasoning: null, toolCalls: [], toolResults: [], calls: [], model: null,
    rounds: 0, thread: [],
  };

  // Model + tool schemas, resolved at most once per invocation. A replayed
  // round needs neither until the loop reaches a fresh round.
  let call = null;
  const ensureCall = async () => {
    if (call) return call;
    const modelName = (await resolveInherited(exec, 'models', view)) ?? runtimeDefaultModel(exec);
    const modelEntry = exec.runtime.models?.[modelName];
    if (!modelEntry) {
      throw new KnitError(`model '${modelName}' (used by '${child.name}') not found in runtime models`);
    }
    const toolNames = child.options.tools ?? (await resolveInherited(exec, 'tools', view)) ?? [];
    const tools = toolNames.map((n) => {
      // Schemas come from whatever the name resolves to at THIS prompt's
      // scope: a register declared here (or on an ancestor) wins over a
      // runtime tool of the same name.
      const resolved = resolveTool(exec, scope, n);
      const spec = resolved?.kind === 'register' ? resolved.entry : resolved?.tool;
      return {
        type: 'function',
        function: {
          name: n,
          description: spec?.description ?? '',
          parameters: spec?.parameters ?? { type: 'object', properties: {} },
        },
      };
    });
    call = { modelName, modelEntry, tools, offered: new Set(toolNames) };
    return call;
  };

  // The prompt's local conversation: its messages, grown round by round and
  // saved on the record for the tree (and reconstructible from the log).
  let thread = [];
  let response = null;
  let rounds = 0;
  let pendingReplay = replay;

  if (replay) {
    // Resume path: the round already ran before the pause — rebuild its
    // record from the log (no second LLM call) and continue with the tool
    // call that paused inside a tree.
    const rc = replay.llmCall;
    response = { content: rc.content ?? '', reasoning: rc.reasoning ?? '', tool_calls: rc.toolCalls ?? null };
    thread = (rc.messages ?? []).map((m) => ({ ...m }));
    rounds = 1;
    record.model = rc.model ?? null;
    for (const tc of response.tool_calls ?? []) {
      record.toolCalls.push({ id: tc.id, name: tc.function?.name, arguments: tc.function?.arguments });
    }
    record.calls.push({
      round: 1,
      messages: thread.map((m) => ({ ...m })),
      response: { content: response.content, reasoning: response.reasoning, tool_calls: response.tool_calls ?? null },
    });
    for (const tr of replay.doneResults) {
      record.toolResults.push({ name: tr.tool, result: tr.result, isError: tr.isError === true });
    }
  } else {
    // Fresh path: the prompt value opens the local thread.
    const value = typeof child.prompt === 'function'
      ? await callFn(child.prompt, view, `prompt fn of '${child.name}'`)
      : child.prompt;
    thread = normalizeMessages(value);
  }

  // One tool call: positional tool hooks → resolve + execute (+ register
  // settle) → positional tool hooks. `resumeState` marks the call that paused
  // inside a tree tool: its before-hook already ran pre-pause, so it is
  // skipped here.
  const runCall = async (tc, resumeState) => {
    const name = tc.function?.name;
    const parsed = (() => { try { return JSON.parse(tc.function.arguments); } catch { return tc.function.arguments; } })();
    let ref = { id: tc.id, name, args: parsed };
    if (!resumeState) ref = await fireToolHooks(exec, scope, 'Before', ref);

    let result;
    let isError = false;
    try {
      // Tools are scoped: the prompt's Tools() list (per-prompt options or
      // inherited) is the whole offer, and a call outside it is refused
      // before anything executes — a hallucinated or leaked name cannot
      // reach the registry.
      const c = await ensureCall();
      if (!c.offered.has(ref.name)) {
        throw new KnitError(`tool '${ref.name}' is not offered to prompt '${child.name}' — it must resolve from that prompt's Tools() scope`);
      }
      const resolved = resolveTool(exec, scope, ref.name);
      if (!resolved) throw new KnitError(`unknown tool '${ref.name}'`);
      if (resolved.kind === 'tool' && resolved.tool.tree !== undefined) {
        // A tree tool: run the tree in a child scope seeded with the call
        // args; its exported value is the tool result. A Human() inside
        // pauses the whole run, and on resume the paused call receives the
        // resume state so the subtree continues exactly where it stopped.
        result = await runTreeTool(exec, ref.name, resolved.tool, ref.args, scope, resumeState);
      } else {
        // A register gets the call-site view and its declared tools; its
        // `memory` patch is applied and stripped (the stored result is
        // { value }). Registry tools ignore the extra argument.
        result = resolved.kind === 'register'
          ? await callRegister(exec, resolved, ref.args, scope)
          : await resolved.tool.execute(ref.args, { view: makeView(scope), context: exec.runtime.context });
        result = settleRegisterResult(exec, scope, resolved, result);
      }
      // Tools may return error-shaped results instead of throwing.
      if (isErrorResult(result)) isError = true;
    } catch (err) {
      // A pause inside a tree tool is not a tool error — it suspends the
      // whole run and must reach knit() unchanged.
      if (err instanceof PauseSignal) throw err;
      isError = true;
      result = `error: ${err.message}`;
    }

    const after = await fireToolHooks(exec, scope, 'After', { ...ref, result, isError });
    return { id: ref.id, name: ref.name, args: ref.args, result: after.result, isError: Boolean(after.isError) };
  };

  // The auto tool loop: call the model, execute every tool call, feed the
  // results back on the local thread, and call again — until a round comes
  // back without tool calls. `disableAuto()` stops after one round;
  // `max(n)` bounds the rounds (exhaustion throws).
  for (;;) {
    if (!response) {
      const c = await ensureCall();
      record.model = c.modelName;
      try {
        response = await callLlm(c.modelEntry, thread, { tools: c.tools });
      } catch (err) {
        // Record failed calls so they are diagnosable from the log DB — a
        // thrown LLM error otherwise leaves no trace. Rethrow; the tree still
        // decides how to recover.
        logEvent(exec, 'llm_error', {
          child: child.name,
          round: rounds + 1,
          model: c.modelName,
          messages: thread,
          error: err instanceof Error ? err.message : String(err),
        }, scope);
        throw err;
      }
      rounds += 1;
      record.calls.push({
        round: rounds,
        messages: thread.map((m) => ({ ...m })),
        response: { content: response.content, reasoning: response.reasoning, tool_calls: response.tool_calls ?? null },
      });
      logEvent(exec, 'llm_call', {
        child: child.name, round: rounds, model: c.modelName,
        messages: thread,
        content: response.content, reasoning: response.reasoning, toolCalls: response.tool_calls ?? null,
      }, scope);
    }

    const toolCalls = response.tool_calls ?? [];
    if (!toolCalls.length) {
      // Text-only response — the loop is done; the final assistant message
      // closes the saved thread.
      record.content = response.content;
      record.reasoning = response.reasoning || null;
      thread.push({ role: 'assistant', content: response.content ?? '' });
      break;
    }

    // In replay mode the calls before the paused one already ran and are
    // already logged (`doneResults`) — copy them instead of re-executing;
    // the paused call (index === doneResults.length) descends into its
    // subtree with the resume state; later calls run fresh.
    const replayState = pendingReplay;
    pendingReplay = null;
    const skipped = replayState ? replayState.doneResults.length : 0;
    const wireCalls = toolCalls.map((tc) => ({
      id: tc.id,
      type: 'function',
      function: { name: tc.function?.name, arguments: tc.function?.arguments },
    }));

    for (let ci = 0; ci < toolCalls.length; ci++) {
      if (ci < skipped) continue;
      const resumeState = replayState && ci === skipped ? promptResume : null;
      const out = await runCall(toolCalls[ci], resumeState);
      wireCalls[ci].function.name = out.name;
      wireCalls[ci].function.arguments = typeof out.args === 'string' ? out.args : JSON.stringify(out.args ?? {});
      if (!replayState) {
        record.toolCalls.push({ id: out.id, name: out.name, arguments: wireCalls[ci].function.arguments });
      }
      record.toolResults.push({ name: out.name, result: out.result, isError: out.isError });
      logEvent(exec, 'tool_result', {
        child: child.name, round: rounds, tool: out.name, args: out.args, result: out.result, isError: out.isError,
      }, scope);
    }

    // Append the round's exchange to the local thread: the assistant
    // tool_calls message, then one tool message per call. Final (post-hook)
    // values, so hook rewrites are what the model sees.
    thread.push({ role: 'assistant', content: response.content || null, tool_calls: wireCalls });
    const base = record.toolResults.length - toolCalls.length;
    for (let ci = 0; ci < toolCalls.length; ci++) {
      const tr = record.toolResults[base + ci];
      thread.push({
        role: 'tool',
        tool_call_id: toolCalls[ci].id,
        content: typeof tr.result === 'string' ? tr.result : JSON.stringify(tr.result ?? ''),
      });
    }

    if (!autoOn) {
      // disableAuto(): exactly one round — results are recorded, never fed
      // back. The value is the text returned alongside the calls.
      record.content = response.content || '';
      record.reasoning = response.reasoning || null;
      break;
    }

    if (rounds >= bound.count) {
      const last = toolCalls.map((tc) => tc.function?.name).filter(Boolean).join(', ');
      const message = await exhaustionMessage(bound, view,
        `auto tool loop exhausted after ${rounds} round(s) — the model kept calling tools (last: ${last})`);
      throw new KnitError(`prompt '${child.name}': ${message}`);
    }

    response = null; // next round: a fresh model call on the grown thread
  }

  record.rounds = rounds;
  record.thread = thread;
  // The value is the final round's text (the tree reads tool results via
  // m.raw.prev[0].toolResults and the whole exchange via .thread).
  return { value: record.content, record };
}

async function execCall(exec, child, scope, callResume = null) {
  const view = makeView(scope);
  const args = typeof child.argsFn === 'function'
    ? await callFn(child.argsFn, view, `args fn of '${child.name}'`)
    : child.argsFn;
  const resolved = resolveTool(exec, scope, child.tool);
  if (!resolved) throw new KnitError(`unknown tool '${child.tool}' (called from '${child.name}')`);
  if (resolved.kind === 'tool' && resolved.tool.tree !== undefined) {
    // A Call() to a tree tool runs the subtree in place — the argument is
    // the tree's name (a registered/dynamically loaded tree) or a def. A
    // pause inside resumes through the structural branch machinery.
    const result = await runTreeTool(exec, child.tool, resolved.tool, args, scope, callResume);
    logEvent(exec, 'tool_call', { child: child.name, tool: child.tool, args, result }, scope);
    return { value: result, record: { content: result, tool: child.tool, args, toolResults: [result] } };
  }
  // Result may be a string or a plain JSON object; either is stored in the
  // branch slot verbatim so patterns can consume structured output directly.
  // A register also gets the call-site view as `m` and its declared tools;
  // its `memory` patch is applied and stripped (the stored result is
  // { value } / { error }).
  let result;
  try {
    result = resolved.kind === 'register'
      ? await callRegister(exec, resolved, args, scope)
      : await resolved.tool.execute(args, { view, context: exec.runtime.context });
    result = settleRegisterResult(exec, scope, resolved, result);
  } catch (err) {
    // A thrown tool error leaves no value to route — log it for diagnosis.
    logEvent(exec, 'tool_error', {
      child: child.name,
      tool: child.tool,
      args,
      error: err instanceof Error ? err.message : String(err),
    }, scope);
    throw err;
  }
  logEvent(exec, 'tool_call', { child: child.name, tool: child.tool, args, result }, scope);
  return { value: result, record: { content: result, tool: child.tool, args, toolResults: [result] } };
}

/**
 * Run a tree tool: the subtree executes like a static branch — child scope,
 * seeded call args, exported value as the result. On resume the
 * reconstructed level scope is reused and only missing seed slots are
 * filled, so a pause inside the subtree continues in place.
 */
async function runTreeTool(exec, toolName, tool, args, scope, resumeState = null) {
  const def = await resolveTreeTool(exec, toolName, tool.tree);
  const childScope = resumeState
    ? (resumeState.levelScopes[resumeState.stackIdx] ?? new Scope(scope))
    : new Scope(scope);
  if (!resumeState || childScope.parent !== scope) {
    logEvent(exec, 'scope_init', { scopeId: childScope.id, parentScopeId: scope.id }, childScope);
  }
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    for (const [k, v] of Object.entries(args)) {
      if (!(k in childScope.slots)) childScope.slots[k] = v;
    }
  }
  const out = await execTree(exec, def, childScope, scope, resumeState);
  return out.value ?? null;
}

/** Resolve a tree tool's spec (a name or a def/builder) to a definition. */
async function resolveTreeTool(exec, toolName, spec) {
  let def;
  if (typeof spec === 'string' && spec.length > 0) {
    def = await loadNamedTree(exec.runtime, spec);
  } else if (spec && typeof spec === 'object') {
    def = unwrap(spec);
  } else {
    throw new KnitError(`tool '${toolName}': tree must be a registered name or a tree definition`);
  }
  if (def.name == null) {
    def.name = typeof spec === 'string' ? spec : toolName;
    registerTree(def);
  }
  return def;
}

/**
 * Resolve a tree by name: the host loader first (workspace trees that were
 * never built into this process), then the build-time registry. A loader
 * that returns null/undefined or throws falls through to the registry, so
 * statically built trees keep working without a loader.
 */
async function loadNamedTree(runtime, name) {
  const loadTree = runtime?.loadTree;
  const loadError = { message: null };
  if (typeof loadTree === 'function') {
    let loaded = null;
    try {
      loaded = await loadTree(name);
    } catch (err) {
      loadError.message = err instanceof Error ? err.message : String(err);
      loaded = null;
    }
    if (loaded != null) {
      const def = unwrap(loaded);
      if (def.name == null) def.name = name;
      if (Array.isArray(def.children)) autoname(def);
      registerTree(def);
      return def;
    }
  }
  if (Tree.has(name)) return registered(name);
  const detail = loadError.message ? `: ${loadError.message}` : '';
  throw new KnitError(`tree '${name}' is not registered and loadTree did not provide it${detail}`);
}

/** Resume-time resolution: the registry is authoritative (hosts reload it), loadTree is the restart fallback. */
async function resolveTreeForResume(name, runtime) {
  if (Tree.has(name)) return registered(name);
  const loadTree = runtime?.loadTree;
  if (typeof loadTree === 'function') {
    try {
      const loaded = await loadTree(name);
      if (loaded != null) {
        const def = unwrap(loaded);
        if (def.name == null) def.name = name;
        if (Array.isArray(def.children)) autoname(def);
        registerTree(def);
        return def;
      }
    } catch { /* fall through to the error below */ }
  }
  throw new KnitError(`cannot resume: tree '${name}' is not registered (call .name() to register)`);
}

// Calls runtime.onEmit(value) then continues. Then fires the tree's own
// `onEmit` hooks (positional declarations, innermost scope first). Hooks do
// not nest: a hook's own emits must not re-fire hooks.
async function execEmit(exec, child, scope) {
  const view = makeView(scope);
  const value = await callFn(child.fn, view, `emit fn of '${child.name}'`);
  logEvent(exec, 'emit', { child: child.name, value }, scope);
  // Remember the button values this emit offered: a reply that exactly equals
  // one is a pressed button (a confirm), not free text — see the Human() pause.
  if (value && typeof value === 'object' && Array.isArray(value.buttons) && value.buttons.length) {
    exec.lastButtons = value.buttons.map((b) => b && b.value).filter((v) => typeof v === 'string');
  }
  if (typeof exec.runtime.onEmit === 'function') {
    await exec.runtime.onEmit(value);
  }
  if ((exec.inHook ?? 0) === 0) {
    for (const hook of resolveHooks(scope, 'emit')) {
      await runHook(exec, hook, value);
    }
  }
}

/** Hooks of `trigger` visible from `scope`, innermost scope first. */
function resolveHooks(scope, trigger) {
  const out = [];
  for (let s = scope; s; s = s.parent) {
    for (const h of s.hooks ?? []) {
      if (h.trigger === trigger) out.push(h);
    }
  }
  return out;
}

/**
 * Run the positional tool hooks (`Hook(toolBefore()/toolAfter(), …)`) visible
 * from `scope`, innermost first. Each hook tree runs in its declarer's scope,
 * paused-free, with the call seeded as `call`. A `toolBefore` hook's Return is
 * spread into the call's args; a `toolAfter` hook's Return is spread over the
 * call ref (so it can replace `result` / set `isError`). A null/undefined
 * Return leaves the call unchanged; a throw aborts the run. Tool hooks never
 * nest (exec.inHook guards them against hooking their own calls).
 */
async function fireToolHooks(exec, scope, phase, ref) {
  if ((exec.inHook ?? 0) > 0) return ref;
  const trigger = phase === 'After' ? 'toolAfter' : 'toolBefore';
  let current = ref;
  for (const hook of resolveHooks(scope, trigger)) {
    const out = await runHook(exec, hook, current, { slot: 'call', detail: { phase, tool: current.name } });
    current = applyToolHookReturn(current, out, phase);
  }
  return current;
}

/** Merge a tool hook's Return into the call: args for `toolBefore`, the whole
 *  ref for `toolAfter`. */
function applyToolHookReturn(current, out, phase) {
  if (out == null) return current;
  if (phase === 'Before') {
    const patch = typeof out === 'object' && !Array.isArray(out) ? out : {};
    return { ...current, args: { ...(current.args ?? {}), ...patch } };
  }
  if (typeof out === 'object' && !Array.isArray(out)) return { ...current, ...out };
  return { ...current, result: out };
}

/**
 * Run one hook tree in its declarer's scope. The event value is seeded under
 * `opts.slot` (default `input`); a `when(cond)` gate is evaluated with that
 * value in scope and skips the tree when false. A hook must be pause-free
 * (checked once per run) and does not nest.
 */
async function runHook(exec, hook, value, opts = {}) {
  const tree = hook.tree ?? (hook.ref ? await loadNamedTree(exec.runtime, hook.ref) : null);
  if (!tree) throw new KnitError('Hook(): the hook tree did not resolve');
  if (!exec.hookChecked) exec.hookChecked = new Set();
  if (!exec.hookChecked.has(tree)) {
    assertPauseFree(tree);
    exec.hookChecked.add(tree);
  }
  const home = hook.home ?? null;
  const hookScope = new Scope(home);
  const slot = opts.slot ?? 'input';
  if (value !== undefined) hookScope.slots[slot] = value;
  if (hook.gate != null) {
    const ok = await callFn(hook.gate, makeView(hookScope), `gate of hook '${tree.name ?? '?'}'`);
    if (!ok) return null;
  }
  logEvent(exec, 'hook', {
    trigger: hook.trigger,
    hook: tree.name ?? hook.ref ?? null,
    slot,
    ...(opts.detail ?? {}),
  }, hookScope);
  exec.inHook = (exec.inHook ?? 0) + 1;
  try {
    const out = await execTree(exec, tree, hookScope, home, null);
    return out.value;
  } finally {
    exec.inHook -= 1;
  }
}

/** A hook tree that pauses would strand the run inside the hook — build error. */
function assertPauseFree(tree, seen = new Set()) {
  if (!tree || seen.has(tree)) return;
  seen.add(tree);
  for (const child of tree.children ?? []) {
    if (child.kind === 'human') {
      throw new KnitError(`Hook(): tree '${tree.name ?? '?'}' must be pause-free (it has Human('${child.name}'))`);
    }
    if ((child.kind === 'branch' || child.kind === 'map') && child.tree) assertPauseFree(child.tree, seen);
  }
  for (const h of tree.hooks ?? []) if (h.tree) assertPauseFree(h.tree, seen);
}

/**
 * Fire the onHuman hooks visible from the paused scope chain, innermost scope
 * first, before the reply is delivered. A hook that redirects does so by
 * executing Goto(...): the signal is returned so the caller can re-target the
 * resume; `deliver`/`defer` and side effects are otherwise ignored. Returns the
 * GotoSignal (a redirect) or null.
 */
async function fireHumanHooks(exec, resumeState, value) {
  const { stack, levelScopes } = resumeState;
  for (let idx = stack.length - 1; idx >= 0; idx -= 1) {
    const tree = stack[idx]?.tree;
    const home = levelScopes[idx];
    for (const hook of tree?.hooks ?? []) {
      if (hook.trigger !== 'human') continue;
      try {
        await runHook(exec, { ...hook, home }, value);
      } catch (err) {
        if (err instanceof GotoSignal) return err;
        throw err;
      }
    }
  }
  return null;
}

/**
 * Re-target a resume to the Human slot named by a redirecting Goto: drop the
 * frames below the owning level, resume that level at the Human child, and arm
 * the slot with the redirect value so it consumes instead of pausing.
 */
function applyRedirect(resumeState, signal) {
  const { stack } = resumeState;
  let level = -1;
  for (let idx = stack.length - 1; idx >= 0; idx -= 1) {
    const children = stack[idx]?.tree?.children ?? [];
    if (children.some((c) => c.kind === 'human' && c.name === signal.target)) { level = idx; break; }
  }
  if (level === -1) {
    throw new KnitError(`Goto('${signal.target}'): no Human() slot with that name in scope`);
  }
  const targetIdx = stack[level].tree.children.findIndex((c) => c.kind === 'human' && c.name === signal.target);
  resumeState.stack = stack.slice(0, level + 1);
  resumeState.levelScopes = resumeState.levelScopes.slice(0, level + 1);
  resumeState.stack[level].resumeChildStart = targetIdx;
  resumeState.humanSlot = signal.target;
  if (signal.applied) {
    const scope = resumeState.levelScopes[level];
    if (!scope.armed) scope.armed = Object.create(null);
    scope.armed[signal.target] = signal.value;
  }
}

// Writes to a named memory slot AND produces m.prev output (like a prompt).
async function execMemory(exec, child, scope) {
  const view = makeView(scope);
  const current = scope.slots[child.name]; // read before write (may be undefined)
  const value = await callFn(child.fn, view, `memory fn of '${child.name}'`, current);
  // The write itself is logged once, by record(), with op 'memory'.
  return { value, record: { content: value }, _op: 'memory' };
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
    throw new KnitError(`Memory(update(), '${child.name}'): slot '${child.name}' does not exist in the scope chain — declare it with Memory() first or inject it`);
  }
  const current = target.slots[child.name];
  const value = await callFn(child.fn, view, `memoryUpdate fn of '${child.name}'`, current);
  // The write is logged once, by record(), with op 'memoryUpdate' and
  // execScopeId pointing at the scope that ran this child.
  return { value, record: { content: value }, _slotScope: target, _op: 'memoryUpdate' };
}

// --- scoped registers ------------------------------------------------

// Resolve a tool name at a call site: the nearest register on the execution
// scope chain wins, then the runtime's tool table (the bottom layer).
function resolveTool(exec, scope, name) {
  for (let s = scope; s; s = s.parent) {
    const entry = (s.registers ?? []).find((r) => r.name === name);
    if (entry) return { kind: 'register', entry, declaringScope: s };
  }
  const tool = exec.tools[name];
  return tool ? { kind: 'tool', tool } : null;
}

// Error-shaped results follow the tool conventions; shared by the call sites
// and the nested register calls.
function isErrorResult(result) {
  if (result && typeof result === 'object' && 'error' in result) return true;
  return typeof result === 'string' && result.toLowerCase().startsWith('error');
}

// The `tools` handle a register body receives: its declared calls resolved on
// the register's home path (its declaring scope chain's registers, then the
// runtime's tools). Every call is logged like any other tool result.
function registerToolSet(exec, entry, declaringScope) {
  const handle = {};
  for (const name of entry.calls ?? []) {
    handle[name] = async (args) => {
      const target = resolveTool(exec, declaringScope, name);
      if (!target) {
        throw new KnitError(`register '${entry.name}': calls('${name}') is not resolvable on its home path`);
      }
      const value = target.kind === 'register'
        ? await callFn(target.entry.fn, makeView(declaringScope), `register '${name}'`, args ?? {}, registerToolSet(exec, target.entry, target.declaringScope))
        : await target.tool.execute(args ?? {}, { view: makeView(declaringScope), context: exec.runtime.context });
      logEvent(exec, 'tool_result', {
        tool: name,
        args: args ?? {},
        result: value,
        isError: isErrorResult(value),
        via: entry.name,
      }, declaringScope);
      return value;
    };
  }
  return Object.freeze(handle);
}

// Run a register body: the call-site view as `m`, plus the declared tools.
function callRegister(exec, resolved, args, callSiteScope) {
  return callFn(
    resolved.entry.fn,
    makeView(callSiteScope),
    `register '${resolved.entry.name}'`,
    args,
    registerToolSet(exec, resolved.entry, resolved.declaringScope),
    // The host context (runtime.context), so a register body can reach things
    // the host owns — secrets, clients — without exposing an app tool.
    exec.runtime.context,
  );
}

// A register result may carry a `memory` patch: write it as memory-update
// records (same scope resolution as Memory(update(), …)) and strip it — the
// stored tool result is { value } / { error }. A failed body skips the patch
// but still loses the memory key.
function settleRegisterResult(exec, scope, resolved, result) {
  if (resolved.kind !== 'register') return result;
  if (!result || typeof result !== 'object' || Array.isArray(result) || !('memory' in result)) return result;
  const patch = result.memory;
  if (!('error' in result) && patch && typeof patch === 'object' && !Array.isArray(patch)) {
    applyMemoryPatch(exec, scope, patch, resolved.entry.name);
  }
  const { memory, ...rest } = result;
  return rest;
}

// Each slot write lands in the scope that declares the slot; logged as
// `record` rows with op 'memoryUpdate' and patch: true (resume writes the
// slot without pushing a prev entry).
function applyMemoryPatch(exec, scope, patch, toolName) {
  for (const [name, value] of Object.entries(patch)) {
    let target = scope;
    while (target && !Object.prototype.hasOwnProperty.call(target.slots, name)) target = target.parent;
    if (!target) {
      throw new KnitError(`register '${toolName}': memory patch slot '${name}' does not exist in the scope chain — declare it with Memory() first`);
    }
    target.slots[name] = value;
    logEvent(exec, 'record', {
      child: name,
      childIndex: null,
      patch: true,
      value,
      op: 'memoryUpdate',
      ...(target !== scope ? { execScopeId: scope.id } : {}),
    }, target);
  }
}

// Runs a subtree per element of an array. Each invocation gets `m.item`
// injected. Results are collected into an array in the parent scope.
//
// `resume` (non-null when a Human() paused inside one of the item
// subtrees) carries the mid-execution state so the map resumes at the
// paused item instead of restarting: prior items' results are replayed from
// the log, and the paused item continues from its saved child position.
async function execMap(exec, child, scope, resume = null) {
  const view = makeView(scope);
  const items = await callFn(child.arrayFn, view, `array fn of '${child.name}'`);

  if (!Array.isArray(items) || items.length === 0) {
    const empty = [];
    logEvent(exec, 'map', { child: child.name, count: 0 }, scope);
    return { value: empty, record: { content: empty } };
  }

  // Reconstruct prior items and the paused item index from the log when
  // resuming. The paused item's subtree reaches here with the map tree as
  // the top stack frame (stackIdx already advanced past this level).
  // The key mirrors resume(): `${branch_path}/${child}` where branch_path
  // is this map's parent path.
  const mapKey = `${exec.stack.map((s) => s.name).join('/')}/${child.name}`;
  const prior = resume
    ? (resume.mapItemResults?.get(mapKey) ?? [])
    : [];

  // Completed prior items' results, in index order (for resuming mid-map).
  // These subtrees already ran before the pause; replay their values without
  // re-executing them. The paused item (index === prior.length) is the first
  // one whose subtree hasn't completed.
  const completed = new Map();
  for (const p of prior) completed.set(p.index, p.value);

  const results = [];
  for (let idx = 0; idx < items.length; idx++) {
    const pausedHere = resume != null && idx === prior.length;

    if (resume != null && !pausedHere && completed.has(idx)) {
      // Already done before the pause — replay its recorded value.
      results.push(completed.get(idx));
      continue;
    }

    // The paused item reuses the scope reconstructed for it (with its slots
    // and the human reply intact) rather than a brand-new one. Its subtree
    // then resumes from the saved child position via resumeChildStart.
    const itemScope = pausedHere
      ? (resume.levelScopes[resume.stackIdx] ?? new Scope(scope))
      : new Scope(scope);
    itemScope.slots.item = items[idx];
    if (!pausedHere) {
      logEvent(exec, 'scope_init', { scopeId: itemScope.id, parentScopeId: scope.id }, itemScope);
    }
    const out = pausedHere
      ? await execTree(exec, child.tree, itemScope, scope, resume)
      : await execTree(exec, child.tree, itemScope, scope);
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
  // ONE row per scope write. `op` says what kind of write it was ("set" for
  // prompt/branch/call results, "memory"/"memoryUpdate" for slot writes), and
  // execScopeId is only present when the value lands in a different scope than
  // the one that ran the child (memoryUpdate) — resume uses it to push `prev`
  // on the executing scope, not the slot's.
  logEvent(exec, 'record', {
    child: name,
    childIndex,
    value: outcome.value,
    op: outcome._op ?? 'set',
    ...(slotScope !== scope ? { execScopeId: scope.id } : {}),
  }, slotScope);
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
  throw new KnitError('no model resolved (no Model() anywhere and no runtime default)');
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
// A branch/map subtree may be unnamed — it takes its attaching child's name
// (for a branch that's the auto name, for a map the collection name) and is
// registered so resume() can rebuild the level from the branch_path.
function autoname(tree) {
  tree.children.forEach((child, idx) => {
    if (child.name == null) child.name = `${tree.name}#${idx + 1}`;
    if (child.kind === 'branch' || child.kind === 'map') {
      // A versioned From() is a deferred port: its tree is resolved from
      // disk at run time, so there is nothing to auto-name or register now.
      if (!child.tree) return;
      if (child.tree.name == null) {
        child.tree.name = child.name;
        registerTree(child.tree);
      }
      // A named subtree reused across parents keeps one identity; the
      // branch child follows it so results land under the same slot name.
      if (child.kind === 'branch') child.name = child.tree.name;
      autoname(child.tree);
    }
  });
}

function validateTree(tree, warnings) {
  if (tree.name == null) {
    throw new KnitError('every tree needs a name (call .name() first)');
  }
  if (tree.children.length === 0) {
    throw new KnitError(`tree '${tree.name}' has zero children — a named tree with no children is a build error`);
  }

  // KNOWN FALSE POSITIVE (potential fix, not yet done): a `Memory("messages", ...)`
  // followed by `Memory(update(), "messages", ...)` in the same tree triggers this
  // warning, but that pairing is idiomatic (`Memory()` seeds the slot,
  // `Memory(update(), )` appends to it). See tests/runner.test.mjs (memoryUpdate
  // idiom) and AGENTS.md. Potential fix: when the duplicate pair is a
  // `Memory()` immediately followed by a `Memory(update(), )` of the same name,
  // skip the warning instead of pushing it.
  const seen = new Set();
  for (const child of tree.children) {
    if (seen.has(child.name)) {
      warnings.push(`tree '${tree.name}' has duplicate child name '${child.name}' — the second overwrites the first's memory slot`);
    }
    seen.add(child.name);
    if (child.kind === 'branch' && child.tree) validateTree(child.tree, warnings);
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
    const optionalNeeds = new Set(t.needsOptional ?? []);
    for (const need of t.needs) {
      if (optionalNeeds.has(need)) continue; // declared but may be absent
      if (need.includes('#')) {
        warnings.push(`tree '${t.name}' needs auto-named slot '${need}' — give that child an explicit name ("if you reference it, you name it")`);
      }
      if (!produced.has(need) && !injected.has(need)) {
        throw new KnitError(`tree '${t.name}' needs '${need}', but no branch produces it and it is not in the injected memory`);
      }
    }
    for (const child of t.children) {
      // A From('name', memory(fn)) seed may satisfy any slot its subtree
      // needs — the keys are only known at run time, so the static check
      // skips attach points that carry a seed (the runtime check applies).
      if (child.kind === 'branch' && !child.memory && child.tree) walk(child.tree);
    }
  };
  walk(tree);
}

function collectNames(tree, set) {
  set.add(tree.name);
  for (const child of tree.children) {
    set.add(child.name);
    if (child.kind === 'branch' && child.tree) collectNames(child.tree, set);
    if (child.kind === 'map') collectNames(child.tree, set);
  }
}

// --- inline tool registers (`Register()`) ---

// Registers are positional declarations: a register is usable from its
// point in the child sequence onward (a reference before it is a build
// error — see validateRuntime) and lexically scoped — visible to its def's
// whole subtree, overridable by a child, invisible to the parent and to
// siblings. Within a scope, resolution must be unambiguous: duplicates on
// ONE def are a build error.

function validateRuntime(def, runtime) {
  // Reserved framework keys may not be injected as root memory.
  for (const k of Object.keys(runtime.memory ?? {})) {
    if (RESERVED_MEMORY_KEYS.has(k)) {
      throw new KnitError(`injected memory key '${k}' is reserved by the framework (${[...RESERVED_MEMORY_KEYS].join(', ')})`);
    }
  }

  // Every referenced model name must exist in the runtime models.
  const modelRefs = new Set();
  const tools = runtime.tools ?? {};
  const problems = [];
  const registerNames = new Set();

  // References resolve against the registers visible on their ancestor path
  // (a register is visible to its def's whole subtree) and the runtime's
  // tools at the bottom. `Tools()` schemas and `Call()` steps resolve at
  // their node's scope; a register's `calls(...)` resolve on its home path.
  const checkRuntimeTool = (name, path) => {
    const entry = tools[name];
    if (!entry) return;
    const hasExecute = typeof entry.execute === 'function';
    const hasTree = entry.tree !== undefined;
    if (hasExecute && hasTree) {
      throw new KnitError(`tool '${name}' (${path}) declares both execute and tree — give it one implementation`);
    }
    if (!hasExecute && !hasTree) {
      throw new KnitError(`tool '${name}' (${path}) needs execute() or a tree`);
    }
  };

  const walkTree = (t, path, visible, pendingAncestors = new Map()) => {
    // Registers are positional: each becomes available when the child walk
    // reaches its point, so a reference before the declaration is a build
    // error. `visible` holds the ancestor registers whose points were already
    // crossed before this subtree was entered; `pendingAncestors` names the
    // ancestor registers declared later, so errors can say so.
    const active = new Map(visible);
    const declared = new Map();
    const seen = new Set();
    for (const entry of t.registers ?? []) {
      if (seen.has(entry.name)) {
        problems.push(`${path}: duplicate Register('${entry.name}') on one tree`);
      }
      seen.add(entry.name);
      declared.set(entry.name, entry);
      registerNames.add(entry.name);
    }

    let at = 0; // the current point: the index of the next child to run
    const later = (n) =>
      (declared.has(n) && declared.get(n).position > at) || pendingAncestors.has(n);
    const beforePoint = (n, usedBy) => {
      const suffix = usedBy ? ` (from '${usedBy}')` : '';
      if (later(n)) {
        problems.push(`${path} uses tool '${n}'${suffix} before its Register(...) point — declare it first`);
        return true;
      }
      return false;
    };

    const checkCalls = (entry) => {
      for (const n of entry.calls ?? []) {
        const hit = active.get(n) ?? (tools[n] ? { kind: 'tool', tool: tools[n] } : null);
        if (!hit) {
          if (!beforePoint(n)) {
            problems.push(`${path}: Register('${entry.name}') calls('${n}') is not resolvable on its home path`);
          }
          continue;
        }
        if (hit.kind === 'tool' && hit.tool.tree !== undefined) {
          problems.push(`${path}: Register('${entry.name}') calls('${n}') resolves to a tree tool — bodies may only call function tools`);
        } else if (hit.kind === 'tool') {
          checkRuntimeTool(n, path);
        }
      }
    };

    const checkName = (n, usedBy) => {
      if (active.has(n)) return;
      if (tools[n]) { checkRuntimeTool(n, path); return; }
      if (!beforePoint(n, usedBy)) {
        problems.push(`${path} references unknown tool '${n}'${usedBy ? ` (called from '${usedBy}')` : ''}`);
      }
    };

    // Walk children in order, activating registers and tool rules at their
    // points, so every reference resolves against what is declared so far.
    const pendingRegisters = [...(t.registers ?? [])];
    const pendingRules = [...t.tools];
    const activate = (i) => {
      at = i;
      while (pendingRegisters.length && pendingRegisters[0].position <= i) {
        const pos = pendingRegisters[0].position;
        const batch = [];
        while (pendingRegisters.length && pendingRegisters[0].position === pos) batch.push(pendingRegisters.shift());
        for (const entry of batch) active.set(entry.name, { kind: 'register', entry, path });
        for (const entry of batch) checkCalls(entry);
      }
      while (pendingRules.length && pendingRules[0].position <= i) {
        const rule = pendingRules.shift();
        for (const n of rule.value) checkName(n);
      }
    };

    for (const r of t.models) modelRefs.add(r.value);
    for (let i = 0; i < t.children.length; i++) {
      activate(i);
      const c = t.children[i];
      if (c.kind === 'call') checkName(c.tool, c.name);
      // A deferred From() (versioned) has no tree to walk at build time —
      // its model/tool references are validated when the host loads it.
      if ((c.kind === 'branch' || c.kind === 'map') && c.tree) {
        const childPending = new Map(pendingAncestors);
        for (const e of pendingRegisters) childPending.set(e.name, path);
        walkTree(c.tree, `${path}/${c.name}`, active, childPending);
      }
    }
    activate(t.children.length); // registers/rules declared after the last child
  };
  walkTree(def, def.name, new Map());

  const models = runtime.models ?? {};
  for (const name of modelRefs) {
    if (!models[name]) {
      throw new KnitError(`Model('${name}') references a model not in runtime models (available: ${Object.keys(models).join(', ') || 'none'})`);
    }
  }
  if (modelRefs.size === 0 && !models.default && Object.keys(models).length !== 1) {
    throw new KnitError('no model resolvable: no Model() rules anywhere and no runtime default (set models.default or provide exactly one model)');
  }
  for (const [name, entry] of Object.entries(models)) {
    if (typeof entry.handler !== 'function' && !entry.baseURL) {
      throw new KnitError(`model '${name}' needs either a handler (mock) or a baseURL`);
    }
  }

  // Overriding a runtime tool from a tree is legal (and lexical) — say so
  // once per name so an accidental collision is still visible in the log.
  for (const n of registerNames) {
    if (tools[n]) {
      console.warn(`[grandma-kat] Register('${n}') overrides a runtime tool of the same name (visible in that tree only)`);
    }
  }

  if (problems.length) {
    const available = [...Object.keys(tools), ...registerNames].join(', ') || 'none';
    throw new KnitError(`unknown tools:\n  ${problems.join('\n  ')}\navailable: ${available}`);
  }
}
