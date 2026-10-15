// Auto tool-execution loop + tool hooks — the executable spec.
//
// Default (Prompt() with tools): call the model, execute every tool call it
// emits, append the results to the prompt's local thread, call again — until a
// round returns no tool calls. Prompt(disableAuto(), …) keeps the old
// single-round behavior. Prompt(max(n), …) bounds the rounds (default 3,
// exhaustion throws). Tool hooks are positional Hook()s, run per tool call:
//   Hook(toolBefore() | toolAfter(), [when(cond)], Tree(...))
// The hook tree runs in the declarer's scope with the call seeded as `call`; a
// toolBefore Return is merged into the call's args, a toolAfter Return over the
// call ref. They are no longer prompt markers.
//
// These tests are scripted against mock models — no live LLM.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import grandma, { Tree, when, update, max, disableAuto, runAfterTool, toolBefore, toolAfter, Hook, name, Model, Tools, Needs, Human, Prompt, Memory, Register, Branch, Each, Call, Check, Emit, Return, Until, registerTree } from '../src/index.mjs';
import { scripted, mockRuntime, tool } from './helpers.mjs';

const tc = (name, args, id = name) => ({
  id,
  function: { name, arguments: JSON.stringify(args ?? {}) },
});

function tmpLogger() {
  return path.join(os.tmpdir(), `grandma-kat-auto-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

// ── builder: marker parsing ───────────────────────────────────────────────

test('Hook() requires a trigger, a tree, and an optional when() gate', () => {
  assert.throws(() => Hook('nope', Tree()), /onEmit\(\), onHuman\(\), toolBefore\(\) or toolAfter\(\)/);
  assert.throws(() => Hook(toolBefore()), /hook tree is required/);
  assert.throws(() => Hook(toolBefore(), () => Tree()), /built at build time/);
  assert.throws(() => Hook(toolBefore(), Tree(), 'extra'), /too many arguments/);
  const t = Tree(name('p'), Hook(toolBefore(), when(() => true), Tree(Memory('x', () => 1))));
  assert.equal(t.hooks.length, 1);
  assert.equal(t.hooks[0].trigger, 'toolBefore');
  assert.equal(typeof t.hooks[0].gate, 'function');
  assert.equal(t.hooks[0].position, 0);
});

test('Prompt() parses auto markers; plain prompts keep their exact JSON shape', () => {
  const t = Tree(name('p'), Prompt(disableAuto(), max(5), m => 'x'));
  const child = t.children[0];
  assert.equal(child.auto.disabled, true);
  assert.equal(child.auto.max.count, 5);
  assert.ok(!('hooks' in child.auto), 'tool hooks are positional Hook()s now, not prompt markers');

  const plain = Tree(name('p2'), Prompt(m => 'x'));
  assert.ok(!('auto' in plain.children[0]), 'no auto key when nothing was configured — def hashes stay stable');

  assert.throws(() => Tree(name('p4'), Prompt(disableAuto(), disableAuto(), m => 'x')), /duplicate disableAuto/);
  assert.throws(() => Tree(name('p4'), Prompt(max(2), max(3), m => 'x')), /duplicate max/);
});

// ── runner: the loop ──────────────────────────────────────────────────────

test('auto loop: executes tool calls, feeds results back, ends on the answer round', async () => {
  const seen = [];
  const handler = scripted([
    { content: '', tool_calls: [tc('search', { q: 'x' })] },
    'final answer',
  ]);
  const pattern = Tree(name('agent')
    , Tools('search')
    , Prompt('main', m => 'find it')
    , Memory('rec', m => m.raw.branch.main));

  const { memory } = await grandma.knit(pattern, mockRuntime(handler, {
    tools: { search: tool(async (args) => { seen.push(args); return 'found:x'; }) },
  }));

  assert.equal(memory.rec.content, 'final answer');
  assert.equal(memory.rec.rounds, 2);
  assert.deepEqual(seen, [{ q: 'x' }]);
  assert.equal(handler.calls.length, 2, 'one round with calls + one answer round');

  const round2 = handler.calls[1].messages;
  assert.ok(
    round2.some((msg) => msg.role === 'tool' && msg.tool_call_id === 'search' && msg.content === 'found:x'),
    'round 2 carries the tool result back to the model',
  );

  // The saved conversation: the final thread holds the whole exchange.
  assert.ok(Array.isArray(memory.rec.thread));
  assert.ok(memory.rec.thread.some((msg) => msg.role === 'tool'));
  assert.equal(memory.rec.thread.at(-1).role, 'assistant');
});

test('disableAuto(): offers tools, records the call, never executes it', async () => {
  const handler = scripted([{ content: 'noted it', tool_calls: [tc('search', { q: 'x' })] }]);
  const pattern = Tree(name('agent')
    , Tools('search')
    , Prompt(disableAuto(), 'main', m => 'find it')
    , Memory('rec', m => m.raw.branch.main));

  const { memory } = await grandma.knit(pattern, mockRuntime(handler, {
    tools: { search: tool(async () => 'found:x') },
  }));

  assert.equal(handler.calls.length, 1);
  assert.equal(memory.rec.rounds, 1);
  assert.equal(memory.rec.content, 'noted it');
  assert.deepEqual(memory.rec.toolResults, [], 'no tool executed');
  assert.deepEqual(handler.calls[0].tools.map((t) => t.function.name), ['search'], 'the tool was offered');
  assert.equal(memory.rec.toolCalls[0].name, 'search', 'the emitted call was recorded');
});

test('tool errors are fed back so the model can recover', async () => {
  const handler = scripted([
    { content: '', tool_calls: [tc('flaky', {})] },
    'recovered',
  ]);
  const pattern = Tree(name('agent')
    , Tools('flaky')
    , Prompt('main', m => 'go'));

  const { result } = await grandma.knit(pattern, mockRuntime(handler, {
    tools: { flaky: tool(async () => ({ error: 'no can do' })) },
  }));

  assert.equal(result, 'recovered');
  const round2 = handler.calls[1].messages;
  assert.ok(
    round2.some((msg) => msg.role === 'tool' && msg.content.includes('no can do')),
    'the error-shaped result reaches the model as a tool message',
  );
});

test('max() bounds the loop; exhaustion throws with the errFn message', async () => {
  const handler = scripted([{ content: '', tool_calls: [tc('search', { q: 'x' })] }]); // repeats forever
  const pattern = Tree(name('agent')
    , Tools('search')
    , Prompt(max(2, () => 'custom-limit-hit'), m => 'go'));

  await assert.rejects(
    grandma.knit(pattern, mockRuntime(handler, { tools: { search: tool(async () => 'x') } })),
    /custom-limit-hit/,
  );
  assert.equal(handler.calls.length, 2, 'exactly max(2) rounds ran before giving up');
});

// Text-recovered tool calls (small models that emit `tool args` as plain
// text) arrive from callLlm already normalized into tool_calls, so the loop
// treats them like native ones — no loop-side code distinguishes them. The
// recovery itself lives in llm.mjs and only runs for real endpoints; a model
// handler's response is staged exactly as returned, never reinterpreted
// (a mock reply like "mini says banana" must not become a call).

test('a model-called register patches memory mid-loop and feeds back its { value }', async () => {
  const handler = scripted([
    { content: '', tool_calls: [tc('bump', {})] },
    'final',
  ]);
  const pattern = Tree(name('agent')
    , Memory('count', () => 0)
    , Register('bump', 'bump it', (m) => {
      const next = (m.count ?? 0) + 1;
      return { value: next, memory: { count: next } };
    })
    , Tools('bump')
    , Prompt('main', () => 'go')
    , Memory('rec', (m) => ({ count: m.count, results: m.raw.branch.main.toolResults })));

  const { memory } = await grandma.knit(pattern, mockRuntime(handler));

  assert.equal(memory.rec.count, 1, 'the memory patch applied before the next round');
  assert.deepEqual(memory.rec.results, [{ name: 'bump', result: { value: 1 }, isError: false }]);
  const toolMsg = handler.calls[1].messages.find((msg) => msg.role === 'tool');
  assert.equal(toolMsg.content, '{"value":1}', 'the stripped { value } is what feeds back');
});

test('a call outside the prompt whitelist is refused, not executed', async () => {
  const executed = [];
  const handler = scripted([
    { content: '', tool_calls: [tc('sneaky', {})] },
    'recovered',
  ]);
  const pattern = Tree(name('agent')
    , Tools('search')
    , Prompt('main', () => 'go'));

  const { result } = await grandma.knit(pattern, mockRuntime(handler, {
    tools: {
      search: tool(async () => 'ok'),
      sneaky: tool(async () => { executed.push(1); return 'should not run'; }),
    },
  }));

  assert.deepEqual(executed, [], 'the un-offered tool never ran');
  assert.equal(result, 'recovered', 'the refusal feeds back as a tool error');
  const refusal = handler.calls[1].messages.find((msg) => msg.role === 'tool');
  assert.match(refusal.content, /not offered to prompt 'main'/);
});

// ── runner: tool hooks ────────────────────────────────────────────────────

test('tool hooks run per call, in order: before → execute → after', async () => {
  const seq = [];
  const handler = scripted([
    { content: '', tool_calls: [tc('a', { q: '1' }), tc('b', { q: '2' })] },
    'done',
  ]);
  const mk = (nm) => tool(async (args) => { seq.push(`exec:${nm}:${args.q}`); return `r-${nm}`; });
  const pattern = Tree(name('agent')
    , Tools('a', 'b')
    , Hook(toolBefore(), Tree(Memory('log', (m) => { seq.push(`before:${m.call.name}:${m.call.args.q}`); })))
    , Hook(toolAfter(), Tree(Memory('log', (m) => { seq.push(`after:${m.call.name}:${m.call.result}`); })))
    , Prompt(m => 'go'));

  await grandma.knit(pattern, mockRuntime(handler, { tools: { a: mk('a'), b: mk('b') } }));

  assert.deepEqual(seq, [
    'before:a:1', 'exec:a:1', 'after:a:r-a',
    'before:b:2', 'exec:b:2', 'after:b:r-b',
  ]);
});

test('tool hook Returns merge into the call (null keeps it)', async () => {
  const received = [];
  const handler = scripted([
    { content: '', tool_calls: [tc('search', { q: 'raw' })] },
    'done',
  ]);
  const pattern = Tree(name('agent')
    , Tools('search')
    , Hook(toolBefore(), Tree(Return(() => null)))                     // keep the call
    , Hook(toolBefore(), Tree(Return(() => ({ q: 'rewritten' }))))     // patch the args
    , Hook(toolAfter(), Tree(Return(() => ({ result: 'REDACTED' }))))  // rewrite the result
    , Prompt(m => 'go'));

  await grandma.knit(pattern, mockRuntime(handler, {
    tools: { search: tool(async (args) => { received.push(args); return 'secret'; }) },
  }));

  assert.deepEqual(received, [{ q: 'rewritten' }], 'the merged args are what executed');
  const toolMsg = handler.calls[1].messages.find((msg) => msg.role === 'tool');
  assert.equal(toolMsg.content, 'REDACTED', 'the rewritten result is what the model sees');
});

test('a throwing tool hook aborts the run loudly', async () => {
  const handler = scripted([{ content: '', tool_calls: [tc('search', {})] }]);
  const pattern = Tree(name('agent')
    , Tools('search')
    , Hook(toolBefore(), Tree(Memory('x', () => { throw new Error('boom'); })))
    , Prompt(m => 'go'));

  await assert.rejects(
    grandma.knit(pattern, mockRuntime(handler, { tools: { search: tool(async () => 'x') } })),
    /boom/,
  );
});

test('a tool hook when() gate skips the hook tree for that call', async () => {
  let called = 0;
  const handler = scripted([{ content: '', tool_calls: [tc('search', {})] }, 'done']);
  const pattern = Tree(name('agent')
    , Tools('search')
    , Hook(toolBefore(), when((m) => m.call.name === 'other'), Tree(Memory('n', () => { called++; })))
    , Prompt(m => 'go'));

  await grandma.knit(pattern, mockRuntime(handler, { tools: { search: tool(async () => 'x') } }));
  assert.equal(called, 0, 'the gate saw the call name and skipped the tree');

  const handler2 = scripted([{ content: '', tool_calls: [tc('search', {})] }, 'done']);
  const pattern2 = Tree(name('agent2')
    , Tools('search')
    , Hook(toolBefore(), when((m) => m.call.name === 'search'), Tree(Memory('n', () => { called++; })))
    , Prompt(m => 'go'));
  await grandma.knit(pattern2, mockRuntime(handler2, { tools: { search: tool(async () => 'x') } }));
  assert.equal(called, 1);
});

test('disableAuto() offers the tool but never executes it, so no hook fires', async () => {
  let called = 0;
  const handler = scripted([{ content: '', tool_calls: [tc('search', {})] }]);
  const pattern = Tree(name('agent')
    , Tools('search')
    , Hook(toolAfter(), Tree(Memory('n', () => { called++; })))
    , Prompt(disableAuto(), m => 'go'));

  await grandma.knit(pattern, mockRuntime(handler, { tools: { search: tool(async () => 'x') } }));
  assert.equal(called, 0, 'the call was recorded, not executed, so no hook fired');
});

test('a fired tool hook logs a `hook` event (the WebUI line)', async () => {
  const dbPath = tmpLogger();
  try {
    const handler = scripted([{ content: '', tool_calls: [tc('search', { q: 'x' })] }, 'done']);
    const pattern = Tree(name('agent')
      , Tools('search')
      , Hook(toolBefore(), Tree(name('ctx_hook'), Memory('n', () => 1)))
      , Prompt(m => 'go'));
    await grandma.knit(pattern, mockRuntime(handler, { logger: dbPath, tools: { search: tool(async () => 'x') } }));

    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare("SELECT content FROM calls WHERE kind = 'hook'").all();
    db.close();
    assert.equal(rows.length, 1, 'one hook firing, one event');
    const c = JSON.parse(rows[0].content);
    assert.deepEqual(
      { trigger: c.trigger, hook: c.hook, slot: c.slot, phase: c.phase, tool: c.tool },
      { trigger: 'toolBefore', hook: 'ctx_hook', slot: 'call', phase: 'Before', tool: 'search' },
    );
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
});

// ── runner: resume ────────────────────────────────────────────────────────

test('resume: replayed calls do not re-run hooks, and the loop continues past the pause', async () => {
  const dbPath = tmpLogger();
  try {
    const counts = { before: 0, after: 0 };
    const inner = Tree(name('interviewer')
      , Prompt(m => `ask about ${m.topic}`)
      , Human('reply')
      , Memory('done', () => true));
    const tools = { interviewer: { description: 'ask', parameters: {}, tree: inner } };

    const handler1 = scripted([
      { content: '', tool_calls: [tc('interviewer', { topic: 'cats' })] },
      'inner question', // consumed by the inner prompt
    ]);
    const pattern = Tree(name('outer')
      , Tools('interviewer')
      , Hook(toolBefore(), Tree(Memory('n', () => { counts.before++; })))
      , Hook(toolAfter(), Tree(Memory('n', () => { counts.after++; })))
      , Prompt('main', m => 'go'));

    const step1 = await grandma.knit(pattern, mockRuntime(handler1, { logger: dbPath, tools }));
    assert.equal(step1.status, 'waiting');
    assert.deepEqual(counts, { before: 1, after: 0 }, 'before ran pre-pause; after waits for the tool to return');

    const handler2 = scripted(['done']);
    const step2 = await grandma.resume(step1.continuation, {
      ...mockRuntime(handler2, { logger: dbPath, tools }),
      humanInput: { reply: 'ok' },
    });

    assert.equal(step2.result, 'done', 'the loop continued after the replayed round');
    assert.equal(handler2.calls.length, 1);
    assert.deepEqual(counts, { before: 1, after: 1 }, 'no hook re-ran for the replayed call');
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
});

test('resume: the rebuilt thread carries replayed and fresh tool results', async () => {
  const dbPath = tmpLogger();
  try {
    const inner = Tree(name('asker')
      , Prompt(m => 'inner question')
      , Human('reply'));
    const tools = {
      search: tool(async () => 'search-result'),
      asker: { description: 'ask', parameters: {}, tree: inner },
    };

    const handler1 = scripted([
      { content: '', tool_calls: [tc('search', { q: 'x' }), tc('asker', {})] },
      'inner-output', // consumed by the inner prompt
    ]);
    const pattern = Tree(name('outer')
      , Tools('search', 'asker')
      , Prompt('main', m => 'go'));

    const step1 = await grandma.knit(pattern, mockRuntime(handler1, { logger: dbPath, tools }));
    assert.equal(step1.status, 'waiting');

    const handler2 = scripted(['done']);
    const step2 = await grandma.resume(step1.continuation, {
      ...mockRuntime(handler2, { logger: dbPath, tools }),
      humanInput: { reply: 'ok' },
    });

    assert.equal(step2.result, 'done');
    const round2 = handler2.calls[0].messages;
    const toolMsgs = round2.filter((msg) => msg.role === 'tool');
    assert.equal(toolMsgs.length, 2, 'one tool message per call of the replayed round');
    assert.ok(toolMsgs.some((msg) => msg.content === 'search-result'), 'completed call replayed from the log');
    assert.ok(toolMsgs.some((msg) => msg.content === 'inner-output'), 'the resumed call result is fresh');
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
});

// ── runner: tool-result shaping for the model ─────────────────────────────
//
// A tool result is what the model reads on the next round. Two bounds:
//   - the engine default: stringify + cap at runtime.maxToolResultChars
//     (default 4000; { rows: [...] } keeps whole rows, plain text gets a head
//     slice + marker); 0 disables.
//   - the prompt's own runAfterTool(shaper): a function or a registered tree
//     name whose output is used VERBATIM (the default cap does not also apply).
// Either way the FULL result stays in record.toolResults (the tree reads it via
// m.raw.branch.<prompt>.toolResults) and in the tool_result log event.

const bigString = (n) => 'x'.repeat(n);
const toolMessage = (handler, round = 1) =>
  handler.calls[round].messages.find((msg) => msg.role === 'tool');

test('runAfterTool() validates its shaper and is parsed into the prompt', () => {
  assert.throws(() => runAfterTool(123), /function or a non-empty registered tree name/);
  assert.throws(() => runAfterTool(''), /function or a non-empty registered tree name/);

  const fn = (call) => call.result;
  const t = Tree(name('p'), Prompt('main', () => 'x', runAfterTool(fn)));
  assert.equal(t.children[0].runAfterTool, fn);

  const t2 = Tree(name('p2'), Prompt('main', () => 'x', runAfterTool('some_tree')));
  assert.equal(t2.children[0].runAfterTool, 'some_tree');

  const plain = Tree(name('p3'), Prompt('main', () => 'x'));
  assert.ok(!('runAfterTool' in plain.children[0]), 'no key when unset — def hashes stay stable');

  assert.throws(
    () => Tree(name('p4'), Prompt('main', () => 'x', runAfterTool(fn), runAfterTool(fn))),
    /duplicate runAfterTool/,
  );
});

test('default cap: a large text result is truncated for the model, kept whole for the tree', async () => {
  const big = bigString(10000);
  const handler = scripted([{ content: '', tool_calls: [tc('dump', {})] }, 'done']);
  const pattern = Tree(name('agent')
    , Tools('dump')
    , Prompt('main', () => 'go')
    , Memory('rec', (m) => m.raw.branch.main));

  const { memory } = await grandma.knit(pattern, mockRuntime(handler, {
    tools: { dump: tool(async () => big) },
  }));

  const content = toolMessage(handler).content;
  assert.ok(content.length <= 4000 + 200, 'the model view is capped near 4000 chars');
  assert.match(content, /truncated — 10000 chars total/);
  assert.match(content, /narrow the query/);
  assert.equal(memory.rec.toolResults[0].result, big, 'the tree still reads the FULL result');
});

test('default cap: { rows: [...] } keeps whole rows and stays valid JSON', async () => {
  const rows = Array.from({ length: 80 }, (_, i) => ({ id: i, name: 'n'.repeat(80) }));
  const handler = scripted([{ content: '', tool_calls: [tc('q', {})] }, 'done']);
  const pattern = Tree(name('agent')
    , Tools('q')
    , Prompt('main', () => 'go')
    , Memory('rec', (m) => m.raw.branch.main));

  const { memory } = await grandma.knit(pattern, mockRuntime(handler, {
    tools: { q: tool(async () => ({ rows })) },
  }));

  const parsed = JSON.parse(toolMessage(handler).content); // valid JSON, not a mid-string cut
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.rowCount, 80);
  assert.ok(parsed.rowsShown > 0 && parsed.rowsShown < 80);
  assert.equal(parsed.rows.length, parsed.rowsShown);
  assert.match(parsed.note, /showing \d+ of 80 rows/);
  assert.deepEqual(memory.rec.toolResults[0].result, { rows }, 'the tree reads the full rows');
});

test('runtime.maxToolResultChars: caps at a custom size; 0 disables', async () => {
  const big = bigString(5000);
  const run = async (opts) => {
    const handler = scripted([{ content: '', tool_calls: [tc('dump', {})] }, 'done']);
    const pattern = Tree(name('agent'), Tools('dump'), Prompt('main', () => 'go'));
    await grandma.knit(pattern, {
      ...mockRuntime(handler, { tools: { dump: tool(async () => big) } }),
      ...opts,
    });
    return handler;
  };

  const capped = toolMessage(await run({ maxToolResultChars: 100 }));
  assert.ok(capped.content.length <= 100 + 200, 'capped near 100');
  assert.match(capped.content, /truncated/);

  const full = toolMessage(await run({ maxToolResultChars: 0 }));
  assert.equal(full.content, big, '0 disables the cap');
});

test('runAfterTool(fn): the shaper output is used verbatim, no default cap on top', async () => {
  const handler = scripted([{ content: '', tool_calls: [tc('dump', {})] }, 'done']);
  const pattern = Tree(name('agent')
    , Tools('dump')
    , Prompt('main', () => 'go', runAfterTool((call) => `SHAPED:${call.name}:${String(call.result).length}`))
    , Memory('rec', (m) => m.raw.branch.main));

  const { memory } = await grandma.knit(pattern, mockRuntime(handler, {
    tools: { dump: tool(async () => bigString(10000)) },
  }));

  assert.equal(toolMessage(handler).content, 'SHAPED:dump:10000', 'verbatim, not capped');
  assert.equal(memory.rec.toolResults[0].result.length, 10000, 'the tree keeps the full result');
});

test('runAfterTool("tree"): a registered tree shapes the result, seeded with m.call', async () => {
  registerTree(Tree(name('shape_under_test'),
    Return((m) => `TREE:${m.call.name}:${String(m.call.result).slice(0, 4)}`)));
  const handler = scripted([{ content: '', tool_calls: [tc('dump', {})] }, 'done']);
  const pattern = Tree(name('agent')
    , Tools('dump')
    , Prompt('main', () => 'go', runAfterTool('shape_under_test')));

  await grandma.knit(pattern, mockRuntime(handler, {
    tools: { dump: tool(async () => bigString(10000)) },
  }));

  assert.equal(toolMessage(handler).content, 'TREE:dump:xxxx');
});

test('runAfterTool("tree"): a pausing shaper tree is rejected', async () => {
  registerTree(Tree(name('pausing_shape_under_test'), Human('reply')));
  const handler = scripted([{ content: '', tool_calls: [tc('dump', {})] }, 'done']);
  const pattern = Tree(name('agent')
    , Tools('dump')
    , Prompt('main', () => 'go', runAfterTool('pausing_shape_under_test')));

  await assert.rejects(
    grandma.knit(pattern, mockRuntime(handler, { tools: { dump: tool(async () => 'x') } })),
    /must be pause-free/,
  );
});

test('runAfterTool("tree"): a throwing shaper falls back to the default cap', async () => {
  registerTree(Tree(name('throwing_shape_under_test'),
    Return(() => { throw new Error('shaper blew up'); })));
  const handler = scripted([{ content: '', tool_calls: [tc('dump', {})] }, 'done']);
  const pattern = Tree(name('agent')
    , Tools('dump')
    , Prompt('main', () => 'go', runAfterTool('throwing_shape_under_test')));

  await grandma.knit(pattern, mockRuntime(handler, {
    tools: { dump: tool(async () => bigString(10000)) },
  }));

  assert.match(
    toolMessage(handler).content,
    /truncated — 10000 chars total/,
    'a failed shaper does not kill the conversation — the default cap applies',
  );
});

// ── runner: the explicit loop (disableAuto + dynamic Call + Until) ─────────
//
// The recommended replacement for runAfterTool: the tree runs the loop, so
// shaping a result is an ordinary step. The load-bearing detail is that the
// model's calls are captured into a MEMORY slot — raw branch records are not
// reconstructed on resume, so a gate reading them would skip the paused branch.

test('explicit loop: disableAuto + a dynamic Call dispatches and folds each round', async () => {
  const executed = [];
  const callsOf = (m) => (m.raw?.branch?.response?.toolCalls ?? []);
  const pattern = Tree(name('agent')
    , Tools('search')
    , Memory('messages', (m, cur) => (Array.isArray(cur) ? cur : [{ role: 'user', content: 'go' }]))
    , Prompt(disableAuto(), 'response', (m) => m.messages)
    , Memory('calls', (m) => callsOf(m))
    , Branch(when((m) => m.calls.length > 0), Tree(
      Each('tool_calls', (m) => m.calls, Tree(
        Call((m) => m.item.name, (m) => JSON.parse(m.item.arguments)),
      )),
      Memory(update(), 'messages', (m, cur) => [
        ...cur,
        { role: 'assistant', tool_calls: m.calls },
        ...m.calls.map((c, i) => ({ role: 'tool', tool_call_id: c.id, content: String(m.branch.tool_calls[i]) })),
      ]),
    ))
    , Until((m) => m.calls.length === 0, max(5))
    , Return(() => 'end'));

  const handler = scripted([
    { content: '', tool_calls: [tc('search', { q: 'cats' })] },
    'final',
  ]);
  const { result } = await grandma.knit(pattern, mockRuntime(handler, {
    tools: { search: tool(async (args) => { executed.push(args); return 'found'; }) },
  }));

  assert.deepEqual(executed, [{ q: 'cats' }], 'the dynamic Call ran the model-chosen tool');
  assert.equal(result, 'end');
  // Round 2 saw the folded thread: the assistant tool_calls + the tool result.
  const round2 = handler.calls[1].messages;
  assert.ok(round2.some((m) => m.role === 'assistant' && Array.isArray(m.tool_calls)), 'assistant tool_calls folded in');
  assert.ok(round2.some((m) => m.role === 'tool' && m.content === 'found'), 'the tool result folded in');
});

test('explicit loop: tool hooks fire on the dynamic Call path (before enriches args, after rewrites the result)', async () => {
  const executed = [];
  const seen = [];
  const callsOf = (m) => (m.raw?.branch?.response?.toolCalls ?? []);
  const pattern = Tree(name('agent_hooked')
    , Tools('search')
    // A before-hook merges into the args the Call runs — the context an app
    // tree would receive.
    , Hook(toolBefore(), Tree(Return((m) => ({ q: `${m.call.args.q}+ctx` }))))
    // An after-hook sees the result and may replace it.
    , Hook(toolAfter(), Tree(
      Memory('log', (m) => { seen.push(`${m.call.name}:${m.call.result}`); }),
      Return(() => ({ result: 'REDACTED' })),
    ))
    , Memory('messages', (m, cur) => (Array.isArray(cur) ? cur : [{ role: 'user', content: 'go' }]))
    , Prompt(disableAuto(), 'response', (m) => m.messages)
    , Memory('calls', (m) => callsOf(m))
    , Branch(when((m) => m.calls.length > 0), Tree(
      Each('tool_calls', (m) => m.calls, Tree(
        Call((m) => m.item.name, (m) => JSON.parse(m.item.arguments)),
      )),
      Memory(update(), 'messages', (m, cur) => [
        ...cur,
        { role: 'assistant', tool_calls: m.calls },
        ...m.calls.map((c, i) => ({ role: 'tool', tool_call_id: c.id, content: String(m.branch.tool_calls[i]) })),
      ]),
    ))
    , Until((m) => m.calls.length === 0, max(5))
    , Return(() => 'end'));

  const handler = scripted([
    { content: '', tool_calls: [tc('search', { q: 'cats' })] },
    'final',
  ]);
  await grandma.knit(pattern, mockRuntime(handler, {
    tools: { search: tool(async (args) => { executed.push(args); return 'found'; }) },
  }));

  assert.deepEqual(executed, [{ q: 'cats+ctx' }], 'the before-hook merged into the args the Call ran');
  assert.deepEqual(seen, ['search:found'], 'the after-hook saw the call result');
  const round2 = handler.calls[1].messages;
  assert.ok(round2.some((m) => m.role === 'tool' && m.content === 'REDACTED'), 'the after-hook rewrite is what the tree folded');
});

test('explicit loop: a pause inside a tree tool resumes (calls captured in a memory slot)', async () => {
  const dbPath = tmpLogger();
  try {
    const child = Tree(name('asker_under_test')
      , Prompt(() => 'q')
      , Human('answer')
      , Memory('out', (m) => `answer: ${m.answer}`));
    const tools = { asker_under_test: { description: 'ask', parameters: {}, tree: child } };
    const callsOf = (m) => (m.raw?.branch?.response?.toolCalls ?? []);
    const pattern = Tree(name('agent')
      , Tools('asker_under_test')
      , Memory('messages', (m, cur) => (Array.isArray(cur) ? cur : [{ role: 'user', content: 'go' }]))
      , Prompt(disableAuto(), 'response', (m) => m.messages)
      // A DURABLE slot: on resume the raw branch record is gone, but this
      // survives — the gate below must read it, not m.raw.branch.response.
      , Memory('calls', (m) => callsOf(m))
      , Branch(when((m) => m.calls.length > 0), Tree(
        Each('tool_calls', (m) => m.calls, Tree(
          Call((m) => m.item.name, () => ({})),
        )),
      ))
      , Until((m) => m.calls.length === 0, max(5))
      , Return(() => 'end'));

    const first = await grandma.knit(pattern, mockRuntime(scripted([
      { content: '', tool_calls: [tc('asker_under_test')] },
      'child question', // the asker tree's own prompt
    ]), { logger: dbPath, tools }));
    assert.equal(first.status, 'waiting');
    assert.equal(first.humanSlot, 'answer');

    const handler2 = scripted(['done']);
    const second = await grandma.knit(pattern, {
      ...mockRuntime(handler2, { logger: dbPath, tools }),
      _continuation: first.continuation,
      humanInput: 'purr',
    });
    assert.equal(second.status, undefined, 'the run finished after the pause');
    assert.equal(second.result, 'end');
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
});

test('explicit loop: a paused Call does not re-run its before-hook on resume', async () => {
  const dbPath = tmpLogger();
  try {
    const counts = { before: 0, after: 0 };
    const child = Tree(name('asker_hooked')
      , Prompt(() => 'q')
      , Human('answer')
      , Memory('out', (m) => `answer: ${m.answer}`));
    const tools = { asker_hooked: { description: 'ask', parameters: {}, tree: child } };
    const callsOf = (m) => (m.raw?.branch?.response?.toolCalls ?? []);
    const pattern = Tree(name('agent_hooked_resume')
      , Tools('asker_hooked')
      , Hook(toolBefore(), Tree(Memory('n', () => { counts.before++; })))
      , Hook(toolAfter(), Tree(Memory('n', () => { counts.after++; })))
      , Memory('messages', (m, cur) => (Array.isArray(cur) ? cur : [{ role: 'user', content: 'go' }]))
      , Prompt(disableAuto(), 'response', (m) => m.messages)
      , Memory('calls', (m) => callsOf(m))
      , Branch(when((m) => m.calls.length > 0), Tree(
        Each('tool_calls', (m) => m.calls, Tree(
          Call((m) => m.item.name, () => ({})),
        )),
      ))
      , Until((m) => m.calls.length === 0, max(5))
      , Return(() => 'end'));

    const first = await grandma.knit(pattern, mockRuntime(scripted([
      { content: '', tool_calls: [tc('asker_hooked')] },
      'child question',
    ]), { logger: dbPath, tools }));
    assert.equal(first.status, 'waiting');
    assert.deepEqual(counts, { before: 1, after: 0 }, 'before ran pre-pause; after waits for the subtree');

    const second = await grandma.knit(pattern, {
      ...mockRuntime(scripted(['done']), { logger: dbPath, tools }),
      _continuation: first.continuation,
      humanInput: 'purr',
    });
    assert.equal(second.status, undefined, 'the run finished after the pause');
    assert.equal(second.result, 'end');
    assert.deepEqual(counts, { before: 1, after: 1 }, 'the before-hook did not re-run for the resumed Call');
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
});

// ── resume: prompt raw records are reconstructed ───────────────────────────
//
// A prompt's raw record (m.raw.branch.<name> / m.raw.prev[0]) used to be lost
// on resume. A when() gate reading a prompt that ran BEFORE the pause then went
// false and silently skipped the paused branch — the bug that dropped an email
// send mid-conversation. The record is rebuilt from the events already in the
// log (llm_call per round, tool_result per call).

test('resume: a pre-pause prompt raw record is reconstructed (gate on m.raw.branch.<name>)', async () => {
  const dbPath = tmpLogger();
  try {
    const emitted = [];
    const child = Tree(name('raw_asker')
      , Prompt(() => 'q')
      , Human('answer')
      , Emit((m) => ({ text: `got:${m.answer}` })));
    const tools = { raw_asker: { description: 'ask', parameters: {}, tree: child } };
    const rawCalls = (m) => (m.raw.branch.response.toolCalls ?? []);
    const pattern = Tree(name('agent')
      , Tools('raw_asker')
      , Memory('messages', (m, cur) => (Array.isArray(cur) ? cur : [{ role: 'user', content: 'go' }]))
      , Prompt(disableAuto(), 'response', (m) => m.messages)
      // The gate reads the RAW record of a prompt that ran before the pause.
      , Branch(when((m) => rawCalls(m).length > 0), Tree(
        Each('tool_calls', rawCalls, Tree(
          Call((m) => m.item.name, () => ({})),
        )),
      ))
      , Until((m) => rawCalls(m).length === 0, max(5))
      , Return(() => 'end'));

    const first = await grandma.knit(pattern, {
      ...mockRuntime(scripted([
        { content: '', tool_calls: [tc('raw_asker')] },
        'child question',
      ]), { logger: dbPath, tools }),
      onEmit: (v) => emitted.push(v),
    });
    assert.equal(first.status, 'waiting');
    assert.equal(first.humanSlot, 'answer');

    const second = await grandma.knit(pattern, {
      ...mockRuntime(scripted(['done']), { logger: dbPath, tools }),
      _continuation: first.continuation,
      humanInput: 'purr',
      onEmit: (v) => emitted.push(v),
    });
    assert.equal(second.status, undefined);
    assert.ok(
      emitted.some((e) => String(e?.text ?? e).includes('got:purr')),
      'the raw-record gate resumed the paused tree tool',
    );
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
});

test('resume: an earlier auto-loop prompt raw record carries its toolResults', async () => {
  const dbPath = tmpLogger();
  try {
    const asker = Tree(name('asker_tool'), Prompt(() => 'q'), Human('answer'));
    const tools = {
      lookup: tool(async () => 'looked-up'),
      asker_tool: { description: 'ask', parameters: {}, tree: asker },
    };
    const pattern = Tree(name('host')
      , Tools('lookup', 'asker_tool')
      , Prompt('act', () => 'go')       // auto loop: calls lookup, then answers
      , Prompt('next', () => 'go on')   // auto loop: calls asker_tool → pauses
      , Prompt('report', (m) => `saw ${(m.raw.branch.act.toolResults ?? []).map((r) => r.result).join(',')}`));

    const handler1 = scripted([
      { content: '', tool_calls: [tc('lookup')] },      // act round 1
      'act done',                                        // act round 2 (no calls)
      { content: '', tool_calls: [tc('asker_tool')] },   // next round 1
      'asker question',                                  // asker prompt
    ]);
    const first = await grandma.knit(pattern, mockRuntime(handler1, { logger: dbPath, tools }));
    assert.equal(first.status, 'waiting');
    assert.equal(first.humanSlot, 'answer');

    const handler2 = scripted(['next done', 'report']);
    const second = await grandma.knit(pattern, {
      ...mockRuntime(handler2, { logger: dbPath, tools }),
      _continuation: first.continuation,
      humanInput: 'purr',
    });
    assert.equal(second.status, undefined);
    const reportMsg = String(handler2.calls.at(-1).messages.at(-1).content);
    assert.match(reportMsg, /saw looked-up/, 'act.toolResults was reconstructed after the pause');
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
});
