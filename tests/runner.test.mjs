import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import grandma, { Tree, when, goback, max, KnitError } from '../src/index.mjs';
import { scripted, mockRuntime, tool } from './helpers.mjs';

test('basic pipeline: prompts chain via m.prev, result = last child', async () => {
  const seen = [];
  const handler = scripted(['outline', 'draft', 'final']);
  const pattern = Tree.name('pipe')
    .prompt(m => `task: ${m.task}`)
    .prompt(m => { seen.push(m.prev.length); return `from: ${m.prev[0]}`; })
    .prompt(m => `${m.prev[0]} + ${m.prev[1]}`);

  const { result, memory } = await grandma.knit(pattern, mockRuntime(handler, { memory: { task: 'T' } }));

  assert.equal(result, 'final');
  assert.equal(seen[0], 1); // second prompt sees one previous output
  assert.equal(memory['pipe#1'], 'outline');
  assert.equal(memory['pipe#2'], 'draft');
  assert.equal(memory['pipe#3'], 'final');
  // first prompt received the injected root input
  assert.ok(handler.calls[0].messages[0].content.includes('task: T'));
});

test('nested branches export to parent and resolve via m.branch.X', async () => {
  const handler = scripted(['inner-value', 'outer-read']);
  const pattern = Tree.name('outer')
    .branch(Tree.name('inner').prompt(m => 'make'))
    .prompt(m => { assert.equal(m.branch.inner, 'inner-value'); return 'done'; });

  const { result, memory } = await grandma.knit(pattern, mockRuntime(handler));
  assert.equal(result, 'outer-read'); // leaf value = LLM response, not prompt text
  assert.equal(memory.inner, 'inner-value');
});

test('shadowing: nearest scope wins', async () => {
  const reads = [];
  const handler = scripted(['inner', 'read-inner', 'read-outer']);
  const pattern = Tree.name('root')
    .branch(
      Tree.name('sub')
        .prompt('task', m => 'inner') // shadows root input 'task' inside sub
        .prompt(m => { reads.push(m.branch.task); return 'x'; })
    )
    .prompt(m => { reads.push(m.branch.task); return 'y'; });

  await grandma.knit(pattern, mockRuntime(handler, { memory: { task: 'outer' } }));
  assert.deepEqual(reads, ['inner', 'outer']);
});

test('check failure sets m.error; goback retries with feedback', async () => {
  const handler = scripted(['bad answer', 'yes']);
  const pattern = Tree.name('agent')
    .prompt(m => `Met? ${m.error ?? 'Answer ONLY yes or no.'}`)
    .check(
      m => m.prev[0] === 'yes' || m.prev[0] === 'no' || 'Answer with ONLY the word "yes" or "no".',
      goback(1, max(3))
    );

  const { result } = await grandma.knit(pattern, mockRuntime(handler));
  assert.equal(result, 'yes');
  assert.equal(handler.calls.length, 2);
  // the retry saw the feedback in m.error
  assert.ok(handler.calls[1].messages[0].content.includes('Answer with ONLY the word'));
});

test('check exhaustion throws with authored error message', async () => {
  const handler = scripted(['bad', 'bad', 'bad', 'bad']);
  const pattern = Tree.name('agent')
    .prompt(m => 'answer')
    .check(m => m.prev[0] === 'yes' || 'not yes', goback(1, max(2, m => `gave up: ${m.error}`)));

  await assert.rejects(
    grandma.knit(pattern, mockRuntime(handler)),
    (err) => {
      assert.ok(err instanceof KnitError);
      assert.equal(err.message, 'gave up: not yes');
      return true;
    });
});

test('until loops until condition passes', async () => {
  const handler = scripted(['no', 'yes']);
  const pattern = Tree.name('loop')
    .prompt(m => 'answer')
    .until(m => m.prev[0] === 'yes', max(3));

  const { result } = await grandma.knit(pattern, mockRuntime(handler));
  assert.equal(result, 'yes');
  assert.equal(handler.calls.length, 2);
});

