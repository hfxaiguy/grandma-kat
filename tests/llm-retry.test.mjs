// Retry/backoff for transient LLM failures: a 429 (or 5xx) is retried, a 4xx
// is not, and attempts are capped. Timeouts are not retried.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { callLlm } from "../src/llm.mjs";

function start(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.listen(0, "127.0.0.1", () => resolve({ s, port: s.address().port }));
  });
}

const okBody = JSON.stringify({ choices: [{ message: { role: "assistant", content: "hi" } }] });
const entry = (port, extra = {}) => ({ baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "k", model: "m", ...extra });

test("retries a 429 (Retry-After: 0) then succeeds", async () => {
  let n = 0;
  const { s, port } = await start((req, res) => {
    n++;
    if (n === 1) {
      res.writeHead(429, { "content-type": "application/json", "retry-after": "0" });
      res.end(JSON.stringify({ error: { type: "rate_limit_error", retry_strategy: { suggested_initial_delay_s: 0 } } }));
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(okBody);
    }
  });
  try {
    const r = await callLlm(entry(port), [{ role: "user", content: "hi" }]);
    assert.equal(r.content, "hi");
    assert.equal(n, 2, "one retry after the 429");
  } finally {
    s.close();
  }
});

test("retries 5xx up to maxAttempts, then throws", async () => {
  let n = 0;
  const { s, port } = await start((req, res) => {
    n++;
    res.writeHead(503, { "retry-after": "0" });
    res.end("down");
  });
  try {
    await assert.rejects(
      callLlm(entry(port, { retries: 3 }), [{ role: "user", content: "hi" }]),
      /LLM request failed \(503\)/,
    );
    assert.equal(n, 3, "three attempts, then give up");
  } finally {
    s.close();
  }
});

test("does not retry a 400", async () => {
  let n = 0;
  const { s, port } = await start((req, res) => {
    n++;
    res.writeHead(400);
    res.end("bad request");
  });
  try {
    await assert.rejects(
      callLlm(entry(port), [{ role: "user", content: "hi" }]),
      /LLM request failed \(400\)/,
    );
    assert.equal(n, 1, "a client error is not retried");
  } finally {
    s.close();
  }
});
