// Token usage: providers report it differently — OpenAI-compatible endpoints
// in `usage.prompt_tokens`/`completion_tokens` (some gateways: `input_tokens`/
// `output_tokens`), Ollama's native API at the top level as
// `prompt_eval_count`/`eval_count`. `callLlm` normalizes it to
// `{ input, output }` and a knit prompt logs it on the `llm_call` event, which
// is what hosts (BOB) sum per turn. An endpoint (or mock) that reports nothing
// must yield no `usage` at all — "not reported" is not "zero".
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import grandma, { Tree, name, Model, Prompt } from "../src/index.mjs";
import { callLlm, extractUsage } from "../src/llm.mjs";

function start(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.listen(0, "127.0.0.1", () => resolve({ s, port: s.address().port }));
  });
}

const reply = (body) => (req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const entry = (port, extra = {}) => ({ baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "k", model: "m", ...extra });

const openAiBody = (usage) => ({
  choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
  ...(usage ? { usage } : {}),
});

test("OpenAI-compatible usage maps to { input, output }", async () => {
  const { s, port } = await start(reply(openAiBody({ prompt_tokens: 120, completion_tokens: 45, total_tokens: 165 })));
  try {
    const r = await callLlm(entry(port), [{ role: "user", content: "hi" }]);
    assert.deepEqual(r.usage, { input: 120, output: 45 });
  } finally {
    s.close();
  }
});

test("input_tokens/output_tokens aliases are accepted", async () => {
  const { s, port } = await start(reply(openAiBody({ input_tokens: 7, output_tokens: 3 })));
  try {
    const r = await callLlm(entry(port), [{ role: "user", content: "hi" }]);
    assert.deepEqual(r.usage, { input: 7, output: 3 });
  } finally {
    s.close();
  }
});

test("Ollama's eval counts map to { input, output }", async () => {
  const { s, port } = await start(
    reply({ message: { role: "assistant", content: "hi" }, done: true, prompt_eval_count: 88, eval_count: 12 }),
  );
  try {
    const r = await callLlm(entry(port, { protocol: "ollama" }), [{ role: "user", content: "hi" }]);
    assert.deepEqual(r.usage, { input: 88, output: 12 });
  } finally {
    s.close();
  }
});

test("no reported usage yields undefined, not zeros", async () => {
  const { s, port } = await start(reply(openAiBody(null)));
  try {
    const r = await callLlm(entry(port), [{ role: "user", content: "hi" }]);
    assert.equal(r.usage, undefined);
  } finally {
    s.close();
  }
});

test("extractUsage tolerates missing/odd values", () => {
  assert.equal(extractUsage(undefined), undefined);
  assert.equal(extractUsage({}), undefined);
  assert.equal(extractUsage({ usage: {} }), undefined);
  assert.deepEqual(extractUsage({ usage: { prompt_tokens: 5 } }), { input: 5, output: 0 });
});

test("knit logs usage on the llm_call event", async () => {
  const { s, port } = await start(reply(openAiBody({ prompt_tokens: 42, completion_tokens: 11 })));
  const events = [];
  const logger = { log: (e) => events.push(e) };
  try {
    const pattern = Tree(name("agent"), Model("strong"), Prompt(() => "go"));
    const result = await grandma.knit(pattern, {
      models: { strong: entry(port) },
      tools: {},
      logger,
    });
    assert.equal(result.result, "hi");
    const call = events.find((e) => e.kind === "llm_call");
    assert.ok(call, "the round is logged");
    assert.deepEqual(call.content.usage, { input: 42, output: 11 });
  } finally {
    s.close();
  }
});
