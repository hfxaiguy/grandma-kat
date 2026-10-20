// inspect_memory — a bounded view of a value the model holds only by handle.
//
// Two layers: unit tests drive the tool's execute with a hand-built ctx (the
// same shape the engine passes), and integration tests run a prompt's auto loop
// so the ENGINE provides ctx.view / ctx.readRef / ctx.scopeInfo — the wiring
// that makes a host tool able to read live memory and the run log at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import grandma, { Tree, name, Model, Tools, Prompt, Return } from '../src/index.mjs';
import { inspectMemoryTool, DEFAULT_SAMPLE } from '../src/inspect.mjs';
import { mockRuntime, scripted } from './helpers.mjs';

const rows = (n) => Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `Person ${i + 1}` }));
const tc = (n, a, id = n) => ({ id, function: { name: n, arguments: JSON.stringify(a ?? {}) } });
const messageText = (v) => (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v));

// ── a fake ctx: the engine's { view, scopeInfo, readRef } ───────────────────

function fakeCtx({ slots = {}, seqs = {}, refs = {} } = {}) {
  return {
    view: slots,
    scopeInfo: () => ({
      scopeId: 3,
      parentScopeId: 0,
      slots: Object.keys(slots).map((n) => ({ name: n, ownerScopeId: 3, seq: seqs[n] ?? null })),
    }),
    readRef: (ref) => {
      if (!(ref in refs)) throw new Error(`ref ${ref}: no run-log row`);
      return refs[ref];
    },
  };
}

const run = (args, ctx) => inspectMemoryTool().execute(args, ctx);

// ── listing ─────────────────────────────────────────────────────────────────

test('list: every slot in scope, with a ref minted for a written slot', () => {
  const ctx = fakeCtx({ slots: { contacts: rows(60), note: 'hi' }, seqs: { contacts: 42 } });
  const out = run({ list: true }, ctx);

  assert.equal(out.type, 'inventory');
  assert.equal(out.scopeId, 3);
  const contacts = out.slots.find((s) => s.name === 'contacts');
  assert.deepEqual(contacts, { name: 'contacts', ownerScopeId: 3, type: 'array', size: 60, ref: 'ref://contacts.42' });
  const note = out.slots.find((s) => s.name === 'note');
  assert.equal(note.ref, undefined, 'a host seed has no write row, so no ref');
  assert.deepEqual(note, { name: 'note', ownerScopeId: 3, type: 'string', size: 2 });
});

test('list is also reachable as name:"*"', () => {
  const out = run({ name: '*' }, fakeCtx({ slots: { a: 1 } }));
  assert.equal(out.type, 'inventory');
  assert.deepEqual(out.slots.map((s) => s.name), ['a']);
});

// ── live slots by name ──────────────────────────────────────────────────────

test('name: samples DEFAULT_SAMPLE rows and cites the slot ref', () => {
  const ctx = fakeCtx({ slots: { contacts: rows(60) }, seqs: { contacts: 42 } });
  const out = run({ name: 'contacts' }, ctx);

  assert.equal(out.type, 'array');
  assert.equal(out.length, 60);
  assert.equal(out.rowsShown, DEFAULT_SAMPLE);
  assert.equal(out.order, 'sample');
  assert.equal(out.truncated, true);
  assert.equal(out.ref, 'ref://contacts.42');
  assert.ok(out.rows.every((r) => r.id >= 1 && r.id <= 60), 'sampled rows come from the array');
});

test('name + seed draws the same sample twice', () => {
  const ctx = fakeCtx({ slots: { contacts: rows(60) } });
  const a = run({ name: 'contacts', sample: 8, seed: 7 }, ctx);
  const b = run({ name: 'contacts', sample: 8, seed: 7 }, ctx);
  assert.deepEqual(a.rows, b.rows);
});

test('head: takes the first N rows, in order', () => {
  const ctx = fakeCtx({ slots: { contacts: rows(60) } });
  const out = run({ name: 'contacts', head: 3 }, ctx);
  assert.equal(out.order, 'head');
  assert.deepEqual(out.rows, rows(60).slice(0, 3));
  assert.equal(out.rowsShown, 3);
});

test('path: walks into the value (array index then key)', () => {
  const ctx = fakeCtx({ slots: { contacts: rows(60) } });
  const out = run({ name: 'contacts', path: '0/name' }, ctx);
  assert.deepEqual(out, { type: 'string', length: 8, value: 'Person 1' });
});

test('a whole small value is shown; a big object is summarised by key', () => {
  const small = run({ name: 'cfg' }, fakeCtx({ slots: { cfg: { a: 1, b: 2 } } }));
  assert.deepEqual(small, { type: 'object', size: 2, value: { a: 1, b: 2 } });

  const big = { keep: 'x'.repeat(300), drop: 'y'.repeat(300), more: 'z'.repeat(300) };
  const out = run({ name: 'big', maxChars: 120 }, fakeCtx({ slots: { big } }));
  assert.equal(out.type, 'object');
  assert.equal(out.size, 3);
  assert.equal(out.truncated, true);
  assert.equal(out.value, undefined, 'the values are withheld, only keys are listed');
  assert.ok(out.keysShown >= 1);
});

// ── run-log refs ────────────────────────────────────────────────────────────

