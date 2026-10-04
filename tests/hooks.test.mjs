// Hook() — positional event hooks. This covers the listener increment:
// onEmit() fires once per emit the declaring tree (or a descendant) runs, in
// the declarer's scope, seeded with the emitted value as `input`.

import { test } from "node:test";
import assert from "node:assert/strict";
import grandma, {
  Tree, name, Branch, Human, Hook, onEmit, Emit, Memory, Return, update,
} from "../src/index.mjs";

const run = (tree, runtime = {}) => grandma.knit(tree, runtime);

// validateRuntime insists on a resolvable model even for prompt-free trees.
const mock = { model: "mock", handler: async () => ({ content: "" }) };
const rt = () => ({ models: { default: mock } });

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
