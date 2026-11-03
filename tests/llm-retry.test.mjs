// Retry/backoff for transient LLM failures: a 429 (or 5xx) is retried, a 4xx
// is not, attempts are capped, and hung calls fail on their deadline or body
// idle window instead of hanging the turn. A hung call is retried at most once.
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

function stop(s) {
  s.closeAllConnections?.();
  s.close();
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

test("a request that never sends headers fails on its deadline, with one retry", async () => {
  let n = 0;
  const { s, port } = await start(() => {
    n++; // accept the request and never respond
  });
  try {
    await assert.rejects(
      callLlm(entry(port, { timeout: 100, retries: 9 }), [{ role: "user", content: "hi" }]),
      /LLM request timed out after 0\.1s/,
    );
    assert.equal(n, 2, "a hung call is retried once, not maxAttempts times");
  } finally {
    stop(s);
  }
});

test("a body that stalls mid-stream aborts on the idle window and is retried", async () => {
  let n = 0;
  const { s, port } = await start((req, res) => {
    n++;
    res.writeHead(200, { "content-type": "application/json" });
    if (n === 1) {
      res.write('{"choices":'); // start the body, then stall
      return;
    }
    res.end(okBody);
  });
  try {
    const r = await callLlm(entry(port, { idleTimeout: 80 }), [{ role: "user", content: "hi" }]);
    assert.equal(r.content, "hi");
    assert.equal(n, 2, "the stalled attempt is retried");
  } finally {
    stop(s);
  }
});

test("a truncated body is retried instead of surfacing as a parse error", async () => {
  let n = 0;
  const { s, port } = await start((req, res) => {
    n++;
    res.writeHead(200, { "content-type": "application/json" });
    if (n === 1) {
      res.end('{"choices": [{"message":'); // cut mid-payload
      return;
    }
    res.end(okBody);
  });
  try {
    const r = await callLlm(entry(port), [{ role: "user", content: "hi" }]);
    assert.equal(r.content, "hi");
    assert.equal(n, 2, "the truncated attempt is retried");
  } finally {
    stop(s);
  }
});

test("a body that trickles slower than the whole-call deadline fails", async () => {
  const { s, port } = await start((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    // Send one byte at a time, forever: the idle timer never fires, so only
    // the whole-call deadline can end this.
    const timer = setInterval(() => res.write(" "), 20);
    res.on("close", () => clearInterval(timer));
  });
  try {
    await assert.rejects(
      callLlm(entry(port, { timeout: 150, retries: 1 }), [{ role: "user", content: "hi" }]),
      /LLM request timed out after 0\.15s/,
    );
  } finally {
    stop(s);
  }
});