test('ref: resolves a handle and samples it', () => {
  const ctx = fakeCtx({ refs: { 'ref://rows.7/list': rows(50) } });
  const out = run({ ref: 'ref://rows.7/list', sample: 4, seed: 1 }, ctx);

  assert.equal(out.type, 'array');
  assert.equal(out.length, 50);
  assert.equal(out.rowsShown, 4);
  assert.equal(out.ref, 'ref://rows.7/list', 'the handle it was read through is echoed back');
});

test('ref + path: walks deeper into the resolved value', () => {
  const ctx = fakeCtx({ refs: { 'ref://rows.7': { list: rows(50) } } });
  const out = run({ ref: 'ref://rows.7', path: 'list/0/name' }, ctx);
  assert.equal(out.value, 'Person 1');
});

// ── errors are results, not throws ──────────────────────────────────────────

test('a bad name, bad ref, or no address returns an error-shaped result', () => {
  const ctx = fakeCtx({ slots: { contacts: rows(3) }, refs: {} });
  assert.match(run({ name: 'nope' }, ctx).error, /no memory slot 'nope'.*have: contacts/);
  assert.match(run({ ref: 'ref://9' }, ctx).error, /no run-log row/);
  assert.match(run({}, ctx).error, /needs a `name`.*or a `ref`/);
});

// ── the budget is a real cap ────────────────────────────────────────────────

test('maxChars bounds the returned JSON (at least one row always kept)', () => {
  const fat = Array.from({ length: 40 }, (_, i) => ({ id: i + 1, bio: 'x'.repeat(200) }));
  const out = run({ name: 'fat', sample: 40, seed: 2, maxChars: 300 }, fakeCtx({ slots: { fat } }));
  assert.equal(out.rowsShown, 1);
  assert.equal(out.truncated, true);
  assert.ok(JSON.stringify(out).length < 600, 'bounded, not the whole array');
});

// ── through the engine: the auto loop provides ctx ──────────────────────────

test('engine: a live slot read by name (ctx.view + ctx.scopeInfo)', async () => {
  const handler = scripted([
    { content: '', tool_calls: [tc('inspect_memory', { name: 'contacts', head: 2 })] },
    { content: 'saw them' },
  ]);
  const runtime = mockRuntime(handler, {
    tools: { inspect_memory: inspectMemoryTool() },
    memory: { contacts: rows(50) },
  });
  const tree = Tree(name('inspect_agent'), Model('default'), Tools('inspect_memory'),
    Prompt('response', () => [{ role: 'user', content: 'peek at contacts' }]),
    Return((m) => messageText(m.branch.response)));

  const { result } = await grandma.knit(tree, runtime);
  assert.equal(result, 'saw them');

  const toolMsg = [...handler.calls[1].messages].reverse().find((m) => m.role === 'tool');
  const seen = JSON.parse(toolMsg.content);
  assert.equal(seen.type, 'array');
  assert.equal(seen.length, 50);
  assert.deepEqual(seen.rows, rows(50).slice(0, 2));
});

test('engine: a ref from a truncation note is resolved by ctx.readRef', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kat-inspect-'));
  const dbPath = path.join(dir, 'runs.db');

  const extractRef = (messages) => {
    const tool = [...messages].reverse().find((m) => m.role === 'tool');
    const match = String(tool?.content ?? '').match(/ref:\/\/[a-z][\w-]*\.\d+(?:\/[\w.\-/]*)?/i);
    if (!match) throw new Error(`the note carried no usable ref:\n${tool?.content}`);
    return match[0];
  };

  // The producer returns a bare array so the engine's cap mints a whole-value
  // ref://<seq> (capToolResult refs arrays directly).
  const handler = scripted([
    { content: '', tool_calls: [tc('producer', {})] },
    (messages) => ({ content: '', tool_calls: [tc('inspect_memory', { ref: extractRef(messages), sample: 3, seed: 1 })] }),
    { content: 'inspected' },
  ]);
  const runtime = mockRuntime(handler, {
    tools: {
      producer: { description: 'produce rows', parameters: {}, execute: () => rows(50) },
      inspect_memory: inspectMemoryTool(),
    },
    logger: dbPath,
    maxToolResultChars: 800,
  });
  const tree = Tree(name('inspect_ref_agent'), Model('default'), Tools('producer', 'inspect_memory'),
    Prompt('response', () => [{ role: 'user', content: 'inspect the batch' }]),
    Return((m) => messageText(m.branch.response)));

  const { result } = await grandma.knit(tree, runtime);
  assert.equal(result, 'inspected');

  // The model's third view: the inspect result, a small array view of the 50.
  const toolMsg = [...handler.calls[2].messages].reverse().find((m) => m.role === 'tool');
  const seen = JSON.parse(toolMsg.content);
  assert.equal(seen.type, 'array');
  assert.equal(seen.length, 50);
  assert.equal(seen.rowsShown, 3);
  assert.match(seen.ref, /^ref:\/\/producer\.\d+$/);

  // The log still holds the full 50-row result the handle pointed at.
  const db = new DatabaseSync(dbPath, { readOnly: true });
  let producerRow;
  try {
    producerRow = db.prepare("SELECT content FROM calls WHERE kind = 'tool_result'").all()
      .map((r) => JSON.parse(r.content))
      .find((r) => r.tool === 'producer');
  } finally {
    db.close();
  }
  assert.equal(producerRow.result.length, 50);
});
