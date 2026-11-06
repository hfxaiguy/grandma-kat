// `temperature(n | fn)` on a Prompt sets the sampling temperature for that
// prompt's LLM call(s). The OpenAI-compatible path gets `body.temperature`;
// the native Ollama path gets `options.temperature`. A function of memory is
// re-evaluated for every round of the auto tool loop.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import grandma, { Tree, name, Prompt, Tools, Memory, temperature } from "../src/index.mjs";
import { callLlm } from "../src/llm.mjs";
import { scripted, mockRuntime, tool } from "./helpers.mjs";

/** Start a one-shot server that records the request body and replies OK. */
function capture(responseBody) {
  return new Promise((resolve) => {
    let seen = null;
    const s = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        seen = { url: req.url, body: raw ? JSON.parse(raw) : null };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(responseBody));
      });
    });
    s.listen(0, "127.0.0.1", () => {
      resolve({ s, port: s.address().port, get: () => seen });
    });
  });
}

const openaiReply = { choices: [{ message: { role: "assistant", content: "hi" } }] };
const ollamaReply = { message: { role: "assistant", content: "hi" }, done: true };

test("temperature() parses a static number or a memory function; plain prompts keep their shape", () => {
  const staticPrompt = Tree(name("static"), Prompt(temperature(0.7), () => "x"));
  assert.equal(staticPrompt.children[0].temperature, 0.7);

  const fn = (m) => m.temp;
  const dynamicPrompt = Tree(name("dynamic"), Prompt("p", () => "x", temperature(fn)));
  assert.equal(dynamicPrompt.children[0].temperature, fn);

  const unnamed = Tree(name("unnamed"), Prompt(() => "x", temperature(0.3)));
  assert.equal(unnamed.children[0].temperature, 0.3);

  const zero = Tree(name("zero"), Prompt(temperature(0), () => "x"));
  assert.equal(zero.children[0].temperature, 0);

  const plain = Tree(name("plain"), Prompt(() => "x"));
  assert.ok(!("temperature" in plain.children[0]), "no key when unset — def hashes stay stable");

  assert.doesNotThrow(() => temperature(0));
  assert.doesNotThrow(() => temperature(2));
  assert.throws(() => temperature(-0.1), /finite number >= 0/);
  assert.throws(() => temperature(NaN), /finite number >= 0/);
  assert.throws(() => temperature(Infinity), /finite number >= 0/);
  assert.throws(() => temperature("0.7"), /finite number >= 0/);
  assert.throws(() => temperature(), /finite number >= 0/);

  assert.throws(
    () => Tree(name("dup"), Prompt(temperature(0.1), temperature(0.2), () => "x")),
    /duplicate temperature/,
  );
});

test("OpenAI-compatible callLlm sends a per-call temperature", async () => {
  const { s, port, get } = await capture(openaiReply);
  try {
    await callLlm(
      { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "k", model: "m" },
      [{ role: "user", content: "hi" }],
      { temperature: 0.7 },
    );
    assert.equal(get().body.temperature, 0.7);
  } finally {
    s.close();
  }
});

test("Ollama callLlm sends temperature as options.temperature and keeps other options", async () => {
  const { s, port, get } = await capture(ollamaReply);
  try {
    await callLlm(
      {
        baseURL: `http://127.0.0.1:${port}`,
        apiKey: "k",
        model: "m",
        protocol: "ollama",
        thinking: { options: { num_ctx: 8192, temperature: 0.9 } },
      },
      [{ role: "user", content: "hi" }],
      { temperature: 0.3 },
    );
    assert.deepEqual(get().body.options, { num_ctx: 8192, temperature: 0.3 });
  } finally {
    s.close();
  }
});

test("a mock handler receives the per-call temperature", async () => {
  let seen;
  const handler = async (_messages, ctx) => {
    seen = ctx.temperature;
    return { content: "ok" };
  };
  await callLlm({ model: "mock", handler }, [{ role: "user", content: "hi" }], { temperature: 0.4 });
  assert.equal(seen, 0.4);
});

test("Prompt(temperature(n)) reaches the model", async () => {
  const handler = scripted(["done"]);
  const pattern = Tree(name("static"), Prompt(temperature(0.7), () => "go"));

  await grandma.knit(pattern, mockRuntime(handler));

  assert.equal(handler.calls.length, 1);
  assert.equal(handler.calls[0].temperature, 0.7);
});

test("Prompt(temperature(0)) sends zero rather than omitting the option", async () => {
  const handler = scripted(["done"]);
  const pattern = Tree(name("zero"), Prompt(temperature(0), () => "go"));

  await grandma.knit(pattern, mockRuntime(handler));

  assert.equal(handler.calls[0].temperature, 0);
});

test("a temperature function is re-evaluated for every auto-loop round", async () => {
  const handler = scripted([
    { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "noop", arguments: "{}" } }] },
    "done",
  ]);
  let step = 0;
  const pattern = Tree(
    name("dynamic"),
    Tools("noop"),
    Prompt(temperature((m) => m.base + step++), "main", () => "go"),
    Memory("temp_reads", (m) => m.raw.branch.main.reads),
  );

  const { memory } = await grandma.knit(pattern, mockRuntime(handler, {
    tools: { noop: tool(async () => "ok") },
    memory: { base: 0.5 },
  }));

  assert.equal(handler.calls.length, 2, "one tool round + one answer round");
  assert.deepEqual(handler.calls.map((c) => c.temperature), [0.5, 1.5]);
  assert.ok(memory.temp_reads.some((r) => r.name === "base"), "temperature reads join provenance");
});

test("an invalid dynamic temperature fails loudly", async () => {
  const pattern = Tree(name("bad"), Prompt(temperature(() => -1), () => "go"));
  await assert.rejects(
    grandma.knit(pattern, mockRuntime(scripted(["x"]))),
    /temperature of '.*' must resolve to a finite number >= 0/,
  );
});
