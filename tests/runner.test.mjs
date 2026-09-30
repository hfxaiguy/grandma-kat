import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import grandma, { Tree, when, update, goback, max, KnitError, disableAuto, Name, Model, Tools, Needs, Human, Prompt, Memory, Register, Branch, Map, Call, Check, Emit, Return, Until } from '../src/index.mjs';
import { scripted, mockRuntime, tool } from './helpers.mjs';

function tmpLogger() {
  return path.join(os.tmpdir(), `grandma-kat-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

test('basic pipeline: prompts chain via m.prev, result = last child', async () => {
  const seen = [];
  const handler = scripted(['outline', 'draft', 'final']);
  const pattern = Tree(Name('pipe')
    , Prompt(m => `task: ${m.task}`)
    , Prompt(m => { seen.push(m.prev.length); return `from: ${m.prev[0]}`; })
    , Prompt(m => `${m.prev[0]} + ${m.prev[1]}`));

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
  const pattern = Tree(Name('outer')
    , Branch(Tree(Name('inner'), Prompt(m => 'make')))
    , Prompt(m => { assert.equal(m.branch.inner, 'inner-value'); return 'done'; }));

  const { result, memory } = await grandma.knit(pattern, mockRuntime(handler));
  assert.equal(result, 'outer-read'); // leaf value = LLM response, not prompt text
  assert.equal(memory.inner, 'inner-value');
});

test('shadowing: nearest scope wins', async () => {
  const reads = [];
  const handler = scripted(['inner', 'read-inner', 'read-outer']);
  const pattern = Tree(Name('root')
    , Branch(
      Tree(Name('sub')
        , Prompt('task', m => 'inner') // shadows root input 'task' inside sub
        , Prompt(m => { reads.push(m.branch.task); return 'x'; }))
    )
    , Prompt(m => { reads.push(m.branch.task); return 'y'; }));

  await grandma.knit(pattern, mockRuntime(handler, { memory: { task: 'outer' } }));
  assert.deepEqual(reads, ['inner', 'outer']);
});

test('check failure sets m.error; goback retries with feedback', async () => {
  const handler = scripted(['bad answer', 'yes']);
  const pattern = Tree(Name('agent')
    , Prompt(m => `Met? ${m.error ?? 'Answer ONLY yes or no.'}`)
    , Check(
      m => m.prev[0] === 'yes' || m.prev[0] === 'no' || 'Answer with ONLY the word "yes" or "no".',
      goback(1, max(3))
    ));

  const { result } = await grandma.knit(pattern, mockRuntime(handler));
  assert.equal(result, 'yes');
  assert.equal(handler.calls.length, 2);
  // the retry saw the feedback in m.error
  assert.ok(handler.calls[1].messages[0].content.includes('Answer with ONLY the word'));
});

test('check exhaustion throws with authored error message', async () => {
  const handler = scripted(['bad', 'bad', 'bad', 'bad']);
  const pattern = Tree(Name('agent')
    , Prompt(m => 'answer')
    , Check(m => m.prev[0] === 'yes' || 'not yes', goback(1, max(2, m => `gave up: ${m.error}`))));

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
  const pattern = Tree(Name('loop')
    , Prompt(m => 'answer')
    , Until(m => m.prev[0] === 'yes', max(3)));

  const { result } = await grandma.knit(pattern, mockRuntime(handler));
  assert.equal(result, 'yes');
  assert.equal(handler.calls.length, 2);
});

test('until exhaustion throws', async () => {
  const handler = scripted(['no', 'no', 'no']);
  const pattern = Tree(Name('loop')
    , Prompt(m => 'answer')
    , Until(m => m.prev[0] === 'yes', max(2)));

  await assert.rejects(grandma.knit(pattern, mockRuntime(handler)), /exhausted/);
  assert.equal(handler.calls.length, 3); // 1 initial + 2 rewinds
});

test('gated children are skipped; m.prev stays dense', async () => {
  const prevs = [];
  const handler = scripted(['a', 'b']);
  const pattern = Tree(Name('gated')
    , Prompt(m => 'a')
    , Prompt(when(m => false), m => 'never runs')
    , Prompt(m => { prevs.push(m.prev[0]); return 'b'; }));

  const { result, memory } = await grandma.knit(pattern, mockRuntime(handler));
  assert.equal(result, 'b');
  assert.equal(handler.calls.length, 2); // gated prompt never invoked the LLM
  assert.equal(prevs[0], 'a'); // skipped child occupies no position
  assert.equal(memory['gated#2'], undefined); // no slot written
});

test('needs: missing input throws; injected memory satisfies', async () => {
  const missing = Tree(Name('t'), Needs('nope'), Prompt(m => 'x'));
  await assert.rejects(grandma.knit(missing, mockRuntime(scripted(['x']))), /no branch produces it/);

  const satisfied = Tree(Name('t'), Needs('task'), Prompt(m => `got ${m.task}`));
  const { result } = await grandma.knit(satisfied, mockRuntime(scripted(['ok']), { memory: { task: 'injected' } }));
  assert.equal(result, 'ok');
});

test('needs: missing at runtime (scope chain miss) throws loudly', async () => {
  // 'late' is produced inside the tree but AFTER the branch that needs it,
  // and not injected — runtime resolution must fail when the branch runs.
  const pattern = Tree(Name('root')
    , Branch(Tree(Name('needy'), Needs('late'), Prompt(m => 'x')))
    , Prompt('late', m => 'too late'));

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
  const pattern = Tree(Name('root')
    , Prompt(m => 'plain')
    , Branch(Tree(Name('fancy'), Model('b'), Prompt(m => 'fancy'))));

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
  const pattern = Tree(Name('agent')
    , Tools('search')
    , Prompt(disableAuto(), m => 'find something'));

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
  const pattern = Tree(Name('agent'), Tools('boom'), Prompt(disableAuto(), m => 'go'));

  const { result } = await grandma.knit(pattern, mockRuntime(handler, { tools }));
  // One LLM call — tool error is recorded, not fed back to the model.
  assert.equal(result, '');
  assert.equal(handler.calls.length, 1);
});

test('.call() leaf executes a tool directly with args from memory', async () => {
  const executed = [];
  const tools = { navigate: tool(async (args) => { executed.push(args); return 'navigated'; }) };
  const pattern = Tree(Name('agent')
    , Prompt(m => 'url please')
    , Call('navigate', m => ({ url: m.prev[0] })));

  const { result, memory } = await grandma.knit(pattern, mockRuntime(scripted(['http://x']), { tools }));
  assert.deepEqual(executed, [{ url: 'http://x' }]);
  assert.equal(result, 'navigated');
});

test('unknown tool in .tools() fails at knit() start with branch path', async () => {
  const pattern = Tree(Name('agent')
    , Tools('navigte') // typo
    , Prompt(m => 'go'));

  await assert.rejects(
    grandma.knit(pattern, mockRuntime(scripted(['x']), { tools: { navigate: tool(async () => 'ok') } })),
    /agent references unknown tool 'navigte'/);
});

test('reserved memory keys are rejected', async () => {
  const pattern = Tree(Name('t'), Prompt(m => 'x'));
  await assert.rejects(
    grandma.knit(pattern, mockRuntime(scripted(['x']), { memory: { prev: 1 } })),
    /reserved/);
});

test('tree with zero children is a build error', async () => {
  await assert.rejects(grandma.knit(Tree(Name('empty')), mockRuntime(scripted(['x']))), /zero children/);
});

test('sqlite logger writes rows', async () => {
  const tmp = path.join(os.tmpdir(), `grandma-kat-test-${Date.now()}.db`);
  try {
    const pattern = Tree(Name('logged'), Prompt(m => 'hi'));
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
    Tree(Name('s'), Prompt(m => 'v1')),
    mockRuntime(scripted(['v1'])));
  assert.equal(first.memory['s#1'], 'v1');

  const second = await grandma.knit(
    Tree(Name('s'), Prompt(m => `previous was ${m['s#1'] ?? 'nothing'}`)),
    mockRuntime(scripted(['v2']), { memory: first.memory }));
  assert.equal(second.result, 'v2');
  assert.ok(second.memory['s#1'] === 'v2');
});

test('.memory() writes to a named slot and produces m.prev output', async () => {
  const seen = [];
  const handler = scripted(['hello', 'result']);
  const pattern = Tree(Name('m')
    , Prompt(m => 'hello')
    , Memory('greeting', (m, cur) => m.prev[0])
    , Prompt(m => { seen.push({ greeting: m.branch.greeting, prevLen: m.prev.length }); return 'result'; }));

  const { result, memory } = await grandma.knit(pattern, mockRuntime(handler));
  // memory slot was written
  assert.equal(memory.greeting, 'hello');
  // .memory() now appears in m.prev — the second prompt sees prompt + memory
  assert.equal(seen[0].greeting, 'hello');
  assert.equal(seen[0].prevLen, 2);
});

test('.memory() with gate skips when gate is false', async () => {
  const handler = scripted(['val']);
  const pattern = Tree(Name('m')
    , Prompt(m => 'val')
    , Memory(when(m => false), 'skipped', (m, cur) => 'should not run')
    , Prompt(m => m.branch.skipped ?? 'empty'));

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
  const pattern = Tree(Name('loop')
    , Prompt('step', m => `iter`)
    , Memory('items', (m, cur) => [...(cur ?? []), m.branch.step])
    , Until(m => m.branch.step === 'done', max(5)));

  const { memory } = await grandma.knit(pattern, mockRuntime(handler));
  // items accumulated across all iterations including the final 'done' pass
  assert.deepEqual(memory.items, ['item-0', 'item-1', 'item-2', 'done']);
});

test('Memory(update(), …) updates an existing slot from parent scope', async () => {
  const handler = scripted(['hello', 'updated']);
  const pattern = Tree(Name('m')
    , Memory('greeting', () => 'initial')
    , Prompt(m => 'hello')
    , Memory(update(), 'greeting', (m, cur) => `${cur}-${m.prev[0]}`)
    , Prompt(m => m.branch.greeting));

  const { result, memory } = await grandma.knit(pattern, mockRuntime(handler));
  assert.equal(memory.greeting, 'initial-hello');
  assert.equal(result, 'updated');
});

test('.memory(update(), name, fn) executes as a memory update', async () => {
  const handler = scripted(['hello', 'updated']);
  const pattern = Tree(Name('m')
    , Memory('greeting', () => 'initial')
    , Prompt(m => 'hello')
    , Memory(update(), 'greeting', (m, cur) => `${cur}-${m.prev[0]}`)
    , Prompt(m => m.branch.greeting));

  const { result, memory } = await grandma.knit(pattern, mockRuntime(handler));
  assert.equal(memory.greeting, 'initial-hello');
  assert.equal(result, 'updated');
});

test('.memory(name, update(), fn) executes as a memory update too', async () => {
  const handler = scripted(['hello']);
  const pattern = Tree(Name('m')
    , Memory('greeting', () => 'initial')
    , Prompt(m => 'hello')
    , Memory('greeting', update(), (m, cur) => `${cur}-${m.prev[0]}`));

  const { memory } = await grandma.knit(pattern, mockRuntime(handler));
  assert.equal(memory.greeting, 'initial-hello');
});

test('Memory(update(), …) errors when the slot does not exist', async () => {
  const handler = scripted(['hello']);
  const pattern = Tree(Name('m')
    , Prompt(m => 'hello')
    , Memory(update(), 'missing', (m, cur) => 'should fail'));

  await assert.rejects(
    grandma.knit(pattern, mockRuntime(handler)),
    (err) => {
      assert.ok(err instanceof KnitError);
      assert.match(err.message, /does not exist in the scope chain/);
      return true;
    }
  );
});

test('Memory(update(), …) resolves from ancestor scope', async () => {
  const handler = scripted(['inner', 'updated']);
  const pattern = Tree(Name('outer')
    , Memory('slot', () => 'from-parent')
    , Branch(
      Tree(Name('inner')
        , Prompt(m => 'inner')
        , Memory(update(), 'slot', (m, cur) => `${cur}-updated`))
    )
    , Prompt(m => m.branch.slot));

  const { result, memory } = await grandma.knit(pattern, mockRuntime(handler));
  assert.equal(memory.slot, 'from-parent-updated');
  assert.equal(result, 'updated');
});

test('Memory(update(), …) with a gate skips when the gate is false', async () => {
  const handler = scripted(['val']);
  const pattern = Tree(Name('m')
    , Memory('slot', () => 'original')
    , Prompt(m => 'val')
    , Memory(update(), when(m => false), 'slot', (m, cur) => 'should not run')
    , Prompt(m => m.branch.slot));

  const { memory } = await grandma.knit(pattern, mockRuntime(handler));
  assert.equal(memory.slot, 'original');
});

test('memory writes are one record row with an op flag', async () => {
  const dbPath = tmpLogger();
  try {
    const pattern = Tree(Name('m')
      , Memory('slot', () => 'value')
      , Branch(Tree(Name('inner'), Memory(update(), 'slot', (m, cur) => `${cur}!`))));
    await grandma.knit(pattern, mockRuntime(scripted([]), { logger: dbPath }));

    const db = new DatabaseSync(dbPath, { readonly: true });
    const rows = db.prepare('SELECT kind, scope_id, content FROM calls ORDER BY seq').all();
    db.close();

    assert.equal(rows.filter((r) => r.kind === 'memory').length, 0, 'no separate memory rows');
    const writes = rows
      .filter((r) => r.kind === 'record')
      .map((r) => ({ ...JSON.parse(r.content), scope_id: r.scope_id }))
      .filter((c) => c.op === 'memory' || c.op === 'memoryUpdate');
    assert.deepEqual(writes.map((w) => [w.child, w.op]), [['slot', 'memory'], ['slot', 'memoryUpdate']]);

    // The update lands in the declaring (root) scope but ran in the branch:
    // execScopeId records the second so resume can restore prev correctly.
    const upd = writes[1];
    assert.ok(upd.execScopeId != null, 'memoryUpdate carries its executing scope');
    assert.notEqual(upd.scope_id, upd.execScopeId);
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
});

test('resume restores prev for memoryUpdate on the executing scope', async () => {
  const dbPath = tmpLogger();
  try {
    const pattern = Tree(Name('m')
      , Memory('slot', () => 'init')
      , Branch(
        Tree(Name('inner')
          , Memory(update(), 'slot', (m, cur) => `${cur}+`)
          , Human('go')
          , Prompt((m) => `prev=${m.prev[0] ?? 'none'}`))
      ));

    const step1 = await grandma.knit(pattern, mockRuntime(scripted([]), { logger: dbPath }));
    assert.equal(step1.status, 'waiting');

    const resumeHandler = scripted(['after']);
    await grandma.resume(step1.continuation, {
      ...mockRuntime(resumeHandler, { logger: dbPath }),
      humanInput: { go: 'ok' },
    });

    assert.equal(resumeHandler.calls.length, 1);
    assert.ok(
      resumeHandler.calls[0].messages[0].content.includes('prev=init+'),
      'the branch scope prev must carry the memoryUpdate value',
    );
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
});

test('a failed resume keeps its checkpoint for a retry', async () => {
  const dbPath = tmpLogger();
  try {
    let fail = true;
    const pattern = Tree(Name('t')
      , Human('ask')
      , Memory('answer', () => {
        if (fail) throw new Error('boom');
        return 'ok';
      })
      , Return(m => m.answer));

    const step1 = await grandma.knit(pattern, mockRuntime(scripted([]), { logger: dbPath }));
    assert.equal(step1.status, 'waiting');

    await assert.rejects(
      grandma.resume(step1.continuation, {
        ...mockRuntime(scripted([]), { logger: dbPath }),
        humanInput: { ask: 'hi' },
      }),
      /boom/,
    );

    // The failure did not consume the checkpoint, so the same continuation
    // can retry — the fixed code below succeeds on the second attempt.
    fail = false;
    const step2 = await grandma.resume(step1.continuation, {
      ...mockRuntime(scripted([]), { logger: dbPath }),
      humanInput: { ask: 'hi' },
    });
    assert.equal(step2.result, 'ok');
    assert.equal(step2.memory.answer, 'ok');
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
});

test('an unnamed branch is auto-named and runs', async () => {
  const dbPath = tmpLogger();
  try {
    const handler = scripted(['outer', 'inner']);
    const pattern = Tree(Name('t')
      , Prompt(m => 'outer')
      , Branch(Tree(Prompt(m => `inner sees ${m['t#1']}`))));

    const { result, memory } = await grandma.knit(pattern, mockRuntime(handler, { logger: dbPath }));
    assert.equal(result, 'inner');
    // The branch takes the auto name of its child slot in the parent scope.
    assert.equal(memory['t#2'], 'inner');

    const db = new DatabaseSync(dbPath, { readonly: true });
    const row = db.prepare("SELECT branch_path FROM calls WHERE kind = 'llm_call' ORDER BY seq DESC LIMIT 1").get();
    db.close();
    assert.equal(row.branch_path, 't/t#2');
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
});

test('resume works through an unnamed branch', async () => {
  const dbPath = tmpLogger();
  try {
    const pattern = Tree(Name('t')
      , Branch(
        Tree(Prompt(m => 'ask')
          , Human('reply')
          , Prompt(m => `got ${m.branch.reply ?? 'nothing'}`))
      ));

    const step1 = await grandma.knit(pattern, mockRuntime(scripted(['q']), { logger: dbPath }));
    assert.equal(step1.status, 'waiting');

    const resumeHandler = scripted(['a']);
    const step2 = await grandma.resume(step1.continuation, {
      ...mockRuntime(resumeHandler, { logger: dbPath }),
      humanInput: { reply: 'hi' },
    });
    assert.equal(step2.result, 'a');
    assert.ok(resumeHandler.calls[0].messages[0].content.includes('got hi'));
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
});

test('an unnamed .map() subtree is auto-named after the collection', async () => {
  const dbPath = tmpLogger();
  try {
    const handler = scripted(['x', 'x']);
    const pattern = Tree(Name('t')
      , Map('rated', () => [1, 2], Tree(Prompt(m => `rate ${m.item}`))));

    const { memory } = await grandma.knit(pattern, mockRuntime(handler, { logger: dbPath }));
    assert.deepEqual(memory.rated, ['x', 'x']);

    const db = new DatabaseSync(dbPath, { readonly: true });
    const row = db.prepare("SELECT branch_path FROM calls WHERE kind = 'llm_call' ORDER BY seq LIMIT 1").get();
    db.close();
    assert.equal(row.branch_path, 't/rated');
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
});

test('.return() stops tree execution and exports value', async () => {
  const handler = scripted(['a', 'b', 'c']);
  const pattern = Tree(Name('r')
    , Prompt(m => 'first')
    , Return(m => 'early')
    , Prompt(m => 'should not run'));

  const { result, memory } = await grandma.knit(pattern, mockRuntime(handler));
  assert.equal(result, 'early');
  assert.equal(handler.calls.length, 1); // only the first prompt ran
});

test('.return() with undefined continues the tree', async () => {
  const handler = scripted(['first', 'second']);
  const pattern = Tree(Name('r')
    , Prompt(m => 'first')
    , Return(m => undefined) // don't return, continue
    , Prompt(m => 'second'));

  const { result } = await grandma.knit(pattern, mockRuntime(handler));
  assert.equal(result, 'second');
  assert.equal(handler.calls.length, 2); // both prompts ran
});

test('.return() with gate only fires when condition is true', async () => {
  const handler = scripted(['not-trigger', 'continued']);
  const pattern = Tree(Name('r')
    , Prompt(m => 'val')
    , Return(when(m => m.prev[0] === 'trigger'), m => 'stopped')
    , Prompt(m => 'continued'));

  const { result } = await grandma.knit(pattern, mockRuntime(handler));
  assert.equal(result, 'continued'); // gate was false, return skipped
});

test('.return() with gate fires when condition is true', async () => {
  const handler = scripted(['trigger']);
  const pattern = Tree(Name('r')
    , Prompt(m => 'val')
    , Return(when(m => m.prev[0] === 'trigger'), m => 'stopped')
    , Prompt(m => 'should not run'));

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
  const sub = Tree(Name('rate'), Prompt(m => `rate ${m.item}`));
  const pattern = Tree(Name('m')
    , Map('rated', m => items, sub));

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
  const sub = Tree(Name('s'), Prompt(m => { seen.push(m.item); return `done`; }));
  const pattern = Tree(Name('m'), Map('out', m => items, sub));

  await grandma.knit(pattern, mockRuntime(handler));
  assert.deepEqual(seen, [{ name: 'x' }, { name: 'y' }]);
});

test('.map() with empty array produces empty result', async () => {
  const handler = async () => ({ content: 'should not run' });
  const sub = Tree(Name('s'), Prompt(m => 'x'));
  const pattern = Tree(Name('m'), Map('out', m => [], sub));

  const { result, memory } = await grandma.knit(pattern, mockRuntime(handler));
  assert.deepEqual(result, []);
  assert.deepEqual(memory.out, []);
});

test('.map() with gate skips when false', async () => {
  const handler = scripted(['val']);
  const sub = Tree(Name('s'), Prompt(m => 'x'));
  const pattern = Tree(Name('m')
    , Prompt(m => 'val')
    , Map(when(m => false), 'out', m => ['a', 'b'], sub));

  const { memory } = await grandma.knit(pattern, mockRuntime(handler));
  assert.equal(memory.out, undefined);
});

test('.map() subtree can use .memory() and .return()', async () => {
  const items = [1, 2, 3];
  let callIdx = 0;
  const handler = async () => ({ content: `${items[callIdx++] * 10}` });
  const sub = Tree(Name('transform')
    , Prompt(m => `transform ${m.item}`)
    , Memory('result', m => parseInt(m.prev[0])));
  const pattern = Tree(Name('m'), Map('out', m => items, sub));

  const { result } = await grandma.knit(pattern, mockRuntime(handler));
  assert.deepEqual(result, [10, 20, 30]);
});

// --- pause/resume (human-in-the-loop) ---

test('.human() pauses execution and returns waiting status', async () => {
  const handler = scripted(['draft']);
  const dbPath = tmpLogger();
  try {
    const pattern = Tree(Name('review')
      , Prompt(m => 'write draft')
      , Human('approve'));

    const result = await grandma.knit(pattern, mockRuntime(handler, { logger: dbPath }));
    assert.equal(result.status, 'waiting');
    assert.equal(result.humanSlot, 'approve');
    assert.ok(result.context);
    assert.ok(typeof result.continuation === 'string');
    assert.equal(handler.calls.length, 1); // only the prompt ran
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
});

test('.human() with contextFn provides context in pause result', async () => {
  const handler = scripted(['my draft']);
  const dbPath = tmpLogger();
  try {
    const pattern = Tree(Name('review')
      , Prompt(m => 'write')
      , Human('approve', m => ({ draft: m.prev[0] })));

    const result = await grandma.knit(pattern, mockRuntime(handler, { logger: dbPath }));
    assert.equal(result.status, 'waiting');
    assert.deepEqual(result.context, { draft: 'my draft' });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
});

test('.human() emits context via onEmit before pausing', async () => {
  const handler = scripted(['my draft']);
  const dbPath = tmpLogger();
  try {
    const emitted = [];
    const pattern = Tree(Name('review')
      , Prompt(m => 'write')
      , Human('approve', m => ({ draft: m.prev[0] })));

    const result = await grandma.knit(pattern, {
      ...mockRuntime(handler, { logger: dbPath }),
      onEmit: (v) => emitted.push(v),
    });
    assert.equal(result.status, 'waiting');
    assert.deepEqual(result.context, { draft: 'my draft' });
    // onEmit was called with the context before pausing
    assert.deepEqual(emitted, [{ draft: 'my draft' }]);
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
});

test('.human() without contextFn does not call onEmit', async () => {
  const handler = scripted(['draft']);
  const dbPath = tmpLogger();
  try {
    const emitted = [];
    const pattern = Tree(Name('review')
      , Prompt(m => 'write')
      , Human('approve'));

    const result = await grandma.knit(pattern, {
      ...mockRuntime(handler, { logger: dbPath }),
      onEmit: (v) => emitted.push(v),
    });
    assert.equal(result.status, 'waiting');
    assert.equal(emitted.length, 0); // no context, no emit
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
});

test('.human() resumes with human input and continues execution', async () => {
  const handler = scripted(['draft', 'final']);
  const dbPath = tmpLogger();
  try {
    const pattern = Tree(Name('review')
      , Prompt(m => 'write draft')
      , Human('approve')
      , Prompt(m => `finalize: ${m.branch.approve}, draft: ${m.branch['review#1']}`));

    // First run — pauses at .human()
    const step1 = await grandma.knit(pattern, mockRuntime(handler, { logger: dbPath }));
    assert.equal(step1.status, 'waiting');
    assert.equal(step1.humanSlot, 'approve');
    assert.equal(handler.calls.length, 1); // only the first prompt ran

    // Resume with human input
    const resumeHandler = scripted(['ok']);
    const step2 = await grandma.resume(step1.continuation, {
      ...mockRuntime(resumeHandler, { logger: dbPath }),
      humanInput: { approve: 'yes' },
    });
    // The second prompt should see approve='yes' and review#1='draft'
    assert.equal(resumeHandler.calls.length, 1); // only the second prompt ran
    assert.ok(resumeHandler.calls[0].messages[0].content.includes('finalize: yes'));
    assert.ok(resumeHandler.calls[0].messages[0].content.includes('draft: draft'));
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
});

test('.human() preserves scope state across pause/resume', async () => {
  const handler = scripted(['hello', 'after']);
  const dbPath = tmpLogger();
  try {
    const pattern = Tree(Name('t')
      , Prompt(m => 'greet')
      , Memory('greeting', m => m.prev[0])
      , Human('confirm')
      , Prompt(m => `${m.branch.greeting}-${m.branch.confirm}`));

    const step1 = await grandma.knit(pattern, mockRuntime(handler, { logger: dbPath }));
    assert.equal(step1.status, 'waiting');

    const resumeHandler = scripted(['ok']);
    const step2 = await grandma.resume(step1.continuation, {
      ...mockRuntime(resumeHandler, { logger: dbPath }),
      humanInput: { confirm: 'ok' },
    });
    // The second prompt should see greeting='hello' and confirm='ok'
    assert.equal(resumeHandler.calls.length, 1);
    assert.ok(resumeHandler.calls[0].messages[0].content.includes('hello-ok'));
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
});

test('.human() inside a branch — branch result is preserved on resume', async () => {
  const handler = scripted(['inner-prompt']);
  const dbPath = tmpLogger();
  try {
    const pattern = Tree(Name('outer')
      , Branch(
        Tree(Name('inner')
          , Prompt(m => 'inner-prompt')
          , Human('inner_approve')
          , Prompt(m => `after:${m.branch.inner_approve}`))
      )
      , Prompt(m => {
        // Runs after resume; must see the branch's exported value — which is
        // the post-human prompt's result ('post-human-result'), not stale.
        assert.equal(m.branch.inner, 'post-human-result');
        return `read: ${m.branch.inner_approve}`;
      }));

    const step1 = await grandma.knit(pattern, mockRuntime(handler, { logger: dbPath }));
    assert.equal(step1.status, 'waiting');
    assert.equal(step1.humanSlot, 'inner_approve');

    // On resume the branch finishes: its post-human prompt runs first, then
    // the outer prompt.
    const resumeHandler = scripted(['post-human-result', 'outer-result']);
    const step2 = await grandma.resume(step1.continuation, {
      ...mockRuntime(resumeHandler, { logger: dbPath }),
      humanInput: { inner_approve: 'approved' },
    });
    assert.equal(resumeHandler.calls.length, 2); // post-human + outer
    assert.equal(step2.result, 'outer-result');
    assert.equal(step2.memory.inner, 'post-human-result');
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
});

test('.human() as a leaf followed by a .branch() resumes cleanly', async () => {
  // Regression: a root-level .human() whose NEXT sibling is a .branch() used
  // to crash resume (resume re-descended into the branch with an
  // already-consumed stack entry). The branch must run fresh after resume.
  const handler = scripted([]);
  const dbPath = tmpLogger();
  try {
    const pattern = Tree(Name('outer')
      , Human('input_1')
      , Branch(
        Tree(Name('scan')
          , Prompt(m => `scan:${m.branch.input_1}`))
      ));

    const step1 = await grandma.knit(pattern, mockRuntime(handler, { logger: dbPath }));
    assert.equal(step1.status, 'waiting');

    const resumeHandler = scripted(['scan-result']);
    const step2 = await grandma.resume(step1.continuation, {
      ...mockRuntime(resumeHandler, { logger: dbPath }),
      humanInput: 'hello',
    });
    assert.equal(resumeHandler.calls.length, 1); // the gated branch ran once
    assert.equal(step2.result, 'scan-result');
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
});

test('.human() inside a .map() resumes from the paused item', async () => {
  // Regression: .human() inside a .map() subtree used to lose the whole map
  // result on resume (returned undefined). The paused item must resume from
  // its saved position and the remaining items must run, producing the full
  // result array.
  const handler = scripted(['pre-1']);
  const dbPath = tmpLogger();
  try {
    const pattern = Tree(Name('outer')
      , Map('r', m => [1, 2],
        Tree(Name('item')
          , Prompt('pre', m => `pre-${m.item}`)
          , Human(when(m => m.item === 1), 'approve')
          , Prompt('post', m => `post-${m.item}`))
      ));

    const step1 = await grandma.knit(pattern, mockRuntime(handler, { logger: dbPath }));
    assert.equal(step1.status, 'waiting');
    assert.equal(step1.humanSlot, 'approve');

    // On resume: item 1 finishes (post-1), item 2 runs fresh (pre-2, post-2).
    const resumeHandler = scripted(['post-1-result', 'pre-2-result', 'post-2-result']);
    const step2 = await grandma.resume(step1.continuation, {
      ...mockRuntime(resumeHandler, { logger: dbPath }),
      humanInput: { approve: 'yes' },
    });
    // Both items completed: the paused item resumed past its human, and the
    // remaining item ran fully. The result array has both values (each is
    // the item's last child).
    assert.ok(Array.isArray(step2.result));
    assert.equal(step2.result.length, 2);
    assert.equal(step2.result[0], 'post-1-result');
    assert.equal(step2.result[1], 'post-2-result');
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
});

test('.human() with gate is skipped when gate is false', async () => {
  const handler = scripted(['draft', 'done']);
  const pattern = Tree(Name('review')
    , Prompt(m => 'write')
    , Human(when(m => false), 'approve')
    , Prompt(m => 'done'));

  const { result } = await grandma.knit(pattern, mockRuntime(handler));
  assert.equal(result, 'done');
  assert.equal(handler.calls.length, 2); // both prompts ran, human skipped
});

test('.human() with .memory() writes human input to scope', async () => {
  const handler = scripted(['draft']);
  const dbPath = tmpLogger();
  try {
    const pattern = Tree(Name('review')
      , Prompt(m => 'write')
      , Human('feedback')
      , Memory('saved_feedback', m => m.branch.feedback));

    // Initial run — pauses at .human()
    const step1 = await grandma.knit(pattern, mockRuntime(handler, { logger: dbPath }));
    assert.equal(step1.status, 'waiting');

    // Resume with human input — memory writes it to a named slot
    const h2 = scripted(['after']);
    const step2 = await grandma.resume(step1.continuation, {
      ...mockRuntime(h2, { logger: dbPath }),
      humanInput: { feedback: 'approve' },
    });
    assert.equal(step2.memory.feedback, 'approve');
    assert.equal(step2.memory.saved_feedback, 'approve');
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
});

test('.human() inside .until() loop pauses each iteration', async () => {
  const handler = scripted(['try-1']);
  const dbPath = tmpLogger();
  try {
    const pattern = Tree(Name('loop')
      , Prompt(m => `attempt`)
      , Human('verdict')
      , Until(m => m.branch.verdict === 'done', max(5)));

    // Iteration 1 — pause
    const step1 = await grandma.knit(pattern, mockRuntime(handler, { logger: dbPath }));
    assert.equal(step1.status, 'waiting');

    // Iteration 1 — resume with 'not done', until fails, loops back
    const h2 = scripted(['try-2']);
    const step2 = await grandma.resume(step1.continuation, {
      ...mockRuntime(h2, { logger: dbPath }),
      humanInput: { verdict: 'not done' },
    });
    assert.equal(step2.status, 'waiting'); // paused again on iteration 2
    assert.equal(h2.calls.length, 1); // prompt ran on the looped pass

    // Iteration 2 — resume with 'done', until passes, exits loop
    const h3 = scripted(['try-3']);
    const step3 = await grandma.resume(step2.continuation, {
      ...mockRuntime(h3, { logger: dbPath }),
      humanInput: { verdict: 'done' },
    });
    assert.equal(step3.result, 'try-2'); // result from previous iteration's prompt
    assert.equal(h3.calls.length, 0); // until passed immediately, no LLM calls
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
});

test('.human() runId is preserved across pause/resume', async () => {
  const handler = scripted(['draft', 'final']);
  const dbPath = tmpLogger();
  try {
    const pattern = Tree(Name('t')
      , Prompt(m => 'write')
      , Human('ok')
      , Prompt(m => 'done'));

    const step1 = await grandma.knit(pattern, mockRuntime(handler, { logger: dbPath }));
    const step2 = await grandma.resume(step1.continuation, {
      ...mockRuntime(handler, { logger: dbPath }),
      humanInput: { ok: 'yes' },
    });
    // continuation is a string (checkpoint ID)
    assert.equal(typeof step1.continuation, 'string');
    assert.equal(typeof step2.runId, 'string');
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
});

// --- emit (non-blocking output) ---

test('.emit() calls onEmit with computed value and continues', async () => {
  const emitted = [];
  const handler = scripted(['hello']);
  const pattern = Tree(Name('agent')
    , Emit(m => ({ text: 'thinking...' }))
    , Prompt(m => 'hello')
    , Emit(m => ({ text: `result: ${m.prev[0]}` })));

  const { result } = await grandma.knit(pattern, {
    ...mockRuntime(handler),
    onEmit: (v) => emitted.push(v),
  });
  assert.deepEqual(emitted, [{ text: 'thinking...' }, { text: 'result: hello' }]);
  assert.equal(result, 'hello');
});

test('.emit() does NOT write to m.prev', async () => {
  const emitted = [];
  const prevs = [];
  const handler = scripted(['a', 'b']);
  const pattern = Tree(Name('agent')
    , Prompt(m => 'a')
    , Emit(m => { emitted.push('emit1'); return 'e1'; })
    , Prompt(m => { prevs.push(m.prev.length); return 'b'; }));

  await grandma.knit(pattern, {
    ...mockRuntime(handler),
    onEmit: () => {},
  });
  assert.equal(prevs[0], 1);
  assert.equal(emitted.length, 1);
});

test('.emit() with gate skips when false', async () => {
  const emitted = [];
  const handler = scripted(['a', 'b']);
  const pattern = Tree(Name('agent')
    , Prompt(m => 'a')
    , Emit(when(m => false), m => 'should not emit')
    , Prompt(m => 'b'));

  const { result } = await grandma.knit(pattern, {
    ...mockRuntime(handler),
    onEmit: (v) => emitted.push(v),
  });
  assert.equal(emitted.length, 0);
  assert.equal(result, 'b');
});

test('.emit() works without onEmit (no-op)', async () => {
  const handler = scripted(['x']);
  const pattern = Tree(Name('agent')
    , Emit(m => 'ignored')
    , Prompt(m => 'x'));

  const { result } = await grandma.knit(pattern, mockRuntime(handler));
  assert.equal(result, 'x');
});

test('.emit() inside .until() loop fires each iteration', async () => {
  const emitted = [];
  let i = 0;
  const handler = async () => {
    if (i++ < 2) return { content: 'no' };
    return { content: 'yes' };
  };
  const pattern = Tree(Name('loop')
    , Prompt(m => 'ask')
    , Emit(m => ({ attempt: i }))
    , Until(m => m.prev[0] === 'yes', max(5)));

  const { result } = await grandma.knit(pattern, {
    ...mockRuntime(handler),
    onEmit: (v) => emitted.push(v),
  });
  assert.equal(result, 'yes');
  assert.equal(emitted.length, 3);
});

// ── trees as tools ────────────────────────────────────────────────────────
// A runtime tool entry may declare `tree: <name|def>` instead of execute().
// The model (and .call()) invokes it like any tool; the engine runs the
// subtree in a child scope seeded with the call args, and the subtree's
// exported value becomes the tool result. A pause inside the subtree
// suspends the whole run and resumes in place — the calling prompt round is
// replayed from the log, never re-sent to the model.

const tc = (name, args, id = name) => ({
  id,
  function: { name, arguments: JSON.stringify(args ?? {}) },
});

// ── inline tool registers (`.register()`) ──────────────────────────────────
// A register is a declaration: installed into the run's tool table before
// execution, so position does not matter and a pause cannot lose it.

test('.register() is hoisted: a declaration after its call site still resolves', async () => {
  const pattern = Tree(Name('late_register')
    , Call('lookup', () => ({ name: 'Ada' }))
    , Register('lookup', 'Find a person by name', (m, args) => `found:${args.name}`));

  const { result } = await grandma.knit(pattern, mockRuntime(scripted([])));
  assert.equal(result, 'found:Ada');
});

test('.register() fn reads the memory of the scope it is called from', async () => {
  const pattern = Tree(Name('register_scope')
    , Register('peek', 'Read the local slot', (m) => m.local ?? 'missing')
    , Branch(
      Tree(Name('inner_scope')
        , Memory('local', () => 'inner-ctx')
        , Call('peek', () => ({})))
    ));

  const { memory } = await grandma.knit(pattern, mockRuntime(scripted([])));
  assert.equal(memory.inner_scope, 'inner-ctx');
});

test('.register() exposes the inline tool to the model via .tools()', async () => {
  const handler = scripted([
    { content: '', tool_calls: [tc('lookup', { name: 'Ada' })] },
    'reported',
  ]);
  const pattern = Tree(Name('register_model')
    , Register('lookup', 'Find a person by name', (m, args) => ({ phone: `555-${args.name}` }))
    , Tools('lookup')
    , Prompt(m => 'find Ada')
    , Memory('phone', m => m.raw.branch['register_model#1'].toolResults[0].result.phone));

  const { memory } = await grandma.knit(pattern, mockRuntime(handler));
  assert.equal(memory.phone, '555-Ada');
  assert.equal(handler.calls[0].tools[0].function.description, 'Find a person by name');
});

test('.register() error-shaped results are tool errors, not fatal', async () => {
  const handler = scripted([
    { content: '', tool_calls: [tc('flaky', {})] },
    'next',
  ]);
  const pattern = Tree(Name('register_err')
    , Register('flaky', 'Always fails', () => ({ error: 'no can do' }))
    , Tools('flaky')
    , Prompt(m => 'go')
    , Memory('isError', m => m.raw.branch['register_err#1'].toolResults[0].isError));

  const { memory } = await grandma.knit(pattern, mockRuntime(handler));
  assert.equal(memory.isError, true);
});

test('.register() survives a pause: the tool still resolves after resume', async () => {
  const dbPath = tmpLogger();
  try {
    const pattern = Tree(Name('register_resume')
      , Register('lookup', 'Find a person by name', (m, args) => `found:${args.name}`)
      , Prompt(m => 'start')
      , Human('reply')
      , Call('lookup', () => ({ name: 'Ada' })));

    const step1 = await grandma.knit(pattern, mockRuntime(scripted(['hello']), { logger: dbPath }));
    assert.equal(step1.status, 'waiting');

    const step2 = await grandma.resume(step1.continuation, {
      ...mockRuntime(scripted([]), { logger: dbPath }),
      humanInput: { reply: 'go' },
    });
    assert.equal(step2.result, 'found:Ada');
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
});

test('.register() shadows a same-named runtime tool for that run', async () => {
  const tools = { lookup: tool(async () => 'host result') };
  const pattern = Tree(Name('register_shadow')
    , Register('lookup', 'Inline keeps the wheel', () => 'inline result')
    , Call('lookup', () => ({})));

  const { result } = await grandma.knit(pattern, mockRuntime(scripted([]), { tools }));
  assert.equal(result, 'inline result');
});

test('duplicate .register() names fail at knit() start', async () => {
  const pattern = Tree(Name('register_dup')
    , Register('lookup', 'One', () => 'a')
    , Register('lookup', 'Two', () => 'b')
    , Prompt(m => 'go'));

  await assert.rejects(
    grandma.knit(pattern, mockRuntime(scripted(['x']))),
    /duplicate \.register\('lookup'\)/);
});

test('a .call() to a tree tool runs the subtree with seeded args', async () => {
  const child = Tree(Name('greeter'), Needs('who'), Prompt(m => `hello ${m.who}`));
  const handler = scripted(['hi']);
  const pattern = Tree(Name('host')
    , Call('greet', 'greeter_tool', () => ({ who: 'Ada' }))
    , Memory('seen', m => m.branch.greet));

  const { memory } = await grandma.knit(pattern, mockRuntime(handler, {
    tools: { greeter_tool: { description: 'greet', parameters: {}, tree: child } },
  }));

  assert.equal(memory.greet, 'hi');           // subtree export = tool result
  assert.equal(memory.seen, 'hi');
  assert.equal(handler.calls.length, 1);
  assert.equal(handler.calls[0].messages[0].content, 'hello Ada'); // seeded slot
});

test('a model tool call to a tree tool returns the subtree export as the tool result', async () => {
  const child = Tree(Name('finder'), Prompt(m => `looking for ${m.query}`));
  const handler = scripted([
    { content: '', tool_calls: [tc('finder_tool', { query: 'keys' })] },
    'searching',
  ]);
  const pattern = Tree(Name('host')
    , Tools('finder_tool')
    , Prompt(disableAuto(), 'act', () => 'go')
    , Memory('seen', m => m.raw.branch.act.toolResults[0].result));

  const { memory } = await grandma.knit(pattern, mockRuntime(handler, {
    tools: { finder_tool: { description: 'find', parameters: {}, tree: child } },
  }));

  assert.equal(memory.seen, 'searching');
  assert.equal(handler.calls.length, 2);
  assert.equal(handler.calls[1].messages[0].content, 'looking for keys');
});

test('a pause inside a model-called tree resumes without re-calling the model', async () => {
  const child = Tree(Name('interview')
    , Prompt(m => `q for ${m.topic}`)
    , Human('answer')
    , Memory('out', m => `got: ${m.answer}`));

  const handler = scripted([
    { content: '', tool_calls: [tc('ask', { topic: 'cats' })] },
    'child says hi',
    'host done',
  ]);
  const runtime = mockRuntime(handler, {
    logger: tmpLogger(),
    tools: { ask: { description: 'ask', parameters: {}, tree: child } },
  });
  const pattern = Tree(Name('host')
    , Tools('ask')
    , Prompt(disableAuto(), 'act', () => 'go')
    , Prompt('after', m => `tool said: ${m.raw.branch.act.toolResults[0].result}`)
    , Memory('seen', m => m.raw.branch.act.toolResults[0].result));

  const first = await grandma.knit(pattern, runtime);
  assert.equal(first.status, 'waiting');
  assert.equal(first.humanSlot, 'answer');
  assert.equal(handler.calls.length, 2); // host round + the child prompt, then the pause

  const second = await grandma.knit(pattern, {
    ...runtime,
    _continuation: first.continuation,
    humanInput: 'purr',
  });
  assert.equal(second.status, undefined);
  assert.equal(handler.calls.length, 3, 'the round was replayed — the child prompt did not re-run');
  assert.equal(second.memory.seen, 'got: purr', 'the subtree export came back as the tool result');
});

test('a pause inside a .call() tree resumes structurally', async () => {
  const child = Tree(Name('asker')
    , Prompt(() => 'question')
    , Human('answer')
    , Memory('out', m => `answer: ${m.answer}`));

  const handler = scripted(['child prompt']);
  const runtime = mockRuntime(handler, { logger: tmpLogger(), tools: { asker_tool: { tree: child } } });
  const pattern = Tree(Name('host')
    , Call('run', 'asker_tool', () => ({}))
    , Memory('seen', m => m.branch.run));

  const first = await grandma.knit(pattern, runtime);
  assert.equal(first.status, 'waiting');
  assert.equal(first.humanSlot, 'answer');
  assert.equal(handler.calls.length, 1);

  const second = await grandma.knit(pattern, {
    ...runtime,
    _continuation: first.continuation,
    humanInput: 'b',
  });
  assert.equal(second.status, undefined);
  assert.equal(handler.calls.length, 1, 'the subtree finished without further model calls');
  assert.equal(second.memory.seen, 'answer: b');
});

test('completed sibling tool calls are replayed, not re-executed, after a pause', async () => {
  const effects = [];
  const child = Tree(Name('nested'), Human('go'), Memory('out', () => 'nested done'));
  const handler = scripted([
    { content: '', tool_calls: [tc('effect', { n: 1 }, 'c1'), tc('ask', {}, 'c2')] },
  ]);
  const runtime = mockRuntime(handler, {
    logger: tmpLogger(),
    tools: {
      effect: tool((args) => { effects.push(args); return { ok: true, n: effects.length }; }),
      ask: { description: 'ask', parameters: {}, tree: child },
    },
  });
  const pattern = Tree(Name('host')
    , Tools('effect', 'ask')
    , Prompt(disableAuto(), 'act', () => 'go')
    , Memory('first', m => m.raw.branch.act.toolResults[0].result)
    , Memory('second', m => m.raw.branch.act.toolResults[1].result));

  const first = await grandma.knit(pattern, runtime);
  assert.equal(first.status, 'waiting');
  assert.equal(first.humanSlot, 'go');
  assert.equal(effects.length, 1);

  const second = await grandma.knit(pattern, {
    ...runtime,
    _continuation: first.continuation,
    humanInput: 'x',
  });
  assert.equal(second.status, undefined);
  assert.equal(effects.length, 1, 'the completed sibling effect was replayed, not re-run');
  assert.deepEqual(second.memory.first, { ok: true, n: 1 });
  assert.equal(second.memory.second, 'nested done');
});

test('a subtree failure surfaces as an isError tool result', async () => {
  const child = Tree(Name('flaky')
    , Prompt(() => 'try')
    , Check(() => 'nope', goback(1, max(1))));
  const handler = scripted([
    { content: '', tool_calls: [tc('flaky_tool', {})] },
    'a',
    'b',
  ]);
  const pattern = Tree(Name('host')
    , Tools('flaky_tool')
    , Prompt('act', () => 'go')
    , Memory('err', m => m.raw.branch.act.toolResults[0].isError)
    , Memory('msg', m => String(m.raw.branch.act.toolResults[0].result)));

  const { memory } = await grandma.knit(pattern, mockRuntime(handler, {
    tools: { flaky_tool: { description: 'flaky', parameters: {}, tree: child } },
  }));

  assert.equal(memory.err, true);
  assert.match(memory.msg, /^error: /);
});

test('an unresolvable tree tool name is an isError result', async () => {
  const handler = scripted([{ content: '', tool_calls: [tc('ghost', {})] }]);
  const pattern = Tree(Name('host')
    , Tools('ghost')
    , Prompt(disableAuto(), 'act', () => 'go')
    , Memory('err', m => m.raw.branch.act.toolResults[0].isError)
    , Memory('msg', m => String(m.raw.branch.act.toolResults[0].result)));

  const { memory } = await grandma.knit(pattern, mockRuntime(handler, {
    tools: { ghost: { description: 'ghost', parameters: {}, tree: 'no_such_tree' } },
  }));

  assert.equal(memory.err, true);
  assert.match(memory.msg, /not registered/);
});

test('loadTree resolves and names a dynamically loaded tree', async () => {
  const late = Tree(Prompt(m => `late: ${m.who}`)); // unnamed, unregistered
  const asked = [];
  const handler = scripted(['late result']);
  const runtime = mockRuntime(handler, { tools: { late_tool: { tree: 'late_tree' } } });
  runtime.loadTree = async (name) => {
    asked.push(name);
    return name === 'late_tree' ? late : null;
  };
  const pattern = Tree(Name('host'), Call('run', 'late_tool', () => ({ who: 'x' })));

  const { memory } = await grandma.knit(pattern, runtime);
  assert.deepEqual(asked, ['late_tree']);
  assert.equal(memory.run, 'late result');
  assert.equal(handler.calls[0].messages[0].content, 'late: x');
});

test('tree tool entries must declare exactly one implementation', async () => {
  const handler = scripted(['x']);
  await assert.rejects(
    grandma.knit(
      Tree(Name('host'), Call('run', 'bad', () => ({}))),
      mockRuntime(handler, { tools: { bad: { execute: () => 1, tree: Tree(Prompt(() => 'x')) } } }),
    ),
    /both execute and tree/,
  );
  await assert.rejects(
    grandma.knit(
      Tree(Name('host'), Call('run', 'bad2', () => ({}))),
      mockRuntime(handler, { tools: { bad2: { description: 'no impl' } } }),
    ),
    /needs execute\(\) or a tree/,
  );
});

test('nested tree tools replay every prompt level on resume', async () => {
  const inner = Tree(Name('inner'), Human('go'), Memory('out', () => 'inner done'));
  const outer = Tree(Name('outer')
    , Tools('inner_tool')
    , Prompt(disableAuto(), 'outer_act', () => 'call inner')
    , Memory('outer_out', m => m.raw.branch.outer_act.toolResults[0].result));
  const handler = scripted([
    { content: '', tool_calls: [tc('outer_tool', {})] },
    { content: '', tool_calls: [tc('inner_tool', {})] },
  ]);
  const runtime = mockRuntime(handler, {
    logger: tmpLogger(),
    tools: {
      outer_tool: { description: 'outer', parameters: {}, tree: outer },
      inner_tool: { description: 'inner', parameters: {}, tree: inner },
    },
  });
  const pattern = Tree(Name('host')
    , Tools('outer_tool')
    , Prompt(disableAuto(), 'act', () => 'go')
    , Memory('seen', m => m.raw.branch.act.toolResults[0].result));

  const first = await grandma.knit(pattern, runtime);
  assert.equal(first.status, 'waiting');
  assert.equal(first.humanSlot, 'go');
  assert.equal(handler.calls.length, 2);

  const second = await grandma.knit(pattern, {
    ...runtime,
    _continuation: first.continuation,
    humanInput: 'x',
  });
  assert.equal(second.status, undefined);
  assert.equal(handler.calls.length, 2, 'both prompt levels were replayed');
  assert.equal(second.memory.seen, 'inner done', 'results flowed back through both levels');
});

// ── round trip: record → resume → record ─────────────────────────────────
// The log is the source of truth for resume; these tests pin the invariant
// that a second pause resumes from a record written in the resumed life.

test('round trip: record → resume → record resumes from the second record', async () => {
  const dbPath = tmpLogger();
  const handler = scripted(['one', 'two']);
  const pattern = Tree(Name('round')
    , Prompt(m => 'first')
    , Human('first_answer')
    , Prompt(m => `second: ${m.branch.first_answer}`)
    , Human('second_answer')
    , Memory('final', m => `done: ${m.branch.second_answer}`));

  const first = await grandma.knit(pattern, mockRuntime(handler, { logger: dbPath }));
  assert.equal(first.status, 'waiting');
  assert.equal(first.humanSlot, 'first_answer');
  assert.equal(handler.calls.length, 1);

  const second = await grandma.knit(pattern, {
    ...mockRuntime(handler, { logger: dbPath }),
    _continuation: first.continuation,
    humanInput: 'world',
  });
  assert.equal(second.status, 'waiting');
  assert.equal(second.humanSlot, 'second_answer');
  assert.equal(handler.calls.length, 2, 'only the second prompt ran on the first resume');

  const third = await grandma.knit(pattern, {
    ...mockRuntime(handler, { logger: dbPath }),
    _continuation: second.continuation,
    humanInput: 'again',
  });
  assert.equal(third.status, undefined);
  assert.equal(third.memory.final, 'done: again');
});

test('resume restores slots accumulated across several pauses', async () => {
  const dbPath = tmpLogger();
  const handler = scripted([]);
  const loop = Tree(Name('loop')
    , Human('word')
    , Memory(update(), 'count', (m, cur) => cur + 1)
    , Memory(update(), 'words', (m, cur) => [...(cur ?? []), m.branch.word])
    , Until(m => m.branch.word === 'stop', max(10)));
  const pattern = Tree(Name('acc')
    , Memory('count', () => 0)
    , Memory('words', () => [])
    , Branch(loop));

  const first = await grandma.knit(pattern, mockRuntime(handler, { logger: dbPath }));
  assert.equal(first.status, 'waiting');
  const second = await grandma.knit(pattern, {
    ...mockRuntime(handler, { logger: dbPath }),
    _continuation: first.continuation,
    humanInput: 'a',
  });
  assert.equal(second.status, 'waiting');
  const third = await grandma.knit(pattern, {
    ...mockRuntime(handler, { logger: dbPath }),
    _continuation: second.continuation,
    humanInput: 'b',
  });
  assert.equal(third.status, 'waiting');
  const fourth = await grandma.knit(pattern, {
    ...mockRuntime(handler, { logger: dbPath }),
    _continuation: third.continuation,
    humanInput: 'stop',
  });
  assert.equal(fourth.status, undefined);
  assert.equal(fourth.memory.count, 3, 'count survived all resumes');
  assert.deepEqual(fourth.memory.words, ['a', 'b', 'stop']);
});

test('resume after a pause inside a .map() keeps prior items', async () => {
  const dbPath = tmpLogger();
  const handler = scripted(['rated-1', 'rated-2']);
  const item = Tree(Name('item')
    , Prompt(m => `rate ${m.item}`)
    , Human('verdict'));
  const pattern = Tree(Name('mapper')
    , Map('rated', m => ['x', 'y'], item));

  const first = await grandma.knit(pattern, mockRuntime(handler, { logger: dbPath }));
  assert.equal(first.status, 'waiting');
  const second = await grandma.knit(pattern, {
    ...mockRuntime(handler, { logger: dbPath }),
    _continuation: first.continuation,
    humanInput: 'ok',
  });
  assert.equal(second.status, 'waiting', 'paused on the second item');
  assert.equal(handler.calls.length, 2, 'the first item did not re-run');
  assert.deepEqual(second.humanSlot, 'verdict');
});

test('branch slot written before a pause survives resume', async () => {
  const dbPath = tmpLogger();
  const handler = scripted([]);
  const sub = Tree(Name('sub')
    , Memory('kept', () => 'value')
    , Human('go')
    , Emit(m => ({ text: `kept=${m.branch.kept}` })));
  const pattern = Tree(Name('slot'), Branch(sub));

  const first = await grandma.knit(pattern, mockRuntime(handler, { logger: dbPath }));
  assert.equal(first.status, 'waiting');
  const emitted = [];
  const second = await grandma.knit(pattern, {
    ...mockRuntime(handler, { logger: dbPath }),
    _continuation: first.continuation,
    humanInput: 'ok',
    onEmit: (v) => emitted.push(v),
  });
  assert.equal(second.status, undefined);
  assert.deepEqual(emitted, [{ text: 'kept=value' }], 'the branch scope was reconstructed on resume');
});

test('a map item ending in .human() keeps its export across two resumes', async () => {
  // Regression: on resume, execTreeInner skipped state.pass++ for the
  // resumed pass. A scope created in a resumed life logged scope_init at
  // iteration 0 and its records at iteration 1, so the NEXT resume's
  // iteration-boundary heuristic wiped its prev — a map item whose last
  // child is .human() then exported undefined.
  const dbPath = tmpLogger();
  const handler = scripted(['x1', 'x2']);
  const item = Tree(Name('tail-item')
    , Prompt(m => `p${m.item}`)
    , Human('h'));
  const pattern = Tree(Name('tail-map'), Map('r', () => [1, 2], item));

  const first = await grandma.knit(pattern, mockRuntime(handler, { logger: dbPath }));
  assert.equal(first.status, 'waiting');
  const second = await grandma.knit(pattern, {
    ...mockRuntime(handler, { logger: dbPath }),
    _continuation: first.continuation,
    humanInput: 'v',
  });
  assert.equal(second.status, 'waiting', 'paused on the second item');
  const third = await grandma.knit(pattern, {
    ...mockRuntime(handler, { logger: dbPath }),
    _continuation: second.continuation,
    humanInput: 'v',
  });
  assert.equal(third.status, undefined);
  assert.deepEqual(third.result, ['x1', 'x2'], 'both paused-item exports survived the resumes');
});
