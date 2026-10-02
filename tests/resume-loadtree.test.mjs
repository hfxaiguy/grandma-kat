// A tree loaded through the runtime's `loadTree` (the resume fallback a host
// uses after a restart) must be auto-named like any other tree: the checkpoint
// stores the paused tree's branch_path, and a loop rewind re-descends through
// the loaded tree's children. If those children are unnamed, the branch_path
// gains an empty segment ('root/root#2/') and the NEXT resume tries to resolve
// the empty name and throws "tree '' is not registered".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import kat, { Tree, name, Branch, Memory, Human, Until, max, Return } from '../src/index.mjs';
import { mockRuntime } from './helpers.mjs';

// A host-style build: the tree names itself `loopinternal`, then the host
// renames the root (BOB renames to the resolved internal name). The registry
// keeps `loopinternal`; `rootName` is never registered — so resume must load
// it through `loadTree`, exactly like BOB after a restart.
function makeTree(rootName) {
  const inner = Tree(
    Branch(Tree(Human('reply'))),
    Until((m) => m.reply === 'done', max(5)),
  );
  const t = Tree(
    name('loopinternal'),
    Memory('reply', () => ''),
    Branch(inner),
    Return((m) => ({ reply: m.reply })),
  );
  (t.def ?? t).name = rootName;
  return t;
}

test('resume auto-names subtrees loaded through loadTree', async () => {
  const dbPath = path.join(os.tmpdir(), `kat-loadtree-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  try {
    const rt = (humanInput) => ({
      ...mockRuntime(async () => ({ content: 'x' }), {
        models: { default: { model: 'mock', handler: async () => ({ content: 'x' }) } },
        memory: {},
        logger: dbPath,
      }),
      // The host loader hands back a fresh tree on every call.
      loadTree: async (nm) => makeTree(nm),
      humanInput,
    });

    const first = await kat.knit(makeTree('loop-root'), rt());
    assert.equal(first.status, 'waiting', 'paused at the first human');

    // 'more' does not satisfy the Until, so the loop rewinds and pauses again
    // — the pass that re-descends through the loaded tree's unnamed subtree.
    const second = await kat.knit(makeTree('loop-root'), { ...rt('more'), _continuation: first.continuation });
    assert.equal(second.status, 'waiting', 'the loop rewound and paused again');

    const third = await kat.knit(makeTree('loop-root'), { ...rt('done'), _continuation: second.continuation });
    assert.notEqual(third.status, 'waiting', 'the second checkpoint resumes cleanly');

    const db = new DatabaseSync(dbPath, { readOnly: true });
    const paths = db.prepare("SELECT branch_path FROM calls WHERE kind='human' ORDER BY seq").all().map((r) => r.branch_path);
    db.close();
    assert.equal(paths.length, 2, 'two pauses were logged');
    for (const p of paths) {
      assert.ok(!p.endsWith('/') && !p.includes('//') && !p.includes('undefined'), `no empty branch_path segment: ${JSON.stringify(p)}`);
    }
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
});
