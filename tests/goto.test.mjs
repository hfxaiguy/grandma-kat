// Goto(target, valueFn?) — a directive (a tree step). It jumps to the Human()
// slot named `target` in this tree or an ancestor and, when filled, arms the
// slot so it proceeds instead of pausing. The arm is one-shot.

import { test } from "node:test";
import assert from "node:assert/strict";
import grandma, {
  Tree, name, Branch, Human, Goto, Memory, Return, Until, max, goto,
} from "../src/index.mjs";

const run = (tree, runtime = {}) => grandma.knit(tree, runtime);
const mock = { model: "mock", handler: async () => ({ content: "" }) };
const rt = () => ({ models: { default: mock } });

test("Goto(slot, value) arms a Human in the same tree and proceeds", async () => {
  const tree = Tree(name("g1"),
    Goto("wait", () => 42),
    Human("wait"),
    Return((m) => m.wait),
  );
  const out = await run(tree, rt());
  assert.equal(out.result, 42);
});

test("Goto crosses a branch to an ancestor's Human", async () => {
  const inner = Tree(name("g2_inner"),
    Goto("wait", () => "from-inner"),
  );
  const tree = Tree(name("g2"),
    Branch(inner),
    Human("wait"),
    Return((m) => m.wait),
  );
  const out = await run(tree, rt());
  assert.equal(out.result, "from-inner");
});

test("Goto without a value moves to the Human and waits there", async () => {
  const tree = Tree(name("g3"),
    Goto("wait"),
    Human("wait"),
    Return((m) => m.wait),
  );
  const out = await run(tree, rt());
  assert.equal(out.status, "waiting");
  assert.equal(out.humanSlot, "wait");
});

test("Goto to a name with no Human in scope is an error", async () => {
  const tree = Tree(name("g4"),
    Goto("nope", () => 1),
    Return(() => 1),
  );
  await assert.rejects(() => run(tree, rt()), /no Human\(\) slot/);
});

test("an armed Human is one-shot: a rewind back to it waits", async () => {
  const tree = Tree(name("g5"),
    Goto("wait", () => 1),
    Human("wait"),
    Until(goto("wait"), () => false, max(5)),
  );
  const out = await run(tree, rt());
  assert.equal(out.status, "waiting");
  assert.equal(out.humanSlot, "wait");
});

test("Goto's value fn sees memory", async () => {
  const tree = Tree(name("g6"),
    Memory("seed", () => "hello"),
    Goto("wait", (m) => m.seed + "!"),
    Human("wait"),
    Return((m) => m.wait),
  );
  const out = await run(tree, rt());
  assert.equal(out.result, "hello!");
});