test('until exhaustion throws', async () => {
  const handler = scripted(['no', 'no', 'no']);
  const pattern = Tree.name('loop')
    .prompt(m => 'answer')
    .until(m => m.prev[0] === 'yes', max(2));

  await assert.rejects(grandma.knit(pattern, mockRuntime(handler)), /exhausted/);
  assert.equal(handler.calls.length, 3); // 1 initial + 2 rewinds
});

test('gated children are skipped; m.prev stays dense', async () => {
  const prevs = [];
  const handler = scripted(['a', 'b']);
  const pattern = Tree.name('gated')
    .prompt(m => 'a')
    .prompt(when(m => false), m => 'never runs')
    .prompt(m => { prevs.push(m.prev[0]); return 'b'; });

  const { result, memory } = await grandma.knit(pattern, mockRuntime(handler));
  assert.equal(result, 'b');
  assert.equal(handler.calls.length, 2); // gated prompt never invoked the LLM
  assert.equal(prevs[0], 'a'); // skipped child occupies no position
  assert.equal(memory['gated#2'], undefined); // no slot written
});

test('needs: missing input throws; injected memory satisfies', async () => {
  const missing = Tree.name('t').needs('nope').prompt(m => 'x');
  await assert.rejects(grandma.knit(missing, mockRuntime(scripted(['x']))), /no branch produces it/);

  const satisfied = Tree.name('t').needs('task').prompt(m => `got ${m.task}`);
  const { result } = await grandma.knit(satisfied, mockRuntime(scripted(['ok']), { memory: { task: 'injected' } }));
  assert.equal(result, 'ok');
});

test('needs: missing at runtime (scope chain miss) throws loudly', async () => {
  // 'late' is produced inside the tree but AFTER the branch that needs it,
  // and not injected — runtime resolution must fail when the branch runs.
  const pattern = Tree.name('root')
    .branch(Tree.name('needy').needs('late').prompt(m => 'x'))
    .prompt('late', m => 'too late');

  await assert.rejects(
    grandma.knit(pattern, mockRuntime(scripted(['x', 'too late']))),
    /needs 'late', but it does not resolve in scope/);
});

test('model resolution: tree .model() overrides runtime default', async () => {
  const usedBy = { a: 0, b: 0 };
  const models = {
    a: { model: 'a', handler: async () => { usedBy.a++; return { content: 'from-a' }; } },
    b: { model: 'b', handler: async () => { usedBy.b++; return { content: 'from-b' }; } },
    default: { model: 'a', handler: async () => { usedBy.a++; return { content: 'from-a' }; } },
  };
  const pattern = Tree.name('root')
    .prompt(m => 'plain')
    .branch(Tree.name('fancy').model('b').prompt(m => 'fancy'));

  await grandma.knit(pattern, mockRuntime(null, { models }));
  assert.equal(usedBy.a, 1);
  assert.equal(usedBy.b, 1);
});

test('prompt with tools: tool call executed, result in record', async () => {
  const executed = [];
  const tools = {
    search: tool(async ({ q }) => { executed.push(q); return `result:${q}`; }),
  };
  const handler = scripted([
    { content: '', tool_calls: [{ id: '1', function: { name: 'search', arguments: '{"q":"x"}' } }] },
  ]);
  const pattern = Tree.name('agent')
    .tools('search')
    .prompt(m => 'find something');

  const { result } = await grandma.knit(pattern, mockRuntime(handler, { tools }));
  // One LLM call — tool was executed, result is in the record, not fed back.
  assert.equal(result, '');
  assert.deepEqual(executed, ['x']);
  assert.equal(handler.calls.length, 1);
});

