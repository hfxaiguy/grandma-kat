// The generalized three-tree ref handoff — no app trees.
//
//   producer (tree tool) ── big result ──▶ trunk-like loop (Each + fold)
//        the fold clamps the result for the model and mints a ref:// handle
//        from the item's run-log seq
//                                              │  the model reads the note
//                                              ▼  and passes the ref
//   consumer (tree tool) ◀── full array ──── the engine resolves the ref at
//                                            the tree-tool boundary
//
// The scripted model acts the way the real trunk guidance asks it to: round 2
// extracts the ref from the truncation note it was shown (and throws if the
// note carried none). The final assertions check both sides of the handoff:
// the model only ever saw the clamped text, while the consumer received the
// literal 50-row array — and the run log still shows the raw ref string as
// the call's argument.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import grandma, {
  Tree, name, Model, Tools, Needs, Each, Call, Memory, Prompt, Branch, Until, Return,
  when, update, disableAuto, max,
} from "../src/index.mjs";
import { mockRuntime, scripted } from "./helpers.mjs";

// ── the three trees, all generic ───────────────────────────────────────────

/** producer: the big value owner — 50 rows, far past the display caps. */
const producer = Tree(name("producer"), Needs("n"),
  Return((m) => ({
    ok: true,
    list: Array.from({ length: Number(m.n) || 0 }, (_, i) => ({
      id: i + 1,
      name: `Person ${i + 1}`,
      bio: "x".repeat(60),
    })),
  })));

/** consumer: the probe. A ref that did not resolve arrives as a string and
 *  fails the call loudly (captured as a tool error, visible in the log). */
const consumer = Tree(name("consumer"), Needs("input"),
  Memory("verify", (m) => {
    if (!Array.isArray(m.input)) {
      throw new Error(`ref NOT resolved — input arrived as ${typeof m.input}: ${String(m.input).slice(0, 80)}`);
    }
    return m.input.length;
  }),
  Return((m) => ({ handled: true, text: `received ${m.verify} rows` })));

// ── the trunk-like loop (mirrors patterns/trunk_step's explicit tool loop) ─

const CAP = 1000;

/** What the fold shows the model for an oversized result: a clamp plus the
 *  ref:// handle minted from the item's run-log seq (the trunk's shape). */
function shapeForModel(result, seq) {
  const text = JSON.stringify(result ?? "");
  if (text.length <= CAP) return text;
  const list = Array.isArray(result?.list) ? result.list : null;
  const ref = Number.isFinite(seq) ? `ref://${seq}${list ? "/list" : ""}` : "(no ref)";
  const preview = list ? list.slice(0, 3).map((r) => r.name).join(", ") : "";
  return (
    `${text.slice(0, CAP)}\n…[truncated — ${text.length} chars total; full value: ${ref}` +
    `${list ? ` (${list.length} rows${preview ? `: ${preview}…` : ""})` : ""}. ` +
    "Pass the ref as a tree tool's input.]"
  );
}

