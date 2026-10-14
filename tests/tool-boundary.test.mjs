// A registry tool's execute receives `boundary: true` when the call is made
// inside a tree entered as a TOOL (an app boundary), and `false` from the
// top-level agent. The host uses this to hold the top-level agent to a stricter
// rule than an app that legitimately owns a resource (BOB's sql_query guard).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import grandma, { Tree, name, Tools, Prompt, Return } from '../src/index.mjs';
import { mockRuntime, tool } from './helpers.mjs';

const tc = (n, a, id = n) => ({ id, function: { name: n, arguments: JSON.stringify(a ?? {}) } });

test('tool execute sees boundary:false at top level, boundary:true inside an app tree', async () => {
  const seen = [];
  const sql = tool(async (args, ctx) => { seen.push({ boundary: ctx?.boundary === true, tree: ctx?.tree ?? null }); return { ok: true }; });

  const inner = Tree(name('inner'), Tools('sql_query'),
    Prompt('p', () => 'go'),
    Return((m) => m.branch.p ?? null));

  const outer = Tree(name('outer'), Tools('sql_query', 'inner'),
    Prompt('main', () => 'do it'),
    Return((m) => m.branch.main ?? null));

  let outerRound = 0;
  let innerRound = 0;
  const handler = async (messages) => {
    const user = String([...messages].reverse().find((m) => m.role === 'user')?.content ?? '');
    if (user.includes('go')) {
      innerRound++;
      return innerRound === 1
        ? { content: '', tool_calls: [tc('sql_query', { path: 'contacts.db', query: 'SELECT 1' })] }
        : { content: 'inner done' };
    }
    outerRound++;
    if (outerRound === 1) return { content: '', tool_calls: [tc('sql_query', { path: 'contacts.db', query: 'SELECT 1' })] };
    if (outerRound === 2) return { content: '', tool_calls: [tc('inner', {})] };
    return { content: 'outer done' };
  };

  const runtime = mockRuntime(handler, {
    tools: { sql_query: sql, inner: { description: 'inner', parameters: {}, tree: inner } },
  });
  await grandma.knit(outer, runtime);

  assert.ok(seen.some((s) => s.boundary === false), 'the top-level agent\'s call is boundary:false');
  assert.ok(seen.some((s) => s.boundary === true), 'the app tree\'s call is boundary:true');
  // `tree` names the enclosing NAMED tree (the app whose code is calling):
  // null at the root, the entered tree's name inside it.
  assert.ok(seen.some((s) => s.boundary === false && s.tree === null), 'the top-level call reports tree:null');
  assert.ok(seen.some((s) => s.tree === 'inner'), 'a call inside the `inner` tree reports tree:"inner"');
});
