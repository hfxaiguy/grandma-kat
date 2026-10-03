#!/usr/bin/env node
// tree-smith — runnable entry.
//
// The host wires what the pattern cannot: the static tool entries. The tool
// surface can't grow names at run time (Tools(...) whitelists are validated
// when knit() starts), so slots are chosen up front — one entry per
// SURFACE.slots, each resolving its alias at call time (resolveTreeTool ->
// loadNamedTree -> registry). The compiler registers re-register their alias
// on every successful define: one live definition per slot, unlimited
// invocations.
//
// The authoring phase runs through the same registry, so the tools here are
// also what the authoring model can inspect the data with (`sql_query` over
// a demo contacts table) and test-run against.
//
// Run from the repo root (the config path resolves from the cwd):
//   node examples/tree-smith/entry.mjs "say hello and report the time"

import { DatabaseSync } from 'node:sqlite';
import grandma, { KnitError } from '../../src/index.mjs';
import { loadConfig } from '../lib/config.mjs';
import { smith, SURFACE, aliasFor } from './tree-smith.mjs';

const task = process.argv.slice(2).join(' ') || 'Say hello, then report the current time.';

const config = loadConfig();
const models = Object.fromEntries(Object.keys(SURFACE.models).map((name) => [name, {
  baseURL: config.provider.baseURL,
  apiKey: config.provider.apiKey,
  model: config.model,
}]));

// Demo data: a tiny in-memory contacts table so the author can inspect real
// schemas/rows before writing, and any tree it writes can query them.
// Read-only by construction — sql_query rejects anything that is not a
// SELECT/WITH, so exploration (and generated trees) can read but not mutate.
const db = new DatabaseSync(':memory:');
db.exec(`
  CREATE TABLE contacts (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    company TEXT,
    phone TEXT
  );
  INSERT INTO contacts (name, company, phone) VALUES
    ('Ada Lovelace', 'Harbr Group', '555-0100'),
    ('Bob Kahn', 'Harbr Group', ''),
    ('Cyd Charisse', 'Harbr Group', NULL),
    ('Dee Dee', 'Other Co', '555-0199');
`);

const tools = {
  // demo tools: metadata from SURFACE (single source of truth), impls here
  echo: { ...SURFACE.tools.echo, execute: async (args) => args.text },
  clock: { ...SURFACE.tools.clock, execute: async () => new Date().toISOString() },
  sql_query: {
    ...SURFACE.tools.sql_query,
    execute: async ({ sql }) => {
      if (!/^\s*(select|with)\b/i.test(String(sql))) {
        throw new Error('sql_query is read-only in this demo — use a SELECT statement');
      }
      return db.prepare(sql).all();
    },
  },

  // THE slot entries: static names pointing at the dynamic aliases. `live`
  // is what the smith promotes and invokes; `draft` is the author's
  // workbench for test-runs.
  ...Object.fromEntries(SURFACE.slots.map((slot) => [`run_${slot}`, {
    description: `Run the tree defined in slot '${slot}' (alias '${aliasFor(slot)}'). Argument keys seed the tree as its initial memory; trees declare Needs('task').`,
    parameters: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] },
    tree: aliasFor(slot),
  }])),
};

try {
  const { result, runId } = await grandma.knit(smith, {
    models,
    tools,
    memory: { task },
    // Watch the smith work: every successful define is announced with the
    // authored source + the definition's name.
    onEmit: (v) => console.log(`[defined ${v.defined} @ ${v.alias}]`),
  });

  console.log(`\nRun: ${runId}`);
  console.log(`\n--- authored pattern ---\n${result.source}\n`);
  console.log('--- result ---');
  console.log(result.result);
} catch (err) {
  if (err instanceof KnitError) {
    console.error(`tree-smith failed: ${err.message}`);
    process.exit(1);
  }
  throw err;
}