test('tool errors are recorded, not fatal', async () => {
  const tools = { boom: tool(async () => { throw new Error('kaput'); }) };
  const handler = scripted([
    { content: '', tool_calls: [{ id: '1', function: { name: 'boom', arguments: '{}' } }] },
  ]);
  const pattern = Tree.name('agent').tools('boom').prompt(m => 'go');

  const { result } = await grandma.knit(pattern, mockRuntime(handler, { tools }));
  // One LLM call — tool error is recorded, not fed back to the model.
  assert.equal(result, '');
  assert.equal(handler.calls.length, 1);
});

test('.call() leaf executes a tool directly with args from memory', async () => {
  const executed = [];
  const tools = { navigate: tool(async (args) => { executed.push(args); return 'navigated'; }) };
  const pattern = Tree.name('agent')
    .prompt(m => 'url please')
    .call('navigate', m => ({ url: m.prev[0] }));

  const { result, memory } = await grandma.knit(pattern, mockRuntime(scripted(['http://x']), { tools }));
  assert.deepEqual(executed, [{ url: 'http://x' }]);
  assert.equal(result, 'navigated');
});

test('unknown tool in .tools() fails at knit() start with branch path', async () => {
  const pattern = Tree.name('agent')
    .tools('navigte') // typo
    .prompt(m => 'go');

  await assert.rejects(
    grandma.knit(pattern, mockRuntime(scripted(['x']), { tools: { navigate: tool(async () => 'ok') } })),
    /agent references unknown tool 'navigte'/);
});

test('reserved memory keys are rejected', async () => {
  const pattern = Tree.name('t').prompt(m => 'x');
  await assert.rejects(
    grandma.knit(pattern, mockRuntime(scripted(['x']), { memory: { prev: 1 } })),
    /reserved/);
});

test('tree with zero children is a build error', async () => {
  await assert.rejects(grandma.knit(Tree.name('empty'), mockRuntime(scripted(['x']))), /zero children/);
});

