// A checkpoint stores the paused tree stack as a `branch_path` whose segments
// are positional auto-names (`r#2`) — valid only for the exact build that wrote
// them. If the tree is rebuilt so that auto-name no longer exists (a subtree
// body gets an author name, a sibling shifts, an app is renamed), resume must
// not die with "cannot resume: tree 'r#2' is not registered". It re-derives the
// level from its parent's recorded child index instead.
//
// The first run and the resume are separate processes (a fresh registry), so
// the stale auto-name is genuinely absent on resume — the shape a restart
// produces.

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

test('resume re-derives a level whose stored auto-name no longer exists', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kat-pos-'));
  const dbPath = path.join(dir, 'run.db');
  const script = path.join(dir, 'drive.mjs');
  fs.writeFileSync(script, `
import kat, { Tree, name, Memory, Branch, Human, Return } from ${JSON.stringify(srcHref)};
import { mockRuntime } from ${JSON.stringify(helpersHref)};

const [phase, dbPath, contJson] = process.argv.slice(2);

// Both variants pause at the same Human under a Branch that is child index 1
// of the root. Variant 'unnamed' leaves the branch body anonymous, so the
// level is named 'r#2'; variant 'named' gives the body an author name, so the
// rebuilt tree never produces 'r#2'.
function makeTree(variant) {
  const body = variant === 'named'
    ? Tree(name('renamed'), Human('x'))
    : Tree(Human('x'));
  return Tree(
    name('r'),
    Memory('a', () => 0),
    Branch(body),
    Return((m) => ({ x: m.x })),
  );
}
const runtime = (humanInput) => ({
  ...mockRuntime(async () => ({ content: 'x' }), {
    models: { default: { model: 'mock', handler: async () => ({ content: 'x' }) } },
    memory: {},
    logger: dbPath,
  }),
  humanInput,
});

if (phase === 'pause') {
  const first = await kat.knit(makeTree('unnamed'), runtime('hi'));
  process.stdout.write(JSON.stringify({ status: first.status, continuation: first.continuation, treePath: first.treePath }));
} else {
  const cont = JSON.parse(contJson);
  const second = await kat.knit(makeTree('named'), { ...runtime('more'), _continuation: cont.continuation });
  process.stdout.write(JSON.stringify({ status: second.status }));
}
`);

  try {
    const paused = JSON.parse(
      execFileSync(process.execPath, [script, 'pause', dbPath], { encoding: 'utf8' }),
    );
    assert.equal(paused.status, 'waiting', 'first run paused inside the branch');
    assert.equal(paused.treePath, 'r/r#2', 'the paused stack names the auto-named branch body');

    // Fresh process: 'r#2' is not in the registry (the body is now 'renamed');
    // resume re-derives it positionally from the root's child index 1.
    const resumed = JSON.parse(
      execFileSync(process.execPath, [script, 'resume', dbPath, JSON.stringify(paused)], { encoding: 'utf8' }),
    );
    assert.notEqual(resumed.status, 'waiting', 'the checkpoint resumed without a resolve error');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
