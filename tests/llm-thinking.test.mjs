// `thinking` on a model entry forwards protocol-specific reasoning controls:
// `reasoning_effort` on the OpenAI-compatible path, `think` + `options` on the
// native Ollama path. Nothing is sent when the field is absent.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { callLlm } from "../src/llm.mjs";

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

test("OpenAI path forwards thinking.reasoning_effort", async () => {
  const { s, port, get } = await capture(openaiReply);
  try {
    await callLlm(
      { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "k", model: "m", thinking: { reasoning_effort: "high" } },
      [{ role: "user", content: "hi" }],
    );
    assert.equal(get().url, "/v1/chat/completions");
    assert.equal(get().body.reasoning_effort, "high");
    assert.equal(get().body.temperature, 0);
  } finally {
    s.close();
  }
});

test("OpenAI path omits reasoning_effort when thinking is absent", async () => {
  const { s, port, get } = await capture(openaiReply);
  try {
    await callLlm(
      { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "k", model: "m" },
      [{ role: "user", content: "hi" }],
    );
    assert.equal("reasoning_effort" in get().body, false);
  } finally {
    s.close();
  }
});

test("Ollama path forwards thinking.think and merges thinking.options", async () => {
  const { s, port, get } = await capture(ollamaReply);
  try {
    await callLlm(
      {
        baseURL: `http://127.0.0.1:${port}`,
        apiKey: "k",
        model: "m",
        protocol: "ollama",
        thinking: { think: true, options: { num_ctx: 8192 } },
      },
      [{ role: "user", content: "hi" }],
    );
    assert.equal(get().url, "/api/chat");
    assert.equal(get().body.think, true);
    assert.deepEqual(get().body.options, { num_ctx: 8192 });
  } finally {
    s.close();
  }
});

test("Ollama path omits think/options when thinking is absent", async () => {
  const { s, port, get } = await capture(ollamaReply);
  try {
    await callLlm(
      { baseURL: `http://127.0.0.1:${port}`, apiKey: "k", model: "m", protocol: "ollama" },
      [{ role: "user", content: "hi" }],
    );
    assert.equal("think" in get().body, false);
    assert.equal("options" in get().body, false);
  } finally {
    s.close();
  }
});
