// An EXPLICIT tool loop (Prompt(disableAuto) → Memory(calls) → Branch(Each →
// Call) → Until) is the trunk_step/turn shape. When a round BEFORE the paused
// one completed an item, the map-item reconstruction in resume() was keyed by
// branch path + child name only — so the previous round's `map_item` row was
// mixed into the current round, the paused item looked already-done and was
// SKIPPED, and the loop re-prompted the model instead of resuming the paused
// app tree. The next human input then landed on the outer turn (the walk was
// orphaned and the user's report was silently dropped).
//
// The key is now the map's own SCOPE id: each loop round enters the map in a
// fresh scope, so rounds cannot collide while one round's items still group.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import grandma, { Tree, when, max, disableAuto, name, Tools, Human, Prompt, Memory, Branch, Each, Call, Until, Return } from '../src/index.mjs';
import { scripted, mockRuntime, tool } from './helpers.mjs';

const tmpLogger = () => path.join(os.tmpdir(), `grandma-kat-maprounds-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
const tc = (name, args, id = name) => ({ id, function: { name, arguments: JSON.stringify(args ?? {}) } });

test('resume: a paused tree tool after an earlier loop round resumes in place', async () => {
  const dbPath = tmpLogger();
  try {
    // The app tree pauses on its Human (the caller-list walk's shape).
    const app = Tree(name('app'),
      Memory('reply', () => ''),
      Branch(Tree(name('app_reply'), Human('reply'))),
      Return((m) => m.reply));

    const tools = {
      ping: tool(async () => 'pong'),
      app_tool: { description: 'the app', parameters: {}, tree: app },
    };

    // The host turn: an explicit tool loop, exactly like trunk_step's.
    // (Every inline subtree is named — resume reconstructs the stack from the
    // branch path, and an unnamed subtree leaves an empty segment.)
    const host = Tree(name('host'),
      Tools('ping', 'app_tool'),
      Prompt(disableAuto(), 'response', () => 'go'),
      Memory('calls', (m) => m.raw?.branch?.response?.toolCalls ?? []),
      Branch(when((m) => (m.calls ?? []).length > 0), Tree(name('host_round'),
        Each('tool_calls', (m) => m.calls, Tree(name('host_call'),
          Call((m) => m.item.name, (m) => JSON.parse(String(m.item.arguments ?? '{}'))),
        )),
      )),
      Until((m) => (m.calls ?? []).length === 0, max(12)),
      Return((m) => m.response ?? ''));

    // Round 1: a function tool (the self-investigation a live trunk does
    // before routing). Round 2: the app tree, which pauses on its Human.
    const first = await grandma.knit(host, mockRuntime(
      scripted([
        { content: '', tool_calls: [tc('ping', {})] },
        { content: '', tool_calls: [tc('app_tool', {})] },
      ]),
      { logger: dbPath, tools },
    ));
    assert.equal(first.status, 'waiting', 'paused inside the app tree');
    assert.equal(first.humanSlot, 'reply');

    // Resume with the caller's message. The app tree must take it.
    const secondHandler = scripted(['final text']);
    const second = await grandma.knit(host, {
      ...mockRuntime(secondHandler, { logger: dbPath, tools }),
      _continuation: first.continuation,
      humanInput: 'hello',
    });

    assert.equal(second.status, undefined, 'the run completed (it did not re-pause)');

    const db = new DatabaseSync(dbPath, { readOnly: true });
    const humans = db.prepare(
      "SELECT json_extract(content,'$.child') AS child, json_extract(content,'$.delivered') AS delivered, json_extract(content,'$.value') AS value FROM calls WHERE kind='human' ORDER BY seq",
    ).all();
    const toolRows = db.prepare(
      "SELECT kind, json_extract(content,'$.tool') AS tool, json_extract(content,'$.result') AS result FROM calls WHERE kind IN ('tool_call','tool_result') ORDER BY seq",
    ).all();
    db.close();

    const delivered = humans.filter((h) => h.delivered === 1);
    assert.equal(delivered.length, 1, 'exactly one human input was delivered');
    assert.equal(delivered[0].child, 'reply', 'it was delivered to the PAUSED APP slot, not the host turn');
    assert.equal(delivered[0].value, 'hello', 'the app received the caller message');
    assert.ok(
      toolRows.some((r) => r.tool === 'app_tool' && r.result === 'hello'),
      'the app tree returned the resumed value to the loop',
    );
    assert.equal(secondHandler.calls.length, 1, 'the host prompt ran once more — for the final round, not to swallow the input');
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
});
