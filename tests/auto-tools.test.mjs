// Auto tool-execution loop + tool hooks — the executable spec.
//
// Default (.prompt() with tools): call the model, execute every tool call it
// emits, append the results to the prompt's local thread, call again — until a
// round returns no tool calls. .prompt(disableAuto(), …) keeps the old
// single-round behavior. .prompt(max(n), …) bounds the rounds (default 3,
// exhaustion throws). Hooks are marker args on .prompt(), run per tool call:
//   .prompt(toolHookBefore(fn), toolHookAfter(fn), value)
//   fn(m, thread, tool_call) — return an updated tool-call shape, or null.
//
// These tests are scripted against mock models — no live LLM.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import grandma, {
  Tree,
  when,
  max,
  disableAuto,
  toolHookBefore,
  toolHookAfter,
} from '../src/index.mjs';
import { scripted, mockRuntime, tool } from './helpers.mjs';

const tc = (name, args, id = name) => ({
  id,
  function: { name, arguments: JSON.stringify(args ?? {}) },
});

function tmpLogger() {
  return path.join(os.tmpdir(), `grandma-kat-auto-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

// ── builder: marker parsing ───────────────────────────────────────────────

test('markers validate their arguments', () => {
  assert.throws(() => toolHookBefore('nope'), /function/);
  assert.throws(() => toolHookAfter(), /function/);
  assert.throws(() => toolHookBefore(when(() => true)), /function/);
  assert.doesNotThrow(() => toolHookBefore(when(() => true), () => {}));
});

test('.prompt() parses auto markers; plain prompts keep their exact JSON shape', () => {
  const hb = () => {};
  const ha = () => {};
  const t = Tree.name('p').prompt(toolHookBefore(hb), toolHookAfter(ha), disableAuto(), max(5), m => 'x');
  const child = t.def.children[0];
  assert.equal(child.auto.disabled, true);
  assert.equal(child.auto.max.count, 5);
  assert.deepEqual(child.auto.hooks.before.map((h) => h.fn), [hb]);
  assert.deepEqual(child.auto.hooks.after.map((h) => h.fn), [ha]);

  const plain = Tree.name('p2').prompt(m => 'x');
  assert.ok(!('auto' in plain.def.children[0]), 'no auto key when nothing was configured — def hashes stay stable');

  const t2 = Tree.name('p3').prompt(toolHookBefore(hb), toolHookBefore(ha), m => 'x');
  assert.deepEqual(t2.def.children[0].auto.hooks.before.map((h) => h.fn), [hb, ha], 'multiple hooks keep argument order');

  assert.throws(() => Tree.name('p4').prompt(disableAuto(), disableAuto(), m => 'x'), /duplicate disableAuto/);
  assert.throws(() => Tree.name('p4').prompt(max(2), max(3), m => 'x'), /duplicate max/);
});

// ── runner: the loop ──────────────────────────────────────────────────────

test('auto loop: executes tool calls, feeds results back, ends on the answer round', async () => {
  const seen = [];
  const handler = scripted([
    { content: '', tool_calls: [tc('search', { q: 'x' })] },
    'final answer',
  ]);
  const pattern = Tree.name('agent')
    .tools('search')
    .prompt('main', m => 'find it')
    .memory('rec', m => m.raw.branch.main);

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

test('disableAuto(): stays single-round — results recorded, never fed back', async () => {
  const handler = scripted([{ content: 'noted it', tool_calls: [tc('search', { q: 'x' })] }]);
  const pattern = Tree.name('agent')
    .tools('search')
    .prompt(disableAuto(), 'main', m => 'find it')
    .memory('rec', m => m.raw.branch.main);

  const { memory } = await grandma.knit(pattern, mockRuntime(handler, {
    tools: { search: tool(async () => 'found:x') },
  }));

  assert.equal(handler.calls.length, 1);
  assert.equal(memory.rec.rounds, 1);
  assert.equal(memory.rec.content, 'noted it');
  assert.deepEqual(memory.rec.toolResults, [{ name: 'search', result: 'found:x', isError: false }]);
});

test('tool errors are fed back so the model can recover', async () => {
  const handler = scripted([
    { content: '', tool_calls: [tc('flaky', {})] },
    'recovered',
  ]);
  const pattern = Tree.name('agent')
    .tools('flaky')
    .prompt('main', m => 'go');

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
  const pattern = Tree.name('agent')
    .tools('search')
    .prompt(max(2, () => 'custom-limit-hit'), m => 'go');

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
  const pattern = Tree.name('agent')
    .memory('count', () => 0)
    .register('bump', 'bump it', (m) => {
      const next = (m.count ?? 0) + 1;
      return { value: next, memory: { count: next } };
    })
    .tools('bump')
    .prompt('main', () => 'go')
    .memory('rec', (m) => ({ count: m.count, results: m.raw.branch.main.toolResults }));

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
  const pattern = Tree.name('agent')
    .tools('search')
    .prompt('main', () => 'go');

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

// ── runner: hooks ─────────────────────────────────────────────────────────

test('hooks run per tool call, in order: before → execute → after', async () => {
  const seq = [];
  const handler = scripted([
    { content: '', tool_calls: [tc('a', { q: '1' }), tc('b', { q: '2' })] },
    'done',
  ]);
  const mk = (name) => tool(async (args) => { seq.push(`exec:${name}:${args.q}`); return `r-${name}`; });
  const pattern = Tree.name('agent')
    .tools('a', 'b')
    .prompt(
      toolHookBefore((m, thread, t) => { seq.push(`before:${t.name}:${t.args.q}`); assert.ok(Array.isArray(thread)); }),
      toolHookAfter((m, thread, t) => { seq.push(`after:${t.name}:${t.result}`); assert.equal(t.isError, false); }),
      m => 'go',
    );

  await grandma.knit(pattern, mockRuntime(handler, { tools: { a: mk('a'), b: mk('b') } }));

  assert.deepEqual(seq, [
    'before:a:1', 'exec:a:1', 'after:a:r-a',
    'before:b:2', 'exec:b:2', 'after:b:r-b',
  ]);
});

test('hook return values replace the call shape (null keeps the current one)', async () => {
  const received = [];
  const handler = scripted([
    { content: '', tool_calls: [tc('search', { q: 'raw' })] },
    'done',
  ]);
  const pattern = Tree.name('agent')
    .tools('search')
    .prompt(
      toolHookBefore(() => null), // null → keep the current shape
      toolHookBefore((m, thread, t) => ({ args: { q: 'rewritten' } })), // replaces args
      toolHookAfter(() => ({ result: 'REDACTED' })), // replaces the result
      m => 'go',
    );

  await grandma.knit(pattern, mockRuntime(handler, {
    tools: { search: tool(async (args) => { received.push(args); return 'secret'; }) },
  }));

  assert.deepEqual(received, [{ q: 'rewritten' }], 'the rewritten args are what executed');
  const toolMsg = handler.calls[1].messages.find((msg) => msg.role === 'tool');
  assert.equal(toolMsg.content, 'REDACTED', 'the rewritten result is what the model sees');
});

test('a throwing hook aborts the run loudly', async () => {
  const handler = scripted([{ content: '', tool_calls: [tc('search', {})] }]);
  const pattern = Tree.name('agent')
    .tools('search')
    .prompt(toolHookBefore(() => { throw new Error('boom'); }), m => 'go');

  await assert.rejects(
    grandma.knit(pattern, mockRuntime(handler, { tools: { search: tool(async () => 'x') } })),
    /toolHookBefore of 'search' threw: boom/,
  );
});

test('hook gates: when() skips the hook for that call', async () => {
  let called = 0;
  const handler = scripted([{ content: '', tool_calls: [tc('search', {})] }, 'done']);
  const pattern = Tree.name('agent')
    .tools('search')
    .prompt(toolHookBefore(when(() => false), () => { called++; }), m => 'go');

  await grandma.knit(pattern, mockRuntime(handler, { tools: { search: tool(async () => 'x') } }));
  assert.equal(called, 0);

  const handler2 = scripted([{ content: '', tool_calls: [tc('search', {})] }, 'done']);
  const pattern2 = Tree.name('agent2')
    .tools('search')
    .prompt(toolHookBefore(when(() => true), () => { called++; }), m => 'go');
  await grandma.knit(pattern2, mockRuntime(handler2, { tools: { search: tool(async () => 'x') } }));
  assert.equal(called, 1);
});

test('hooks run with disableAuto() too — they observe calls, not the loop', async () => {
  let called = 0;
  const handler = scripted([{ content: '', tool_calls: [tc('search', {})] }]);
  const pattern = Tree.name('agent')
    .tools('search')
    .prompt(disableAuto(), toolHookAfter(() => { called++; }), m => 'go');

  await grandma.knit(pattern, mockRuntime(handler, { tools: { search: tool(async () => 'x') } }));
  assert.equal(called, 1);
});

// ── runner: resume ────────────────────────────────────────────────────────

test('resume: replayed calls do not re-run hooks, and the loop continues past the pause', async () => {
  const dbPath = tmpLogger();
  try {
    const counts = { before: 0, after: 0 };
    const inner = Tree.name('interviewer')
      .prompt(m => `ask about ${m.topic}`)
      .human('reply')
      .memory('done', () => true);
    const tools = { interviewer: { description: 'ask', parameters: {}, tree: inner } };

    const handler1 = scripted([
      { content: '', tool_calls: [tc('interviewer', { topic: 'cats' })] },
      'inner question', // consumed by the inner prompt
    ]);
    const pattern = Tree.name('outer')
      .tools('interviewer')
      .prompt(
        toolHookBefore(() => { counts.before++; }),
        toolHookAfter(() => { counts.after++; }),
        'main',
        m => 'go',
      );

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
    const inner = Tree.name('asker')
      .prompt(m => 'inner question')
      .human('reply');
    const tools = {
      search: tool(async () => 'search-result'),
      asker: { description: 'ask', parameters: {}, tree: inner },
    };

    const handler1 = scripted([
      { content: '', tool_calls: [tc('search', { q: 'x' }), tc('asker', {})] },
      'inner-output', // consumed by the inner prompt
    ]);
    const pattern = Tree.name('outer')
      .tools('search', 'asker')
      .prompt('main', m => 'go');

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
