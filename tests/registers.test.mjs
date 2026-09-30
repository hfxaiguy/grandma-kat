// Scoped registers — the executable spec: lexical visibility (a register is
// visible to its def's whole subtree, overridable by a child, invisible
// upward and to siblings), `calls(...)` + the `tools` argument, and the
// { value, memory } result shape (patch applied as memory records then
// stripped; the stored tool result is { value } / { error }).
//
// Scripted against mock models — no live LLM.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import grandma, { Tree, calls, disableAuto, Name, Model, Tools, Needs, Human, Prompt, Memory, Register, Branch, Map, Call, Check, Emit, Return, Until } from '../src/index.mjs';
import { scripted, mockRuntime, tool } from './helpers.mjs';

const tc = (name, args) => ({ id: name, function: { name, arguments: JSON.stringify(args ?? {}) } });

// ── visibility ─────────────────────────────────────────────────────────────

test('a register is visible to its def’s subtree', async () => {
  const pattern = Tree(Name('vis1')
    , Register('peek', 'read a slot', (m) => `peeked:${m.seed}`)
    , Memory('seed', () => 's')
    , Call('direct', 'peek', () => ({}))
    , Branch(
      Tree(Name('inner')
        , Call('nested', 'peek', () => ({})))
    )
    , Memory('got', (m) => ({ direct: m.branch.direct, nested: m.branch.inner })));

  const { memory } = await grandma.knit(pattern, mockRuntime(scripted([])));
  assert.equal(memory.got.direct, 'peeked:s');
  assert.equal(memory.got.nested, 'peeked:s');
});

test('a register declared on a child is invisible to the parent and to siblings', async () => {
  const parentCannot = Tree(Name('vis2')
    , Call('x', 'child_only', () => ({}))
    , Branch(Tree(Name('kid'), Register('child_only', 'hidden', () => 'nope'), Memory('marker', () => true))));
  await assert.rejects(
    grandma.knit(parentCannot, mockRuntime(scripted([]))),
    /unknown tool 'child_only'/,
  );

  const siblingCannot = Tree(Name('vis3')
    , Branch(Tree(Name('a'), Register('only_a', 'x', () => 'a'), Memory('marker', () => true)))
    , Branch(Tree(Name('b'), Call('x', 'only_a', () => ({})))));
  await assert.rejects(
    grandma.knit(siblingCannot, mockRuntime(scripted([]))),
    /unknown tool 'only_a'/,
  );
});

test('a child may override a parent register for its own subtree', async () => {
  const pattern = Tree(Name('vis4')
    , Register('who', 'name it', () => 'parent')
    , Call('before', 'who', () => ({}))
    , Branch(
      Tree(Name('kid')
        , Register('who', 'override', () => 'child')
        , Call('inside', 'who', () => ({})))
    )
    , Call('after', 'who', () => ({}))
    , Memory('got', (m) => ({ before: m.branch.before, inside: m.branch.kid, after: m.branch.after })));

  const { memory } = await grandma.knit(pattern, mockRuntime(scripted([])));
  assert.deepEqual(memory.got, { before: 'parent', inside: 'child', after: 'parent' });
});

test('duplicate register names on one tree are a build error', async () => {
  const dup = Tree(Name('vis5')
    , Register('x', 'one', () => 'a')
    , Register('x', 'two', () => 'b')
    , Call('go', 'x', () => ({})));
  await assert.rejects(
    grandma.knit(dup, mockRuntime(scripted([]))),
    /duplicate \.register\('x'\)/,
  );
});

test('a prompt sees the register that resolves at its own scope', async () => {
  const handler = scripted([{ content: 'asked', tool_calls: null }]);
  const pattern = Tree(Name('vis6')
    , Register('who', 'parent description', () => 'parent')
    , Branch(
      Tree(Name('kid')
        , Register('who', 'child description', () => 'child')
        , Tools('who')
        , Prompt('main', () => 'go'))
    ));

  await grandma.knit(pattern, mockRuntime(handler));
  const offered = handler.calls[0].tools[0].function;
  assert.equal(offered.name, 'who');
  assert.equal(offered.description, 'child description', 'the child override supplies the schema');
});

// ── calls(...) + the tools argument ────────────────────────────────────────

