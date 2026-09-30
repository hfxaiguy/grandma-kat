// Scoped registers — the executable spec: lexical visibility (a register is
// visible to its def's whole subtree, overridable by a child, invisible
// upward and to siblings), `calls(...)` + the `tools` argument, and the
// { value, memory } result shape (patch applied as memory records then
// stripped; the stored tool result is { value } / { error }).
//
// Scripted against mock models — no live LLM.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import grandma, { Tree, calls, disableAuto } from '../src/index.mjs';
import { scripted, mockRuntime, tool } from './helpers.mjs';

const tc = (name, args) => ({ id: name, function: { name, arguments: JSON.stringify(args ?? {}) } });

// ── visibility ─────────────────────────────────────────────────────────────

test('a register is visible to its def’s subtree', async () => {
  const pattern = Tree.name('vis1')
    .register('peek', 'read a slot', (m) => `peeked:${m.seed}`)
    .memory('seed', () => 's')
    .call('direct', 'peek', () => ({}))
    .branch(
      Tree.name('inner')
        .call('nested', 'peek', () => ({}))
    )
    .memory('got', (m) => ({ direct: m.branch.direct, nested: m.branch.inner }));

  const { memory } = await grandma.knit(pattern, mockRuntime(scripted([])));
  assert.equal(memory.got.direct, 'peeked:s');
  assert.equal(memory.got.nested, 'peeked:s');
});

test('a register declared on a child is invisible to the parent and to siblings', async () => {
  const parentCannot = Tree.name('vis2')
    .call('x', 'child_only', () => ({}))
    .branch(Tree.name('kid').register('child_only', 'hidden', () => 'nope').memory('marker', () => true));
  await assert.rejects(
    grandma.knit(parentCannot, mockRuntime(scripted([]))),
    /unknown tool 'child_only'/,
  );

  const siblingCannot = Tree.name('vis3')
    .branch(Tree.name('a').register('only_a', 'x', () => 'a').memory('marker', () => true))
    .branch(Tree.name('b').call('x', 'only_a', () => ({})));
  await assert.rejects(
    grandma.knit(siblingCannot, mockRuntime(scripted([]))),
    /unknown tool 'only_a'/,
  );
});

test('a child may override a parent register for its own subtree', async () => {
  const pattern = Tree.name('vis4')
    .register('who', 'name it', () => 'parent')
    .call('before', 'who', () => ({}))
    .branch(
      Tree.name('kid')
        .register('who', 'override', () => 'child')
        .call('inside', 'who', () => ({}))
    )
    .call('after', 'who', () => ({}))
    .memory('got', (m) => ({ before: m.branch.before, inside: m.branch.kid, after: m.branch.after }));

  const { memory } = await grandma.knit(pattern, mockRuntime(scripted([])));
  assert.deepEqual(memory.got, { before: 'parent', inside: 'child', after: 'parent' });
});

test('duplicate register names on one tree are a build error', async () => {
  const dup = Tree.name('vis5')
    .register('x', 'one', () => 'a')
    .register('x', 'two', () => 'b')
    .call('go', 'x', () => ({}));
  await assert.rejects(
    grandma.knit(dup, mockRuntime(scripted([]))),
    /duplicate \.register\('x'\)/,
  );
});

test('a prompt sees the register that resolves at its own scope', async () => {
  const handler = scripted([{ content: 'asked', tool_calls: null }]);
  const pattern = Tree.name('vis6')
    .register('who', 'parent description', () => 'parent')
    .branch(
      Tree.name('kid')
        .register('who', 'child description', () => 'child')
        .tools('who')
        .prompt('main', () => 'go')
    );

  await grandma.knit(pattern, mockRuntime(handler));
  const offered = handler.calls[0].tools[0].function;
  assert.equal(offered.name, 'who');
  assert.equal(offered.description, 'child description', 'the child override supplies the schema');
});

// ── calls(...) + the tools argument ────────────────────────────────────────

