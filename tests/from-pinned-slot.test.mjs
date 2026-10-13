// A From() target whose internal name is version-qualified must still land its
// result under the BARE logical slot the app reads.
//
// A host pins snapshots for checkpoint stability: BOB's loadPattern renames a
// loaded tree to `contacts.v16` (pattern-loader.ts). grandma-kat used to let
// that name leak into the branch SLOT, so `m.branch.contacts` became
// `m.branch["contacts.v16"]` — an app reading the bare name silently got
// undefined (the caller-list "No contacts matched the selection" incident).
//
// The version-qualified name is the RESUME identity, not the slot: the
// checkpoint's branch_path keeps it so a paused conversation resolves the exact
// snapshot it was grown under. This test locks both halves.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import grandma, { Tree, From, Branch, name, Model, Needs, Human, Return } from '../src/index.mjs';

const models = { mock: { model: 'mock', handler: async () => ({ content: 'hello' }) } };
const logPath = () =>
  path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kat-pinned-slot-')), 'log.db');

test('a pinned (renamed) From target keeps the bare logical slot', async () => {
  const inner = Tree(
    name('pinned_contacts'),
    Needs('input'),
    Model('mock'),
    Return((m) => `inner:${m.input}`),
  );
  // What BOB's loadPattern does to a pinned snapshot, after building it.
  inner.name = 'pinned_contacts.v16';

  const outer = Tree(
    name('pinned_outer'),
    From('pinned_contacts'),
    Return((m) => m.pinned_contacts),
  );
  const out = await grandma.knit(outer, { memory: { input: 'hi' }, models, logger: false });

  assert.equal(out.result, 'inner:hi', 'readable under the bare From() name');
  assert.equal(out.memory.pinned_contacts, 'inner:hi', 'the value lands under the bare slot');
  assert.equal(
    out.memory['pinned_contacts.v16'],
    undefined,
    'the version-qualified internal name is NOT the slot',
  );
});

test('a plain Branch still takes its subtree name (no regression)', async () => {
  const leaf = Tree(name('pinned_leaf'), Model('mock'), Return(() => 'leaf'));
  const outer = Tree(name('pinned_branch_outer'), Branch(leaf), Return((m) => m.pinned_leaf));
  const out = await grandma.knit(outer, { memory: {}, models, logger: false });
  assert.equal(out.result, 'leaf');
});

test('the checkpoint keeps the version-qualified tree name, and resume resolves it', async () => {
  const ask = Tree(
    name('pinned_ask'),
    Model('mock'),
    Human('reply'),
    Return((m) => `said:${m.reply}`),
  );
  ask.name = 'pinned_ask.v3';

  const outer = Tree(
    name('pinned_resume_outer'),
    From('pinned_ask'),
    Return((m) => m.pinned_ask),
  );
  const db = logPath();
  const first = await grandma.knit(outer, { memory: {}, models, logger: db });
  assert.equal(first.status, 'waiting', 'paused inside the pinned From target');

  const ro = new DatabaseSync(db, { readOnly: true });
  const rows = ro.prepare("SELECT branch_path FROM calls WHERE kind='human' ORDER BY seq").all();
  ro.close();
  const branchPath = String(rows.at(-1)?.branch_path ?? '');
  const segments = branchPath.split('/');
  assert.ok(segments.includes('pinned_ask.v3'), 'the pinned tree name is the resume identity');
  assert.ok(!segments.includes('pinned_ask'), 'the slot name is not the resume identity');

  // Resume: the version-qualified name is resolved by the host loader.
  const seen = [];
  const second = await grandma.knit(outer, {
    memory: {},
    models,
    logger: db,
    _continuation: first.continuation,
    humanInput: 'hey',
    loadTree: async (n) => {
      seen.push(n);
      return n === 'pinned_ask.v3' ? ask : null;
    },
  });
  assert.ok(seen.includes('pinned_ask.v3'), 'resume asked the host loader for the pinned name');
  assert.equal(second.result, 'said:hey', 'the paused conversation resumed in the pinned snapshot');
});
