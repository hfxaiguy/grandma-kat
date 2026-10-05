// A host (BOB) registers every app/pattern tree in grandma-kat's global
// registry at startup — with `registerTree(def)`, which does NOT run the build
// pass that auto-names and registers the tree's subtrees. A checkpoint that
// paused inside such a tree (here: a tree-backed tool's inner branch) stores
// the subtree's auto-name in its branch_path; on the next process, resume
// resolves the whole stack up front, so the cached root must be normalized
// (auto-named) before its subtree is looked up. Otherwise resume throws
// "cannot resume: tree 'app#2' is not registered".
//
// The first run and the resume must be separate processes (a fresh registry),
// so this test drives a tiny script through two `node` invocations.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(testsDir, '..');
const srcHref = pathToFileURL(path.join(root, 'src', 'index.mjs')).href;
const helpersHref = pathToFileURL(path.join(testsDir, 'helpers.mjs')).href;

test('resume normalizes a host-registered tree so its subtrees resolve', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kat-reg-'));
  const dbPath = path.join(dir, 'run.db');
  const script = path.join(dir, 'drive.mjs');
  fs.writeFileSync(script, `
import kat, { Tree, name, Branch, Memory, Human, Until, max, Return, Call, registerTree } from ${JSON.stringify(srcHref)};
import { mockRuntime } from ${JSON.stringify(helpersHref)};

const [phase, dbPath, contJson] = process.argv.slice(2);

function makeApp() {
  return Tree(
    name('app'),
    Memory('reply', () => ''),
    Branch(Tree(Human('reply'))),
    Until((m) => m.reply === 'done', max(5)),
    Return((m) => m.reply),
  );
}
function makeHost() {
  return Tree(
    name('host'),
    Call('run_app', 'app_tool', () => ({})),
    Return((m) => m.branch.run_app),
  );
}
function runtime(humanInput, extra = {}) {
  return {
    ...mockRuntime(async () => ({ content: 'x' }), {
      models: { default: { model: 'mock', handler: async () => ({ content: 'x' }) } },
      tools: { app_tool: { description: 'app', parameters: {}, tree: 'app' } },
      memory: {},
      logger: dbPath,
    }),
    loadTree: async (n) => (n === 'app' ? makeApp() : null),
    humanInput,
    ...extra,
  };
}

// The host registers the app tree at startup, without a build pass.
registerTree(makeApp());

if (phase === 'pause') {
  const first = await kat.knit(makeHost(), runtime(''));
  process.stdout.write(JSON.stringify({ status: first.status, continuation: first.continuation }));
} else {
  const cont = JSON.parse(contJson);
  const second = await kat.knit(makeHost(), runtime('done', { _continuation: cont.continuation }));
  process.stdout.write(JSON.stringify({ status: second.status }));
}
`);

  try {
    const paused = JSON.parse(
      execFileSync(process.execPath, [script, 'pause', dbPath], { encoding: 'utf8' }),
    );
    assert.equal(paused.status, 'waiting', 'the host run paused inside the app tree');

    // Fresh process: a new registry, the host re-registers the app tree, and
    // resume must still resolve the app subtree named in the checkpoint.
    const resumed = JSON.parse(
      execFileSync(process.execPath, [script, 'resume', dbPath, JSON.stringify(paused)], {
        encoding: 'utf8',
      }),
    );
    assert.notEqual(resumed.status, 'waiting', 'the checkpoint resumed without a resolve error');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