test('sqlite logger writes rows', async () => {
  const tmp = path.join(os.tmpdir(), `grandma-kat-test-${Date.now()}.db`);
  try {
    const pattern = Tree.name('logged').prompt(m => 'hi');
    await grandma.knit(pattern, mockRuntime(scripted(['hello']), { logger: tmp }));

    const db = new DatabaseSync(tmp, { readonly: true });
    const rows = db.prepare('SELECT * FROM calls').all();
    db.close();

    assert.ok(rows.length >= 1);
    const llmRow = rows.find((r) => r.kind === 'llm_call');
    assert.ok(llmRow);
    assert.equal(llmRow.branch_path, 'logged');
    assert.equal(JSON.parse(llmRow.content).content, 'hello');
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

test('memory out feeds the next run (sessions)', async () => {
  const first = await grandma.knit(
    Tree.name('s').prompt(m => 'v1'),
    mockRuntime(scripted(['v1'])));
  assert.equal(first.memory['s#1'], 'v1');

  const second = await grandma.knit(
    Tree.name('s').prompt(m => `previous was ${m['s#1'] ?? 'nothing'}`),
    mockRuntime(scripted(['v2']), { memory: first.memory }));
  assert.equal(second.result, 'v2');
  assert.ok(second.memory['s#1'] === 'v2');
});

test('.memory() writes to a named slot and produces m.prev output', async () => {
  const seen = [];
  const handler = scripted(['hello', 'result']);
  const pattern = Tree.name('m')
    .prompt(m => 'hello')
    .memory('greeting', (m, cur) => m.prev[0])
    .prompt(m => { seen.push({ greeting: m.branch.greeting, prevLen: m.prev.length }); return 'result'; });

  const { result, memory } = await grandma.knit(pattern, mockRuntime(handler));
  // memory slot was written
  assert.equal(memory.greeting, 'hello');
  // .memory() now appears in m.prev — the second prompt sees prompt + memory
  assert.equal(seen[0].greeting, 'hello');
  assert.equal(seen[0].prevLen, 2);
});

test('.memory() with gate skips when gate is false', async () => {
  const handler = scripted(['val']);
  const pattern = Tree.name('m')
    .prompt(m => 'val')
    .memory(when(m => false), 'skipped', (m, cur) => 'should not run')
    .prompt(m => m.branch.skipped ?? 'empty');

  const { memory } = await grandma.knit(pattern, mockRuntime(handler));
  assert.equal(memory.skipped, undefined);
});

test('.memory() accumulates across loop iterations', async () => {
  let i = 0;
  const handler = async () => {
    const n = i++;
    if (n < 3) return { content: `item-${n}` };
    return { content: 'done' };
  };
  const pattern = Tree.name('loop')
    .prompt('step', m => `iter`)
    .memory('items', (m, cur) => [...(cur ?? []), m.branch.step])
    .until(m => m.branch.step === 'done', max(5));

  const { memory } = await grandma.knit(pattern, mockRuntime(handler));
  // items accumulated across all iterations including the final 'done' pass
  assert.deepEqual(memory.items, ['item-0', 'item-1', 'item-2', 'done']);
});

test('.memoryUpdate() updates existing slot from parent scope', async () => {
  const handler = scripted(['hello', 'updated']);
  const pattern = Tree.name('m')
    .memory('greeting', () => 'initial')
    .prompt(m => 'hello')
    .memoryUpdate('greeting', (m, cur) => `${cur}-${m.prev[0]}`)
    .prompt(m => m.branch.greeting);

  const { result, memory } = await grandma.knit(pattern, mockRuntime(handler));
  assert.equal(memory.greeting, 'initial-hello');
  assert.equal(result, 'updated');
});

test('.memoryUpdate() errors when slot does not exist', async () => {
  const handler = scripted(['hello']);
  const pattern = Tree.name('m')
    .prompt(m => 'hello')
    .memoryUpdate('missing', (m, cur) => 'should fail');

  await assert.rejects(
    grandma.knit(pattern, mockRuntime(handler)),
    (err) => {
      assert.ok(err instanceof KnitError);
      assert.match(err.message, /does not exist in the scope chain/);
      return true;
    }
  );
});

test('.memoryUpdate() resolves from ancestor scope', async () => {
  const handler = scripted(['inner', 'updated']);
  const pattern = Tree.name('outer')
    .memory('slot', () => 'from-parent')
    .branch(
      Tree.name('inner')
        .prompt(m => 'inner')
        .memoryUpdate('slot', (m, cur) => `${cur}-updated`)
    )
    .prompt(m => m.branch.slot);

  const { result, memory } = await grandma.knit(pattern, mockRuntime(handler));
  assert.equal(memory.slot, 'from-parent-updated');
  assert.equal(result, 'updated');
});

test('.memoryUpdate() with gate skips when gate is false', async () => {
  const handler = scripted(['val']);
  const pattern = Tree.name('m')
    .memory('slot', () => 'original')
    .prompt(m => 'val')
    .memoryUpdate(when(m => false), 'slot', (m, cur) => 'should not run')
    .prompt(m => m.branch.slot);

  const { memory } = await grandma.knit(pattern, mockRuntime(handler));
  assert.equal(memory.slot, 'original');
});

test('.return() stops tree execution and exports value', async () => {
  const handler = scripted(['a', 'b', 'c']);
  const pattern = Tree.name('r')
    .prompt(m => 'first')
    .return(m => 'early')
    .prompt(m => 'should not run');

  const { result, memory } = await grandma.knit(pattern, mockRuntime(handler));
  assert.equal(result, 'early');
  assert.equal(handler.calls.length, 1); // only the first prompt ran
});

test('.return() with undefined continues the tree', async () => {
  const handler = scripted(['first', 'second']);
  const pattern = Tree.name('r')
    .prompt(m => 'first')
    .return(m => undefined) // don't return, continue
    .prompt(m => 'second');

  const { result } = await grandma.knit(pattern, mockRuntime(handler));
  assert.equal(result, 'second');
  assert.equal(handler.calls.length, 2); // both prompts ran
});

test('.return() with gate only fires when condition is true', async () => {
  const handler = scripted(['not-trigger', 'continued']);
  const pattern = Tree.name('r')
    .prompt(m => 'val')
    .return(when(m => m.prev[0] === 'trigger'), m => 'stopped')
    .prompt(m => 'continued');

  const { result } = await grandma.knit(pattern, mockRuntime(handler));
  assert.equal(result, 'continued'); // gate was false, return skipped
});

test('.return() with gate fires when condition is true', async () => {
  const handler = scripted(['trigger']);
  const pattern = Tree.name('r')
    .prompt(m => 'val')
    .return(when(m => m.prev[0] === 'trigger'), m => 'stopped')
    .prompt(m => 'should not run');

  const { result } = await grandma.knit(pattern, mockRuntime(handler));
  assert.equal(result, 'stopped');
  assert.equal(handler.calls.length, 1);
});

test('.map() runs subtree per element and collects results', async () => {
  const items = ['a', 'b', 'c'];
  let callIdx = 0;
  const calls = [];
  const handler = async (messages) => {
    calls.push(messages);
    return { content: `rated-${items[callIdx++]}` };
  };
  const sub = Tree.name('rate').prompt(m => `rate ${m.item}`);
  const pattern = Tree.name('m')
    .map('rated', m => items, sub);

  const { result, memory } = await grandma.knit(pattern, mockRuntime(handler));
  assert.deepEqual(result, ['rated-a', 'rated-b', 'rated-c']);
  assert.deepEqual(memory.rated, ['rated-a', 'rated-b', 'rated-c']);
  assert.equal(calls.length, 3);
});

test('.map() injects m.item for each invocation', async () => {
  const seen = [];
  const items = [{ name: 'x' }, { name: 'y' }];
  let callIdx = 0;
  const handler = async () => ({ content: `done-${callIdx++}` });
  const sub = Tree.name('s').prompt(m => { seen.push(m.item); return `done`; });
  const pattern = Tree.name('m').map('out', m => items, sub);

  await grandma.knit(pattern, mockRuntime(handler));
  assert.deepEqual(seen, [{ name: 'x' }, { name: 'y' }]);
});

test('.map() with empty array produces empty result', async () => {
  const handler = async () => ({ content: 'should not run' });
  const sub = Tree.name('s').prompt(m => 'x');
  const pattern = Tree.name('m').map('out', m => [], sub);

  const { result, memory } = await grandma.knit(pattern, mockRuntime(handler));
  assert.deepEqual(result, []);
  assert.deepEqual(memory.out, []);
});

test('.map() with gate skips when false', async () => {
  const handler = scripted(['val']);
  const sub = Tree.name('s').prompt(m => 'x');
  const pattern = Tree.name('m')
    .prompt(m => 'val')
    .map(when(m => false), 'out', m => ['a', 'b'], sub);

  const { memory } = await grandma.knit(pattern, mockRuntime(handler));
  assert.equal(memory.out, undefined);
});

test('.map() subtree can use .memory() and .return()', async () => {
  const items = [1, 2, 3];
  let callIdx = 0;
  const handler = async () => ({ content: `${items[callIdx++] * 10}` });
  const sub = Tree.name('transform')
    .prompt(m => `transform ${m.item}`)
    .memory('result', m => parseInt(m.prev[0]));
  const pattern = Tree.name('m').map('out', m => items, sub);

  const { result } = await grandma.knit(pattern, mockRuntime(handler));
  assert.deepEqual(result, [10, 20, 30]);
});

// --- pause/resume (human-in-the-loop) ---

test('.human() pauses execution and returns waiting status', async () => {
  const handler = scripted(['draft']);
  const pattern = Tree.name('review')
    .prompt(m => 'write draft')
    .human('approve');

  const result = await grandma.knit(pattern, mockRuntime(handler));
  assert.equal(result.status, 'waiting');
  assert.equal(result.humanSlot, 'approve');
  assert.ok(result.context);
  assert.ok(result.continuation);
  assert.equal(result.continuation._grandmaKatContinuation, true);
  assert.equal(handler.calls.length, 1); // only the prompt ran
});

test('.human() with contextFn provides context in pause result', async () => {
  const handler = scripted(['my draft']);
  const pattern = Tree.name('review')
    .prompt(m => 'write')
    .human('approve', m => ({ draft: m.prev[0] }));

  const result = await grandma.knit(pattern, mockRuntime(handler));
  assert.equal(result.status, 'waiting');
  assert.deepEqual(result.context, { draft: 'my draft' });
});

test('.human() resumes with human input and continues execution', async () => {
  const handler = scripted(['draft', 'final']);
  const pattern = Tree.name('review')
    .prompt(m => 'write draft')
    .human('approve')
    .prompt(m => `finalize: ${m.branch.approve}, draft: ${m.branch['review#1']}`);

  // First run — pauses at .human()
  const step1 = await grandma.knit(pattern, mockRuntime(handler));
  assert.equal(step1.status, 'waiting');
  assert.equal(step1.humanSlot, 'approve');
  assert.equal(handler.calls.length, 1); // only the first prompt ran

  // Resume with human input — uses a fresh handler
  const resumeHandler = scripted(['ok']);
  const step2 = await grandma.knit(pattern, {
    ...mockRuntime(resumeHandler),
    _continuation: step1.continuation,
    humanInput: { approve: 'yes' },
  });
  // The second prompt should see approve='yes' and review#1='draft'
  assert.equal(resumeHandler.calls.length, 1); // only the second prompt ran
  assert.ok(resumeHandler.calls[0].messages[0].content.includes('finalize: yes'));
  assert.ok(resumeHandler.calls[0].messages[0].content.includes('draft: draft'));
});

test('.human() preserves scope state across pause/resume', async () => {
  const handler = scripted(['hello', 'after']);
  const pattern = Tree.name('t')
    .prompt(m => 'greet')
    .memory('greeting', m => m.prev[0])
    .human('confirm')
    .prompt(m => `${m.branch.greeting}-${m.branch.confirm}`);

  const step1 = await grandma.knit(pattern, mockRuntime(handler));
  assert.equal(step1.status, 'waiting');

  // Verify continuation carries scope data
  assert.ok(step1.continuation.scopes.length > 0);

  const resumeHandler = scripted(['ok']);
  const step2 = await grandma.knit(pattern, {
    ...mockRuntime(resumeHandler),
    _continuation: step1.continuation,
    humanInput: { confirm: 'ok' },
  });
  // The second prompt should see greeting='hello' and confirm='ok'
  assert.equal(resumeHandler.calls.length, 1);
  assert.ok(resumeHandler.calls[0].messages[0].content.includes('hello-ok'));
});

test('.human() inside a branch — known limitation: branch result lost on resume', async () => {
  // When .human() is inside a branch, the branch's outcome was never recorded
  // in the parent scope (the pause happened before the branch returned). On
  // resume, the outer tree resumes PAST the branch, so the branch's result
  // is missing from m.branch.
  //
  // Workaround: place .human() at the same level as the branch, not inside it.
  // Full support for nested .human() requires branch-scope checkpointing
  // (deferred).
  const handler = scripted(['inner-prompt']);
  const pattern = Tree.name('outer')
    .branch(
      Tree.name('inner')
        .prompt(m => 'inner-prompt')
        .human('inner_approve')
    )
    .prompt(m => `read: ${m.branch.inner_approve ?? 'MISSING'}`);

  const step1 = await grandma.knit(pattern, mockRuntime(handler));
  assert.equal(step1.status, 'waiting');
  assert.equal(step1.humanSlot, 'inner_approve');

  // On resume, the inner tree resumes from its saved position (past the
  // prompt at index 0, starting at index 2 which is past all children).
  // The branch completes using the initial run's scope state.
  // The outer tree resumes past the branch (at index 1).
  const resumeHandler = scripted(['outer-result']);
  const step2 = await grandma.knit(pattern, {
    ...mockRuntime(resumeHandler),
    _continuation: step1.continuation,
    humanInput: { inner_approve: 'approved' },
  });
  // The outer prompt ran (handler called once for the outer prompt)
  assert.equal(resumeHandler.calls.length, 1);
  // The branch result was never recorded in the parent scope — it's lost.
  // But the human input IS available via scope chain (injected into root scope).
  assert.equal(step2.result, 'outer-result');
});

test('.human() with gate is skipped when gate is false', async () => {
  const handler = scripted(['draft', 'done']);
  const pattern = Tree.name('review')
    .prompt(m => 'write')
    .human(when(m => false), 'approve')
    .prompt(m => 'done');

  const { result } = await grandma.knit(pattern, mockRuntime(handler));
  assert.equal(result, 'done');
  assert.equal(handler.calls.length, 2); // both prompts ran, human skipped
});

test('.human() with .memory() writes human input to scope', async () => {
  const handler = scripted(['draft']);
  const pattern = Tree.name('review')
    .prompt(m => 'write')
    .human('feedback')
    .memory('saved_feedback', m => m.branch.feedback);

  // Initial run — pauses at .human()
  const step1 = await grandma.knit(pattern, mockRuntime(handler));
  assert.equal(step1.status, 'waiting');

  // Resume with human input — memory writes it to a named slot
  const h2 = scripted(['after']);
  const step2 = await grandma.knit(pattern, {
    ...mockRuntime(h2),
    _continuation: step1.continuation,
    humanInput: { feedback: 'approve' },
  });
  assert.equal(step2.memory.feedback, 'approve');
  assert.equal(step2.memory.saved_feedback, 'approve');
});

test('.human() inside .until() loop pauses each iteration', async () => {
  const handler = scripted(['try-1']);
  const pattern = Tree.name('loop')
    .prompt(m => `attempt`)
    .human('verdict')
    .until(m => m.branch.verdict === 'done', max(5));

  // Iteration 1 — pause
  const step1 = await grandma.knit(pattern, mockRuntime(handler));
  assert.equal(step1.status, 'waiting');

  // Iteration 1 — resume with 'not done', until fails, loops back
  const h2 = scripted(['try-2']);
  const step2 = await grandma.knit(pattern, {
    ...mockRuntime(h2),
    _continuation: step1.continuation,
    humanInput: { verdict: 'not done' },
  });
  assert.equal(step2.status, 'waiting'); // paused again on iteration 2
  assert.equal(h2.calls.length, 1); // prompt ran on the looped pass

  // Iteration 2 — resume with 'done', until passes, exits loop
  const h3 = scripted(['try-3']);
  const step3 = await grandma.knit(pattern, {
    ...mockRuntime(h3),
    _continuation: step2.continuation,
    humanInput: { verdict: 'done' },
  });
  assert.equal(step3.result, 'try-2'); // result from previous iteration's prompt
  assert.equal(h3.calls.length, 0); // until passed immediately, no LLM calls
});

test('.human() runId is preserved across pause/resume', async () => {
  const handler = scripted(['draft', 'final']);
  const pattern = Tree.name('t')
    .prompt(m => 'write')
    .human('ok')
    .prompt(m => 'done');

  const step1 = await grandma.knit(pattern, mockRuntime(handler));
  const step2 = await grandma.knit(pattern, {
    ...mockRuntime(handler),
    _continuation: step1.continuation,
    humanInput: { ok: 'yes' },
  });
  assert.equal(step1.continuation.runId, step2.runId);
});
