// The real app trees, copied from the workspace and converted to the element
// form, kept in-tree as fixtures. They must build, and the caller-list walk
// must knit end to end against stubbed host tools and a scripted model.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import grandma from '../src/index.mjs';
import { mockRuntime, tool } from './helpers.mjs';

import callerList from './fixtures/caller-list/tree.mjs';
import contactsTree from './fixtures/contacts/tree.mjs';

// ── the fixtures build ─────────────────────────────────────────────────────

test('the caller-list fixture builds from elements', () => {
  assert.equal(callerList.kind, 'tree');
  assert.equal(callerList.name, 'caller_list');
  assert.deepEqual(callerList.needs, ['input']);
  assert.deepEqual(callerList.models, [{ cond: null, value: 'strong' }]);

  const registerNames = callerList.registers.map((r) => r.name);
  assert.deepEqual(registerNames, [
    'contacts_query', 'contacts_write', 'start_call_list', 'complete_call_target',
    'try_next_phone', 'skip_call_target', 'add_call_phone', 'note_call_phone',
    'schedule_followup', 'add_call_contact', 'correct_record',
  ]);

  const kinds = callerList.children.map((c) => c.kind);
  assert.ok(kinds.includes('branch'), 'the selection review and walk are branches');
  assert.ok(kinds.includes('emit'), 'the walk presents through emits');
  assert.ok(kinds.includes('memoryUpdate'), 'the conversation log is a required update');
  const review = callerList.children.find((c) => c.kind === 'branch' && c.tree?.children?.some((x) => x.kind === 'until'));
  assert.ok(review, 'the selection review branch holds the until loop');
});

test('the contacts fixture builds from elements', () => {
  assert.equal(contactsTree.kind, 'tree');
  assert.equal(contactsTree.name, 'contacts');
  assert.deepEqual(contactsTree.needs, ['input']);
  assert.ok(!('registers' in contactsTree), 'contacts declares no inline tools — it uses host tools');
  assert.deepEqual(contactsTree.children.map((c) => c.kind), ['memory', 'branch', 'branch', 'branch', 'return']);
});

// ── the caller-list walk knits end to end ──────────────────────────────────

test('the caller-list fixture: review, confirm, then an empty list completes', async () => {
  const dbPath = path.join(os.tmpdir(), `grandma-kat-fixture-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  try {
    const emitted = [];
    const sqlQuery = (args) => {
      const q = String(args?.query ?? '');
      if (q.includes('sqlite_master')) {
        return { rows: [{ sql: 'CREATE TABLE profiles (id INTEGER PRIMARY KEY)' }] };
      }
      if (q.includes('COUNT(*)')) return { rows: [{ n: 0 }] };
      return { rows: [] };
    };
    const tools = {
      sql_query: tool(async (args) => sqlQuery(args)),
      sql_write: tool(async () => ({ changes: 0 })),
      contacts__get_contact: tool(async () => ({ ok: false, error: 'none' })),
      contacts__upsert_contact: tool(async () => ({ ok: true, profileId: 1 })),
      contacts__log_message: tool(async () => ({ ok: true })),
      contacts__search_contacts: tool(async () => ({ contacts: [] })),
    };
    // The tree's own selection prompt is the only one that runs before the
    // first pause; it must answer with the draft JSON, confirmed on "yes".
    const handler = async (messages) => {
      const sys = messages.find((x) => x.role === 'system')?.content ?? '';
      if (!sys.includes('select contacts for a call list')) return { content: '' };
      const user = messages.filter((x) => x.role === 'user').map((x) => String(x.content)).join('\n');
      return {
        content: JSON.stringify({
          sql: 'SELECT p.id AS id FROM profiles p',
          notes: 'everyone',
          confirmed: /Caller feedback:\s*yes/.test(user),
        }),
      };
    };
    const rt = {
      ...mockRuntime(handler, {
        tools,
        models: { strong: { model: 'mock', handler } },
        memory: { input: 'call everyone' },
        logger: dbPath,
      }),
      onEmit: (v) => emitted.push(v),
    };

    const first = await grandma.knit(callerList, rt);
    assert.equal(first.status, 'waiting', 'paused for the selection reply');
    assert.match(emitted[0].text, /^Selection SQL:/);
    assert.match(emitted[2].text, /Reply "yes" to build the call list/);

    const second = await grandma.resume(first.continuation, { ...rt, humanInput: { selection_reply: 'yes' } });
    assert.equal(second.status, undefined, 'the walk ran to completion');
    assert.equal(second.memory.done, true);
    assert.equal(second.memory.current, null);
    assert.ok(emitted.some((v) => /No contacts matched the selection/.test(v.text)));
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
});

// ── the contacts tree knits (classification path) ──────────────────────────

test('the contacts fixture knits with a stub model', async () => {
  const handler = async () => ({ content: '' });
  const result = await grandma.knit(contactsTree, mockRuntime(handler, {
    models: { strong: { model: 'mock', handler } },
    memory: { input: 'nothing contact-related' },
    tools: {
      duckdb_query: tool(async () => ({ rows: [] })),
      upsert_contact: tool(async () => ({ ok: true, profileId: 1 })),
    },
  }));
  assert.equal(result.status, undefined, 'no pause: the tree finished');
  assert.ok(result.memory.input === 'nothing contact-related' || result.memory.input != null);
});