test('a register body receives the host tools it declares with calls(...)', async () => {
  const seen = [];
  const pattern = Tree(Name('calls1')
    , Register(
      'fetch',
      'fetch through the host',
      async (m, args, tools) => {
        const echoed = await tools.echo({ q: args.q });
        return { value: { echoed, seed: m.seed } };
      },
      calls('echo'),
    )
    , Memory('seed', () => 's')
    , Call('got', 'fetch', () => ({ q: 'hi' }))
    , Memory('result', (m) => m.branch.got));

  const { memory } = await grandma.knit(pattern, mockRuntime(scripted([]), {
    tools: { echo: tool(async (args) => { seen.push(args); return `echo:${args.q}`; }) },
  }));

  assert.deepEqual(seen, [{ q: 'hi' }]);
  assert.deepEqual(memory.result, { value: { echoed: 'echo:hi', seed: 's' } });
});

test('calls(...) names must resolve at knit start, and only to function tools', async () => {
  const missing = Tree(Name('calls2')
    , Register('x', 'x', () => 'x', calls('nope'))
    , Call('go', 'x', () => ({})));
  await assert.rejects(
    grandma.knit(missing, mockRuntime(scripted([]))),
    /calls\('nope'\) is not resolvable/,
  );

  const treeKind = Tree(Name('calls3')
    , Register('x', 'x', () => 'x', calls('treeish'))
    , Call('go', 'x', () => ({})));
  await assert.rejects(
    grandma.knit(treeKind, mockRuntime(scripted([]), {
      tools: { treeish: { description: 't', tree: Tree(Name('inner3'), Prompt('p', () => 'x')) } },
    })),
    /may only call function tools/,
  );
});

// ── the { value, memory } result shape ─────────────────────────────────────

test('a memory patch writes the slots and is stripped from the stored result', async () => {
  const pattern = Tree(Name('patch1')
    , Memory('count', () => 0)
    , Memory('label', () => 'start')
    , Register('bump', 'bump the count', (m) => {
      const next = (m.count ?? 0) + 1;
      return { value: { next }, memory: { count: next, label: `bump ${next}` } };
    })
    , Call('one', 'bump', () => ({}))
    , Memory('seen', (m) => ({ count: m.count, label: m.label, stored: m.branch.one })));

  const { memory } = await grandma.knit(pattern, mockRuntime(scripted([])));
  assert.equal(memory.seen.count, 1);
  assert.equal(memory.seen.label, 'bump 1');
  assert.deepEqual(memory.seen.stored, { value: { next: 1 } }, 'the stored result keeps only { value }');
});

test('an error result skips the patch but still loses the memory key', async () => {
  const pattern = Tree(Name('patch2')
    , Memory('count', () => 0)
    , Register('bad', 'fails', () => ({ error: 'nope', memory: { count: 9 } }))
    , Call('x', 'bad', () => ({}))
    , Memory('after', (m) => ({ count: m.count, stored: m.branch.x })));

  const { memory } = await grandma.knit(pattern, mockRuntime(scripted([])));
  assert.equal(memory.after.count, 0, 'the patch did not apply');
  assert.deepEqual(memory.after.stored, { error: 'nope' });
});

test('a patch for an undeclared slot fails the call', async () => {
  const pattern = Tree(Name('patch3')
    , Register('bad', 'bad patch', () => ({ value: 1, memory: { nope: 1 } }))
    , Call('x', 'bad', () => ({})));
  await assert.rejects(
    grandma.knit(pattern, mockRuntime(scripted([]))),
    /slot 'nope' does not exist/,
  );
});

test('a model-called register applies its patch and the tool result is { value }', async () => {
  const handler = scripted([
    { content: '', tool_calls: [tc('bump', {})] },
  ]);
  const pattern = Tree(Name('patch4')
    , Memory('count', () => 0)
    , Register('bump', 'bump it', (m) => {
      const next = (m.count ?? 0) + 1;
      return { value: next, memory: { count: next } };
    })
    , Tools('bump')
    , Prompt(disableAuto(), 'main', () => 'go')
    , Memory('rec', (m) => ({ count: m.count, results: m.raw.branch.main.toolResults })));

  const { memory } = await grandma.knit(pattern, mockRuntime(handler));
  assert.equal(memory.rec.count, 1);
  assert.deepEqual(memory.rec.results, [{ name: 'bump', result: { value: 1 }, isError: false }]);
});
