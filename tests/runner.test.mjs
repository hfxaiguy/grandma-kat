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

test('agentic tool loop: tool call executed, result fed back', async () => {
  const executed = [];
  const tools = {
    search: tool(async ({ q }) => { executed.push(q); return `result:${q}`; }),
  };
  const handler = scripted([
    { content: '', tool_calls: [{ id: '1', function: { name: 'search', arguments: '{"q":"x"}' } }] },
    { content: 'done' },
  ]);
  const pattern = Tree.name('agent')
    .tools('search')
    .prompt(m => 'find something');

  const { result } = await grandma.knit(pattern, mockRuntime(handler, { tools }));
  assert.equal(result, 'done');
  assert.deepEqual(executed, ['x']);
  // second LLM call received the tool result as a tool message
  const second = handler.calls[1].messages;
  assert.equal(second[second.length - 1].role, 'tool');
  assert.equal(second[second.length - 1].content, 'result:x');
});

test('tool errors are fed back to the model, not fatal', async () => {
  const tools = { boom: tool(async () => { throw new Error('kaput'); }) };
  const handler = scripted([
    { content: '', tool_calls: [{ id: '1', function: { name: 'boom', arguments: '{}' } }] },
    { content: 'recovered' },
  ]);
  const pattern = Tree.name('agent').tools('boom').prompt(m => 'go');

  const { result } = await grandma.knit(pattern, mockRuntime(handler, { tools }));
  assert.equal(result, 'recovered');
  const second = handler.calls[1].messages;
  assert.equal(second[second.length - 1].content, 'error: kaput');
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
