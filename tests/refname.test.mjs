// refName — the log attests what each value-bearing row is called, and a
// `ref://<name>.<seq>` label must agree with the row it points at.
//
// Two layers: a run's log is checked row-kind by row-kind (tool_result → the
// tool, map_item/map/record → the child/slot, llm_call → the prompt), and an
// end-to-end handoff proves the guard: a relabelled handle fails as a tool
// error with the attested name in the message, and the same seq resolves once
// the label is right.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import grandma, {
  Tree, name, Model, Tools, Needs, Each, Call, Memory, Prompt, Return, max,
} from '../src/index.mjs';
import { mockRuntime, scripted } from './helpers.mjs';

const rows = (n) => Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `Person ${i + 1}` }));
const tc = (n, a, id = n) => ({ id, function: { name: n, arguments: JSON.stringify(a ?? {}) } });
const messageText = (v) => (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v));

function eventRows(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare('SELECT kind, content FROM calls ORDER BY seq').all()
      .map((r) => ({ kind: r.kind, content: JSON.parse(r.content) }));
  } finally {
    db.close();
  }
}

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kat-refname-'));
  return path.join(dir, 'runs.db');
}

// ── write side ──────────────────────────────────────────────────────────────

test('every value-bearing row carries the name it attests', async () => {
  const dbPath = tmpDb();
  const echo = { description: 'echo', parameters: {}, execute: ({ v }) => ({ echoed: v }) };

  const tree = Tree(name('refname_rows'), Model('default'), Tools('producer'),
    Memory('items', () => [1, 2]),
    Each('things', (m) => m.items, Tree(
      Call('things', 'echo', (m) => ({ v: m.item })),
    )),
    Prompt('response', () => [{ role: 'user', content: 'go' }]),
    Return((m) => messageText(m.branch.response)));

  // Round 1 calls a runtime tool from the prompt's auto loop; round 2 answers.
  const handler = scripted([
    { content: '', tool_calls: [tc('producer', { n: 2 })] },
    { content: 'done' },
  ]);
  const runtime = mockRuntime(handler, {
    tools: {
      echo,
      producer: { description: 'produce rows', parameters: {}, execute: () => rows(2) },
    },
    logger: dbPath,
  });

  await grandma.knit(tree, runtime);
  const events = eventRows(dbPath);
  const find = (pred) => events.find(pred)?.content ?? null;

  assert.equal(find((e) => e.kind === 'tool_result' && e.content.tool === 'producer').refName, 'producer');
  assert.equal(find((e) => e.kind === 'map_item').refName, 'things');
  assert.equal(find((e) => e.kind === 'map').refName, 'things');
  assert.equal(find((e) => e.kind === 'record' && e.content.child === 'items').refName, 'items');
  assert.equal(find((e) => e.kind === 'llm_call').refName, 'response');

  // A kind with no derivable name is left unstamped — the key is uniform, its
  // presence is not.
  const init = find((e) => e.kind === 'scope_init');
  assert.equal('refName' in init, false);
});

// ── read side: the guard ────────────────────────────────────────────────────

test('a relabelled handle is rejected with the attested name; the right label resolves', async () => {
  const dbPath = tmpDb();

  const producer = Tree(name('refname_producer'), Needs('n'),
    Return((m) => rows(Number(m.n) || 0)));
  const consumer = Tree(name('refname_consumer'), Needs('input'),
    Return((m) => ({ got: Array.isArray(m.input) ? m.input.length : String(m.input) })));

  let seq;
  const refIn = (messages) => {
    const tool = [...messages].reverse().find((m) => m.role === 'tool');
    const match = String(tool?.content ?? '').match(/ref:\/\/[a-z][\w-]*\.\d+/i);
    if (!match) throw new Error(`no usable ref in the note:\n${tool?.content}`);
    return match[0];
  };

  const handler = scripted([
    { content: '', tool_calls: [tc('producer', { n: 50 })] },
    (messages) => {
      seq = refIn(messages).split('.').pop();
      // A swapped label on a real seq — exactly what the guard exists for.
      return { content: '', tool_calls: [tc('consumer', { input: `ref://caller-list.${seq}` })] };
    },
    () => ({ content: '', tool_calls: [tc('consumer', { input: `ref://producer.${seq}` })] }),
    { content: 'done' },
  ]);

  const runtime = mockRuntime(handler, {
    tools: {
      producer: { description: 'produce rows', parameters: {}, tree: producer },
      consumer: { description: 'consume a list', parameters: {}, tree: consumer },
    },
    logger: dbPath,
    maxToolResultChars: 800,
  });
  const tree = Tree(name('refname_guard_agent'), Model('default'), Tools('producer', 'consumer'),
    Prompt(max(8), 'response', () => [{ role: 'user', content: 'hand it over' }]),
    Return((m) => messageText(m.branch.response)));

  const { result } = await grandma.knit(tree, runtime);
  assert.equal(result, 'done');

  const consumerCalls = eventRows(dbPath)
    .filter((e) => e.kind === 'tool_result' && e.content.tool === 'consumer')
    .map((e) => e.content);
  assert.equal(consumerCalls.length, 2);

  assert.equal(consumerCalls[0].isError, true, 'the relabelled handle is a tool error');
  assert.match(String(consumerCalls[0].result), /that row is 'producer'/);
  assert.match(String(consumerCalls[0].result), new RegExp(`ref://producer\\.${seq}`));

  assert.equal(consumerCalls[1].isError, false, 'the correct label resolves');
  assert.deepEqual(consumerCalls[1].result, { got: 50 });
});
