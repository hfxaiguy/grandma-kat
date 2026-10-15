// A deferred `From('app')` port (the target is not registered when the host
// tree is built, so the branch carries a ref and is resolved at run time)
// resolves through the registry when the host has no `loadTree`. A tree that
// only self-registered on import never ran the build pass that auto-names its
// subtrees, so resolving it here must normalize it exactly as the `loadTree`
// path does. Otherwise the unnamed subtrees push empty branch_path segments
// and the NEXT resume throws "cannot resume: tree '' is not registered".
//
// This is the live shape behind a real crash: the trunk attaches
// `From('trunk_turn')` before trunk_step is imported, and trunk_turn's
// `Branch`/`Each` bodies are unnamed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import kat, { Tree, name, Branch, Memory, Human, Return, registerTree, From } from '../src/index.mjs';
import { mockRuntime } from './helpers.mjs';

// A self-registering app tree with an UNNAMED branch body — the subtree that
// gains the empty auto-name when the build pass is skipped.
function makeApp() {
  return Tree(
    name('app'),
    Memory('reply', () => ''),
    Branch(Tree(Human('reply'))),
    Return((m) => m.reply),
  );
}

test("a deferred From() port resolves an unbuilt registry tree without poisoning resume", async () => {
  const dbPath = path.join(os.tmpdir(), `kat-deferred-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const runtime = (humanInput) => ({
    ...mockRuntime(async () => ({ content: 'x' }), {
      models: { default: { model: 'mock', handler: async () => ({ content: 'x' }) } },
      memory: {},
      logger: dbPath,
    }),
    humanInput,
  });
  try {
    // Build the host while 'app' is unregistered, so From('app') is a DEFERRED
    // port; then self-register 'app' (as importing its module would) with no
    // build pass. The host has no loadTree, so the port resolves via registry.
    const host = Tree(name('host'), From('app'), Return((m) => m.branch.app ?? ''));
    registerTree(makeApp());

    const first = await kat.knit(host, runtime('hi'));
    assert.equal(first.status, 'waiting', 'paused inside the ported app tree');

    const second = await kat.knit(host, { ...runtime('more'), _continuation: first.continuation });
    assert.notEqual(second.status, 'waiting', 'the checkpoint resumed without a resolve error');

    const db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare("SELECT branch_path FROM calls WHERE kind='human' ORDER BY seq").all();
    db.close();
    for (const r of rows) {
      assert.ok(!r.branch_path.includes('//') && !r.branch_path.endsWith('/'), `no empty branch_path segment: ${JSON.stringify(r.branch_path)}`);
    }
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
});