const roundCalls = (m) => (m.raw?.branch?.response?.toolCalls ?? []).filter((c) => c && typeof c.name === "string");
const messageText = (v) => (typeof v === "string" ? v : v == null ? "" : JSON.stringify(v));
const roundText = (m) => messageText(m.branch?.response);
const callArgs = (call) => {
  try {
    const parsed = JSON.parse(String(call?.arguments ?? "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

function foldToolRound(messages, m) {
  const calls = Array.isArray(m.calls) ? m.calls : [];
  const results = Array.isArray(m.branch.tool_calls) ? m.branch.tool_calls : [];
  // The engine's Each record carries each item's run-log seq — the address
  // a truncation note turns into a ref:// handle.
  const itemSeqs = Array.isArray(m.raw?.branch?.tool_calls?.itemSeqs)
    ? m.raw.branch.tool_calls.itemSeqs
    : [];
  const wire = calls.map((c) => ({
    id: c.id,
    type: "function",
    function: { name: c.name, arguments: String(c.arguments ?? "{}") },
  }));
  const out = [...messages, { role: "assistant", content: roundText(m) || null, tool_calls: wire }];
  calls.forEach((c, i) => {
    out.push({ role: "tool", tool_call_id: c.id, content: shapeForModel(results[i], itemSeqs[i]) });
  });
  return out;
}

const miniTrunk = Tree(name("mini"),
  Model("default"),
  Tools("producer", "consumer"),
  Memory("messages", (m, cur) => (Array.isArray(cur) ? cur : [{ role: "system", content: "You are a trunk. Use the tools." }])),
  Prompt(disableAuto(), "response", (m) => m.messages),
  Memory("calls", (m) => roundCalls(m)),
  Branch(when((m) => (m.calls ?? []).length > 0), Tree(
    Each("tool_calls", (m) => m.calls, Tree(Call((m) => m.item.name, (m) => callArgs(m.item)))),
    Memory(update(), "messages", (m, cur) => foldToolRound(cur, m)),
  )),
  Until((m) => (m.calls ?? []).length === 0, max(12, (m) => `tool-iteration limit: ${m.error ?? "stuck"}`)),
  Return(roundText));

// ── the scripted model: round 2 acts on the note, as a real model would ────

const tc = (n, a, id = n) => ({ id, function: { name: n, arguments: JSON.stringify(a ?? {}) } });

const extractRef = (messages) => {
  const tool = [...messages].reverse().find((m) => m.role === "tool");
  const match = String(tool?.content ?? "").match(/ref:\/\/(\d+)\/list/);
  if (!match) {
    throw new Error(`the note shown to the model carried no usable ref:\n${tool?.content}`);
  }
  return `ref://${match[1]}/list`;
};

// ── the test ───────────────────────────────────────────────────────────────

test("three-tree handoff: producer → trunk-like loop → consumer via a ref the model read from the note", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kat-handoff-"));
  const dbPath = path.join(dir, "runs.db");

  const handler = scripted([
    { content: "", tool_calls: [tc("producer", { n: 50 })] },
    (messages) => ({ content: "", tool_calls: [tc("consumer", { input: extractRef(messages) })] }),
    { content: "Handed the batch over." },
  ]);

  const runtime = mockRuntime(handler, {
    tools: {
      producer: { description: "produce rows", parameters: {}, tree: producer },
      consumer: { description: "consume a list", parameters: {}, tree: consumer },
    },
    logger: dbPath,
  });

  const { result } = await grandma.knit(miniTrunk, runtime);
  assert.equal(result, "Handed the batch over.");

  // The model's round-2 view: clamped text + the ref note, well short of the
  // 50 rows it was NOT shown.
  const round2 = handler.calls[1].messages;
  const toolMsg = [...round2].reverse().find((m) => m.role === "tool");
  assert.match(toolMsg.content, /truncated/);
  assert.match(toolMsg.content, /ref:\/\/\d+\/list/);
  assert.ok(toolMsg.content.length < CAP + 500, "the model never carried the full list");

  // The run log: the call's ARGUMENT is still the raw ref string (the model
  // never held the data), while the consumer's RESULT proves the resolved
  // array arrived at the tree.
  const db = new DatabaseSync(dbPath, { readOnly: true });
  let rows;
  try {
    rows = db.prepare("SELECT content FROM calls WHERE kind = 'tool_call'").all()
      .map((r) => JSON.parse(r.content));
  } finally {
    db.close();
  }

  const producerRow = rows.find((r) => r.tool === "producer");
  assert.equal(producerRow.result.ok, true);
  assert.equal(producerRow.result.list.length, 50);

  const consumerRow = rows.find((r) => r.tool === "consumer");
  assert.match(String(consumerRow.args.input), /^ref:\/\/\d+\/list$/, "the model's argument was the ref, not the data");
  assert.ok(!consumerRow.isError, `the ref resolved and the tree ran: ${JSON.stringify(consumerRow)}`);
  assert.deepEqual(consumerRow.result, { handled: true, text: "received 50 rows" });
});

// ── the same handoff through the ENGINE's auto loop ─────────────────────────
// The one-shot subagent shape: no disableAuto, no Each — the engine runs the
// tools and caps the thread itself (knit.mjs capToolResult). The cap mints the
// same ref:// handle, and a bare ref (no path) resolves to the whole value.

const consumerAny = Tree(name("consumer_any"), Needs("input"),
  Memory("verify", (m) => {
    const list = Array.isArray(m.input) ? m.input : m.input?.list;
    if (!Array.isArray(list)) {
      throw new Error(`ref NOT resolved — input arrived as ${typeof m.input}: ${String(m.input).slice(0, 80)}`);
    }
    return list.length;
  }),
  Return((m) => ({ handled: true, text: `received ${m.verify} rows` })));

const autoTrunk = Tree(name("auto_trunk"),
  Model("default"),
  Tools("producer", "consumer_any"),
  Prompt("response", () => [
    { role: "system", content: "You are a one-shot subagent. Hand big values to the consumer." },
    { role: "user", content: "hand the batch over" },
  ]),
  Return((m) => messageText(m.branch.response)));

const extractBareRef = (messages) => {
  const tool = [...messages].reverse().find((m) => m.role === "tool");
  const match = String(tool?.content ?? "").match(/ref:\/\/(\d+)(?![\d/])/);
  if (!match) {
    throw new Error(`the note shown to the model carried no usable ref:\n${tool?.content}`);
  }
  return `ref://${match[1]}`;
};

test("auto loop (one-shot subagent path): the engine's own cap mints the same ref", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kat-autoref-"));
  const dbPath = path.join(dir, "runs.db");

  const handler = scripted([
    { content: "", tool_calls: [tc("producer", { n: 50 })] },
    (messages) => ({ content: "", tool_calls: [tc("consumer_any", { input: extractBareRef(messages) })] }),
    { content: "done" },
  ]);

  const runtime = mockRuntime(handler, {
    tools: {
      producer: { description: "produce rows", parameters: {}, tree: producer },
      consumer_any: { description: "consume", parameters: {}, tree: consumerAny },
    },
    logger: dbPath,
  });

  const { result } = await grandma.knit(autoTrunk, runtime);
  assert.equal(result, "done");

  // The model's second view: the engine's cap note with the ref and preview.
  const round2 = handler.calls[1].messages;
  const toolMsg = [...round2].reverse().find((m) => m.role === "tool");
  assert.match(toolMsg.content, /truncated/);
  assert.match(toolMsg.content, /ref:\/\/\d+/);
  assert.match(toolMsg.content, /50 rows: Person 1, Person 2/);
  assert.ok(toolMsg.content.length < 4000 + 500, "the model never carried the full list");

  // The consumer's tool_result row: the bare ref resolved to the whole value.
  const db = new DatabaseSync(dbPath, { readOnly: true });
  let results;
  try {
    results = db.prepare("SELECT content FROM calls WHERE kind = 'tool_result'").all()
      .map((r) => JSON.parse(r.content));
  } finally {
    db.close();
  }
  const consumerRow = results.find((r) => r.tool === "consumer_any");
  assert.ok(!consumerRow.isError, `the ref resolved and the tree ran: ${JSON.stringify(consumerRow)}`);
  assert.deepEqual(consumerRow.result, { handled: true, text: "received 50 rows" });
});