test('a register body receives the host tools it declares with calls(...)', async () => {
  const seen = [];
  const pattern = Tree.name('calls1')
    .register(
      'fetch',
      'fetch through the host',
      async (m, args, tools) => {
        const echoed = await tools.echo({ q: args.q });
        return { value: { echoed, seed: m.seed } };
      },
      calls('echo'),
    )
    .memory('seed', () => 's')
    .call('got', 'fetch', () => ({ q: 'hi' }))
    .memory('result', (m) => m.branch.got);

  const { memory } = await grandma.knit(pattern, mockRuntime(scripted([]), {
    tools: { echo: tool(async (args) => { seen.push(args); return `echo:${args.q}`; }) },
  }));

  assert.deepEqual(seen, [{ q: 'hi' }]);
  assert.deepEqual(memory.result, { value: { echoed: 'echo:hi', seed: 's' } });
});

test('calls(...) names must resolve at knit start, and only to function tools', async () => {
  const missing = Tree.name('calls2')
    .register('x', 'x', () => 'x', calls('nope'))
    .call('go', 'x', () => ({}));
  await assert.rejects(
    grandma.knit(missing, mockRuntime(scripted([]))),
    /calls\('nope'\) is not resolvable/,
  );

  const treeKind = Tree.name('calls3')
    .register('x', 'x', () => 'x', calls('treeish'))
    .call('go', 'x', () => ({}));
  await assert.rejects(
    grandma.knit(treeKind, mockRuntime(scripted([]), {
      tools: { treeish: { description: 't', tree: Tree.name('inner3').prompt('p', () => 'x') } },
    })),
    /may only call function tools/,
  );
});

// ── the { value, memory } result shape ─────────────────────────────────────

test('a memory patch writes the slots and is stripped from the stored result', async () => {
  const pattern = Tree.name('patch1')
    .memory('count', () => 0)
    .memory('label', () => 'start')
    .register('bump', 'bump the count', (m) => {
      const next = (m.count ?? 0) + 1;
      return { value: { next }, memory: { count: next, label: `bump ${next}` } };
    })
    .call('one', 'bump', () => ({}))
    .memory('seen', (m) => ({ count: m.count, label: m.label, stored: m.branch.one }));

  const { memory } = await grandma.knit(pattern, mockRuntime(scripted([])));
  assert.equal(memory.seen.count, 1);
  assert.equal(memory.seen.label, 'bump 1');
  assert.deepEqual(memory.seen.stored, { value: { next: 1 } }, 'the stored result keeps only { value }');
});

test('an error result skips the patch but still loses the memory key', async () => {
  const pattern = Tree.name('patch2')
    .memory('count', () => 0)
    .register('bad', 'fails', () => ({ error: 'nope', memory: { count: 9 } }))
    .call('x', 'bad', () => ({}))
    .memory('after', (m) => ({ count: m.count, stored: m.branch.x }));

  const { memory } = await grandma.knit(pattern, mockRuntime(scripted([])));
  assert.equal(memory.after.count, 0, 'the patch did not apply');
  assert.deepEqual(memory.after.stored, { error: 'nope' });
});

test('a patch for an undeclared slot fails the call', async () => {
  const pattern = Tree.name('patch3')
    .register('bad', 'bad patch', () => ({ value: 1, memory: { nope: 1 } }))
    .call('x', 'bad', () => ({}));
  await assert.rejects(
    grandma.knit(pattern, mockRuntime(scripted([]))),
    /slot 'nope' does not exist/,
  );
});

test('a model-called register applies its patch and the tool result is { value }', async () => {
  const handler = scripted([
    { content: '', tool_calls: [tc('bump', {})] },
  ]);
  const pattern = Tree.name('patch4')
    .memory('count', () => 0)
    .register('bump', 'bump it', (m) => {
      const next = (m.count ?? 0) + 1;
      return { value: next, memory: { count: next } };
    })
    .tools('bump')
    .prompt(disableAuto(), 'main', () => 'go')
    .memory('rec', (m) => ({ count: m.count, results: m.raw.branch.main.toolResults }));

  const { memory } = await grandma.knit(pattern, mockRuntime(handler));
  assert.equal(memory.rec.count, 1);
  assert.deepEqual(memory.rec.results, [{ name: 'bump', result: { value: 1 }, isError: false }]);
});
