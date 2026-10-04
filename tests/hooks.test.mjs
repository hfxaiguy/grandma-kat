// Hook() — positional event hooks. This covers the listener increment:
// onEmit() fires once per emit the declaring tree (or a descendant) runs, in
// the declarer's scope, seeded with the emitted value as `input`.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import grandma, {
  Tree, name, Branch, Human, Hook, onEmit, onHuman, Goto, Emit, Memory, Return, update,
} from "../src/index.mjs";

const run = (tree, runtime = {}) => grandma.knit(tree, runtime);

// validateRuntime insists on a resolvable model even for prompt-free trees.
const mock = { model: "mock", handler: async () => ({ content: "" }) };
const rt = () => ({ models: { default: mock } });
// Resuming needs a checkpoint store (a temp log db).
const logPath = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kat-hooks-")), "log.db");

test("onEmit hook runs in the declarer's scope and sees each emit", async () => {
  const collector = Tree(name("collector"),
    Memory(update(), "seen", (m, cur) => [...(Array.isArray(cur) ? cur : []), m.input]),
  );
  const tree = Tree(name("emitter"),
    Memory("seen", () => []),
    Hook(onEmit(), collector),
    Emit(() => ({ text: "one" })),
    Emit(() => ({ text: "two" })),
    Return((m) => m.seen),
  );
  const out = await run(tree, rt());
  assert.deepEqual(out.result, [{ text: "one" }, { text: "two" }]);
});

test("a hook covers descendant trees", async () => {
  const collector = Tree(name("collector2"),
    Memory(update(), "seen", (m, cur) => [...(Array.isArray(cur) ? cur : []), m.input]),
  );
  const inner = Tree(name("inner"),
    Emit(() => "inner-emit"),
  );
  const tree = Tree(name("outer"),
    Memory("seen", () => []),
    Hook(onEmit(), collector),
    Branch(inner),
    Return((m) => m.seen),
  );
  const out = await run(tree, rt());
  assert.deepEqual(out.result, ["inner-emit"]);
});

test("hooks do not nest: a hook's own emit does not re-fire hooks", async () => {
  const collector = Tree(name("collector3"),
    Emit(() => "hook-emit"),
    Memory(update(), "seen", (m, cur) => [...(Array.isArray(cur) ? cur : []), m.input]),
  );
  const tree = Tree(name("emitter3"),
    Memory("seen", () => []),
    Hook(onEmit(), collector),
    Emit(() => "outer"),
    Return((m) => m.seen),
  );
  const out = await run(tree, rt());
  assert.deepEqual(out.result, ["outer"]);
});

test("a hook tree with a Human() pause is rejected at run time", async () => {
  const bad = Tree(name("bad_hook"), Human("stop"));
  const tree = Tree(name("emitter4"),
    Hook(onEmit(), bad),
    Emit(() => 1),
    Return(() => 1),
  );
  await assert.rejects(() => run(tree, rt()), /pause-free/);
});

test("Hook() requires an onEmit()/onHuman() trigger", () => {
  assert.throws(
    () => Tree(name("bad"), Hook("emit", Tree(name("x"), Return(() => 1)))),
    /onEmit\(\) or onHuman\(\)/,
  );
});

test("onHuman hook redirects the reply to an ancestor Human", async () => {
  const redirectHook = Tree(name("redirect_hook"),
    Goto("start_input", (m) => m.input),
  );
  const inner = Tree(name("redirect_inner"),
    Emit(() => "inner emit"),
    Human("inner_wait"),
    Return(() => "inner done"),
  );
  const tree = Tree(name("redirect_root"),
    Hook(onHuman(), redirectHook),
    Branch(inner),
    Human("start_input"),
    Return((m) => `start=${m.start_input}`),
  );

  const logger = logPath();
  const runtime = () => ({ models: { default: mock }, logger });
  const first = await run(tree, runtime());
  assert.equal(first.status, "waiting");
  assert.equal(first.humanSlot, "inner_wait");

  const second = await run(tree, { ...runtime(), _continuation: first.continuation, humanInput: "go" });
  assert.equal(second.result, "start=go", "the reply was redirected to start_input");
});

test("onHuman hook without a Goto delivers the reply normally", async () => {
  const observer = Tree(name("observer_hook"),
    Memory(update(), "heard", (m, cur) => [...(Array.isArray(cur) ? cur : []), m.input]),
  );
  const inner = Tree(name("deliver_inner"),
    Human("wakeme"),
    Return((m) => m.wakeme),
  );
  const tree = Tree(name("deliver_root"),
    Memory("heard", () => []),
    Hook(onHuman(), observer),
    Branch(inner),
    Return((m) => m.heard),
  );

  const logger = logPath();
  const runtime = () => ({ models: { default: mock }, logger });
  const first = await run(tree, runtime());
  assert.equal(first.status, "waiting");
  assert.equal(first.humanSlot, "wakeme");

  const second = await run(tree, { ...runtime(), _continuation: first.continuation, humanInput: "hello" });
  assert.deepEqual(second.result, ["hello"], "the hook observed the reply; delivery was normal");
});
