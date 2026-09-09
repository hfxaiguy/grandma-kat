// Smoke test for person-scan: run the tree with a mock model (no network)
// and verify the notation's behavior — the emit fires, the human pause
// happens, and the gated branch runs only when the model says "yes".
//
// Run:  node examples/notation/person-scan.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import grandma from "../../src/index.mjs";
import { pattern } from "./person-scan.mjs";

// .human() checkpoint/resume requires a DB-backed logger (SQLite) — with
// `logger: false` the checkpoint isn't persisted, so resume() can't find it.
// Each test gets its own throwaway DB.
function makeRuntime(answers) {
  return {
    models: {
      default: {
        model: "mock",
        handler: async () => ({ content: answers.shift() ?? "" }),
      },
    },
    tools: {},
    logger: path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "gk-smoke-")),
      "grandma-kat.db",
    ),
  };
}

test("emits the greeting, then pauses for input_1", async () => {
  const emitted = [];
  const runtime = {
    ...makeRuntime([]),
    onEmit: (v) => emitted.push(v),
  };

  const out = await grandma.knit(pattern, runtime);

  // The verbatim `<< output_msg:` greeting reached onEmit.
  assert.deepEqual(emitted, [{ text: "Hi. This is grandpa-bob" }]);

  // It paused at `>> human: input_1` before asking the model anything.
  assert.equal(out.status, "waiting");
  assert.equal(out.humanSlot, "input_1");
});

test("gates in summarize_people when the model says yes", async () => {
  const emitted = [];
  const runtime = {
    ...makeRuntime(["yes", "2 people: John (email), Jane (phone)"]),
    onEmit: (v) => emitted.push(v),
  };

  // First run pauses at .human("input_1").
  const paused = await grandma.knit(pattern, runtime);
  assert.equal(paused.status, "waiting");

  // Resume with the human's message; the mock then answers "yes".
  const { result } = await grandma.resume(paused.continuation, {
    ...runtime,
    humanInput: "John M, janed@example.com",
  });

  // The gated branch ran and returned its extraction text.
  assert.equal(result, "2 people: John (email), Jane (phone)");
});

test("skips summarize_people when the model says no", async () => {
  const runtime = makeRuntime(["no"]);

  const paused = await grandma.knit(pattern, runtime);
  assert.equal(paused.status, "waiting");

  const { result } = await grandma.resume(paused.continuation, {
    ...runtime,
    humanInput: "the weather is fine",
  });

  // The branch was skipped; the tree's result is the scan_input "no".
  assert.equal(result, "no");
});
