// Provenance: a prompt's messages (and a derived Memory value) log the memory
// slots they read — `reads: [{ name, scope, seq }]` — so the log links a
// result to the exact row that produced each input.
//
//   Memory('a', () => 1)                 -> record a            (no reads)
//   Memory('b', m => !!m.a)              -> record b            reads a@<seq_a>
//   Prompt('response', m => `b=${m.b}`)  -> llm_call response    reads b@<seq_b>
//
// Scripted mock model; no live LLM.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import grandma, { Tree, name, Memory, Prompt, Branch, update } from '../src/index.mjs';
import { scripted, mockRuntime } from './helpers.mjs';

function tmpLogger() {
  return path.join(os.tmpdir(), `grandma-kat-prov-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function events(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const rows = db.prepare('SELECT seq, kind, content FROM calls ORDER BY seq').all();
  db.close();
  return rows.map((r) => ({ seq: r.seq, kind: r.kind, content: JSON.parse(r.content ?? 'null') }));
}

const recordFor = (evs, child) => evs.find((e) => e.kind === 'record' && e.content?.child === child);
const llmCall = (evs, child) => evs.find((e) => e.kind === 'llm_call' && e.content?.child === child);

test('a derived Memory logs the slot it read, linked to the producing seq', async () => {
  const dbPath = tmpLogger();
  try {
    const pattern = Tree(name('prov'),
      Memory('a', () => 1),
      Memory('b', (m) => !!m.a),
      Prompt('response', (m) => `b=${m.b}`),
    );
    await grandma.knit(pattern, mockRuntime(scripted(['ok']), { logger: dbPath }));

    const evs = events(dbPath);
    const a = recordFor(evs, 'a');
    const b = recordFor(evs, 'b');
    const call = llmCall(evs, 'response');

    assert.ok(a && b && call, 'all three events logged');
    assert.equal(a.content.reads, undefined, 'a pure seed reads nothing');
    assert.equal(b.content.reads.length, 1);
    assert.equal(b.content.reads[0].name, 'a');
    assert.equal(typeof b.content.reads[0].scope, 'number');
    assert.equal(b.content.reads[0].scope, call.content.reads[0].scope, 'same root scope');
    assert.equal(b.content.reads[0].seq, a.seq, 'b points at the exact row that wrote a');

    assert.deepEqual(call.content.reads.map((r) => r.name), ['b']);
    assert.equal(call.content.reads[0].seq, b.seq, 'the prompt points at the row that wrote b');
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
});

test('reading a branch result is a slot read (m.branch.x)', async () => {
  const dbPath = tmpLogger();
  try {
    const pattern = Tree(name('prov_branch'),
      Branch(Tree(name('inner'), Memory('v', () => 'V'))),
      Prompt('response', (m) => `inner=${m.branch.inner}`),
    );
    await grandma.knit(pattern, mockRuntime(scripted(['ok']), { logger: dbPath }));

    const evs = events(dbPath);
    const inner = recordFor(evs, 'inner');
    const call = llmCall(evs, 'response');

    const read = call.content.reads.find((r) => r.name === 'inner');
    assert.ok(read, 'the branch result shows up as a read');
    assert.equal(read.seq, inner.seq, 'linked to the branch result row');
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
});

test('Memory(update()) logs itself as a read and the prompt exposes its reads on the record', async () => {
  const dbPath = tmpLogger();
  try {
    const pattern = Tree(name('prov_update'),
      Memory('history', () => []),
      Memory(update(), 'history', (m) => [...m.history, 1]),
      Prompt('response', (m) => `n=${m.history.length}`),
      Memory('snap', (m) => m.raw.prev[0].reads),
    );
    await grandma.knit(pattern, mockRuntime(scripted(['ok']), { logger: dbPath }));

    const evs = events(dbPath);
    const seed = recordFor(evs, 'history');
    const upd = evs.find((e) => e.kind === 'record' && e.content?.child === 'history' && e.content?.op === 'memoryUpdate');
    const call = llmCall(evs, 'response');

    assert.ok(seed && upd && call, 'seed, update, and call logged');
    assert.equal(upd.content.reads[0].name, 'history');
    assert.equal(upd.content.reads[0].seq, seed.seq, 'the update read the seed write');

    assert.deepEqual(call.content.reads.map((r) => r.name), ['history']);
    assert.equal(call.content.reads[0].seq, upd.seq, 'the prompt read the updated slot');

    // The prompt's record carries its reads for the tree (m.raw.prev[0].reads).
    const snap = recordFor(evs, 'snap');
    assert.deepEqual(snap.content.value, call.content.reads, 'record.reads is exposed to the tree');
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
});
