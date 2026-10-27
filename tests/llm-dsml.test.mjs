// DSML envelope parsing: a DeepSeek endpoint may return tool calls as text
// content instead of message.tool_calls. The envelope uses U+FF5C as its bar.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { callLlm, parseDsmlToolCalls } from "../src/llm.mjs";

const P = "\uFF5C";
const O = `<${P}DSML${P}`;
const C = `</${P}DSML${P}`;

const param = (name, value, asString = true) =>
  `${O} parameter name="${name}"${asString ? ' string="true"' : ""}>${value}${C} parameter>`;

const invoke = (name, params) => [
  `${O} invoke name="${name}">`,
  ...params.map(([key, value, asString]) => param(key, value, asString)),
  `${C} invoke>`,
].join("\n");

const envelope = (invokes) => [`${O} calls>`, ...invokes, `${C} calls>`].join("\n");

const TOOLS = [
  { type: "function", function: { name: "sql_query", parameters: {} } },
  { type: "function", function: { name: "read_json", parameters: {} } },
];

test("parses string parameters and strips the envelope", () => {
  const text = envelope([invoke("sql_query", [["path", "contacts.db"], ["query", "SELECT 1"]])]);
  const out = parseDsmlToolCalls(text, TOOLS);
  assert.ok(out);
  assert.equal(out.content, "");
  assert.equal(out.tool_calls.length, 1);
  assert.equal(out.tool_calls[0].function.name, "sql_query");
  assert.deepEqual(JSON.parse(out.tool_calls[0].function.arguments), {
    path: "contacts.db",
    query: "SELECT 1",
  });
});

test("parses multiple invokes and untyped JSON values", () => {
  const text = envelope([
    invoke("read_json", [["text", '{"a":1}', false]]),
    invoke("sql_query", [["path", "x.db"]]),
  ]);
  const out = parseDsmlToolCalls(text, TOOLS);
  assert.equal(out.tool_calls.length, 2);
  assert.deepEqual(JSON.parse(out.tool_calls[0].function.arguments), { text: { a: 1 } });
});

test("ignores unknown tools and keeps prose around the envelope", () => {
  const text = `Before.\n${envelope([
    invoke("not_a_tool", [["x", "y"]]),
    invoke("sql_query", [["query", "SELECT 1"]]),
  ])}\nAfter.`;
  const out = parseDsmlToolCalls(text, TOOLS);
  assert.equal(out.tool_calls.length, 1);
  assert.match(out.content, /Before\./);
  assert.match(out.content, /After\./);
});

test("returns null when there is no envelope", () => {
  assert.equal(parseDsmlToolCalls("plain prose", TOOLS), null);
});

test("an envelope with only unknown tools is stripped, with no calls", () => {
  const out = parseDsmlToolCalls(envelope([invoke("nope", [])]), TOOLS);
  assert.equal(out.tool_calls.length, 0);
  assert.equal(out.content, "");
});

test("with no tools offered, the envelope is stripped and no calls are made", () => {
  const out = parseDsmlToolCalls(envelope([invoke("sql_query", [["query", "SELECT 1"]])]), []);
  assert.equal(out.tool_calls.length, 0);
  assert.equal(out.content, "");
});

test("callLlm lifts the envelope into tool_calls", async () => {
  const content = envelope([invoke("sql_query", [["path", "contacts.db"], ["query", "SELECT 1"]])]);
  const reply = { choices: [{ message: { role: "assistant", content } }] };
  const server = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(reply));
      });
    });
    s.listen(0, "127.0.0.1", () => resolve({ s, port: s.address().port }));
  });
  try {
    const out = await callLlm(
      { baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: "k", model: "m" },
      [{ role: "user", content: "hi" }],
      { tools: TOOLS },
    );
    assert.equal(out.content, "");
    assert.equal(out.tool_calls.length, 1);
    assert.equal(out.tool_calls[0].function.name, "sql_query");
  } finally {
    server.s.close();
  }
});
