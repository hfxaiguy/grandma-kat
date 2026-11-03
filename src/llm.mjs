// LLM call layer. A model entry is { baseURL, apiKey, model } for an
// OpenAI-compatible endpoint, { model, handler } for a mock/injected
// caller (used by tests), or { baseURL, apiKey, model, protocol: 'ollama' }
// for Ollama's native API (https://ollama.com/api/chat).
//
// The optional `thinking` field forwards a reasoning level to the endpoint:
// `{ reasoning_effort }` on the OpenAI-compatible path, `{ think, options }`
// on the native Ollama path.
//
// Optional call bounds: `timeout` (ms) is the whole-call deadline — headers
// and body — defaulting to 2 min (OpenAI-compatible) or 10 min (Ollama);
// `idleTimeout` (ms) is the max gap between body bytes, default 30s. A call
// that exceeds either fails with `llm_timeout` (see LlmTimeoutError) instead
// of hanging the turn.
//
// The `transform` hook on the model entry (optional) runs after all
// built-in handling (thinking-model extraction, text-to-tool-call
// recovery) and before the response is returned. See the inline
// comment below for details.

// ── Transient-failure retry ───────────────────────────────────────────
// Providers rate-limit (429) and occasionally return 5xx; a single failure
// used to abort a whole turn — or a hook that maintains context. Retry these
// with exponential backoff + jitter, honouring a Retry-After header or a
// provider-suggested delay.
//
// A hung provider is retried too, but at most once: the first attempt has
// already burned the call's full timeout, and four hung attempts would stall
// a turn for longer than any host's run watchdog tolerates. A stop (the
// caller aborting through a wrapped fetch) is never retried — its AbortError
// arrives while *our* controller is still un-aborted, which is how the two
// abort paths are told apart.
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const DEFAULT_MAX_ATTEMPTS = 4;
/** Timeouts get one retry regardless of `maxAttempts` (see above). */
const MAX_TIMEOUT_ATTEMPTS = 2;
/** Max gap between body bytes once the body starts; a stalled stream aborts
 *  in this window instead of waiting out the whole-call timeout. */
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const MAX_BACKOFF_MS = 30_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A call that hit its deadline or stalled mid-body. Carries the
 *  `llm_timeout` code so hosts can tell it from a user stop (an AbortError)
 *  and offer a retry. */
export class LlmTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LlmTimeoutError';
    this.code = 'llm_timeout';
  }
}

/** A body that parsed as neither JSON nor a complete payload — usually a
 *  connection cut mid-response. Retried like a transport failure. */
class LlmBodyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LlmBodyError';
    this.code = 'llm_bad_body';
  }
}

/** Read a response body as text, aborting `controller` when the body has
 *  started but no chunk arrives for `idleMs`. A non-streaming endpoint that
 *  flushes headers early and then computes is bounded by the whole-call timer;
 *  once bytes are flowing, real silence fails fast instead of burning the full
 *  budget. */
async function readBodyText(res, { controller, idleMs, timeoutMs, kind, baseURL }) {
  if (!res.body || typeof res.body.getReader !== 'function') {
    return res.text();
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let idle = false;
  let idleTimer;
  const idleBudget = Math.min(idleMs, timeoutMs);
  const arm = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idle = true;
      controller.abort();
    }, idleBudget);
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        text += decoder.decode();
        return text;
      }
      text += decoder.decode(value, { stream: true });
      arm();
    }
  } catch (err) {
    if (idle) {
      throw new LlmTimeoutError(
        `${kind} stalled: no response bytes for ${(idleBudget / 1000).toFixed(1)}s (${baseURL})`,
      );
    }
    throw err;
  } finally {
    clearTimeout(idleTimer);
    try { reader.releaseLock(); } catch { /* already released */ }
  }
}

/** A server-suggested delay in ms: the Retry-After header, or a JSON body's
 *  retry_strategy.suggested_initial_delay_s (Neuralwatt-style). */
function suggestedDelayMs(res, bodyText) {
  const ra = res && res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : null;
  if (ra) {
    const s = Number(ra);
    if (Number.isFinite(s) && s >= 0) return s * 1000;
    const at = Date.parse(ra);
    if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  }
  try {
    const j = JSON.parse(bodyText);
    const d = j?.retry_strategy?.suggested_initial_delay_s ?? j?.error?.retry_strategy?.suggested_initial_delay_s;
    if (typeof d === 'number' && d >= 0) return d * 1000;
  } catch { /* not JSON */ }
  return null;
}

function backoffMs(attempt, hinted) {
  const base = 500 * 2 ** (attempt - 1); // 0.5s, 1s, 2s, …
  const ms = (hinted ?? base) + base * 0.25 * Math.random();
  return Math.min(ms, MAX_BACKOFF_MS);
}

/**
 * POST a JSON body and return the parsed response, retrying transient
 * failures. The timeout covers *the whole call* — connect, headers and body —
 * so a provider that accepts the connection then stops sending cannot leave
 * the caller awaiting a response that never arrives. `baseURL` is only for
 * the error messages; the fetch uses `url`. `maxAttempts` may be overridden
 * per model entry (`model.retries`).
 */
async function postJsonWithRetry(url, {
  headers, body, timeoutMs, idleTimeoutMs, baseURL, kind, maxAttempts,
}) {
  const attempts = Math.max(1, Number(maxAttempts) || DEFAULT_MAX_ATTEMPTS);
  const idleMs = Number.isFinite(idleTimeoutMs) && idleTimeoutMs > 0
    ? idleTimeoutMs
    : DEFAULT_IDLE_TIMEOUT_MS;
  let lastErr;
  let timeouts = 0;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      controller.abort();
    }, timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        // Bound reading the error body too — an error page that stalls is the
        // same hang as a success page that stalls.
        const text = await readBodyText(res, { controller, idleMs, timeoutMs, kind, baseURL });
        const err = new Error(`${kind} failed (${res.status}): ${text}`);
        err.status = res.status;
        if (!RETRYABLE_STATUS.has(res.status) || attempt >= attempts) throw err;
        lastErr = err;
        await sleep(backoffMs(attempt, suggestedDelayMs(res, text)));
        continue;
      }

      const text = await readBodyText(res, { controller, idleMs, timeoutMs, kind, baseURL });
      try {
        return JSON.parse(text);
      } catch {
        throw new LlmBodyError(`${kind} returned a truncated body (${baseURL})`);
      }
    } catch (err) {
      const aborted = expired || controller.signal.aborted;
      const callerStop = !aborted && (err?.name === 'AbortError' || err?.name === 'AgentStoppedError');
      // A stop from the caller's signal (a wrapped fetch / merged AbortSignal)
      // leaves our controller un-aborted; rethrow it untouched so the engine
      // unwinds as a stop instead of retrying.
      if (callerStop) throw err;
      // Anything that is neither a deadline/stall nor a transport failure is
      // a programming/provider error: surface it rather than re-running it.
      const transport = err instanceof LlmBodyError || err instanceof TypeError || err?.name === 'TimeoutError';
      if (!aborted && !transport) throw err;

      const timeoutErr = err instanceof LlmTimeoutError
        ? err
        : new LlmTimeoutError(`${kind} timed out after ${timeoutMs / 1000}s (${baseURL})`);
      if (aborted) {
        timeouts += 1;
        lastErr = timeoutErr;
        if (timeouts >= MAX_TIMEOUT_ATTEMPTS) throw timeoutErr;
      } else {
        lastErr = err;
      }
      if (attempt >= attempts) throw lastErr;
      await sleep(backoffMs(attempt, null));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

export async function callLlm(model, messages, { tools } = {}) {
  if (typeof model.handler === 'function') {
    return model.handler(messages, { tools, model: model.model });
  }

  let content, reasoning, tool_calls, raw;

  if (model.protocol === 'ollama') {
    // ── Native Ollama protocol ──────────────────────────────────────────
    // Uses /api/chat instead of /chat/completions. The response shape is
    // { message: { role, content, tool_calls? }, done, ... } instead of
    // OpenAI's { choices: [{ message: { ... } }] }. Tool args come back
    // as objects (not JSON strings) and tool call IDs are absent — we
    // synthesise both.
    const r = await callOllama(model, messages, { tools });
    content = r.content;
    reasoning = r.reasoning;
    tool_calls = r.tool_calls;
    raw = r.raw;
  } else {
    // ── OpenAI-compatible protocol (default) ────────────────────────────
    const baseURL = model.baseURL.replace(/\/$/, '');
    const body = { model: model.model, messages, temperature: 0 };
    if (tools?.length) body.tools = tools;
    // Reasoning level for OpenAI-compatible endpoints (e.g. "low"/"medium"/
    // "high"), set per model entry in models.json as `thinking.reasoning_effort`.
    if (model.thinking?.reasoning_effort !== undefined) {
      body.reasoning_effort = model.thinking.reasoning_effort;
    }

    const headers = { 'Content-Type': 'application/json' };
    if (model.apiKey && model.apiKey !== 'no-key') {
      headers.Authorization = `Bearer ${model.apiKey}`;
    }

    const data = await postJsonWithRetry(`${baseURL}/chat/completions`, {
      headers,
      body,
      // Per-model timeout (ms); default 2 min. Covers the whole call, so the
      // old header-only deadline cannot leave the body read unbounded.
      timeoutMs: typeof model.timeout === 'number' && model.timeout > 0 ? model.timeout : 120_000,
      idleTimeoutMs: model.idleTimeout,
      baseURL,
      kind: 'LLM request',
      maxAttempts: model.retries,
    });

    const message = data.choices?.[0]?.message ?? {};
    content = message.content ?? '';
    reasoning = message.reasoning ?? message.reasoning_content ?? '';
    tool_calls = message.tool_calls;
    raw = data;
  }

  // ── Thinking-model handling (common) ─────────────────────────────────
  // Reasoning may be a separate field with leaked </think> in content, or
  // inline in content delimited by a closing tag. This handles Qwen/
  // DeepSeek-style models. Gemma 4's <|channel> tags are handled by the
  // per-model `transform` hook below.
  if (reasoning) {
    const thinkClose = content.indexOf('</think>');
    if (thinkClose !== -1) {
      content = content.slice(thinkClose + 8).trim();
    }
  } else {
    const match = content.match(/^(.*)<\/(?:output|think)>\s*(.*)$/s);
    if (match) {
      reasoning = match[1].trim();
      content = match[2].trim();
    }
  }

  // ── DSML envelope recovery (common) ─────────────────────────────────
  // Some DeepSeek endpoints return their tool-call markup as plain content
  // instead of lifting it into message.tool_calls. Parse the envelope when a
  // tool set is offered; with no tools, at least strip it so the markup cannot
  // leak into the caller's text (the failed compaction case).
  if (!tool_calls?.length && content) {
    const dsml = parseDsmlToolCalls(content, tools);
    if (dsml) {
      tool_calls = dsml.tool_calls.length ? dsml.tool_calls : tool_calls;
      content = dsml.content;
    }
  }

  // ── Text-to-tool-call recovery (common) ─────────────────────────────
  // Small models (1-3B) often output tool calls as plain text like
  // "navigate https://example.com" instead of using the function calling
  // format.
  if (!tool_calls?.length && tools?.length && content) {
    tool_calls = parseTextToolCalls(content, tools);
    if (tool_calls) content = '';
  }

  // ── Per-model response transform ────────────────────────────────────
  // Runs after all built-in handling so the transform sees the final
  // content, reasoning, and tool_calls. Typical use: strip model-specific
  // tag formats the library doesn't handle natively (e.g. Gemma 4's
  // <|channel>thought…<channel|>), or populate reasoning from inline
  // thinking blocks.
  if (typeof model.transform === 'function') {
    const r = await model.transform(
      { content, reasoning, tool_calls, raw },
      { messages, tools, model: model.model },
    );
    if (r) {
      content = r.content ?? content;
      reasoning = r.reasoning ?? reasoning;
      tool_calls = r.tool_calls ?? tool_calls;
    }
  }

  return { content, reasoning, tool_calls, raw, usage: extractUsage(raw) };
}

/**
 * Normalize the provider's token accounting to `{ input, output }`.
 *
 * OpenAI-compatible endpoints report `usage.prompt_tokens` /
 * `usage.completion_tokens` (some gateways spell them `input_tokens` /
 * `output_tokens`); Ollama's native API puts `prompt_eval_count` /
 * `eval_count` at the top level. Returns undefined when the response reports
 * no usage at all (a mock handler, or an endpoint that omits it) so callers
 * can tell "not reported" from "zero tokens".
 */
export function extractUsage(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const u = raw.usage && typeof raw.usage === 'object' ? raw.usage : raw;
  const input = tokenCount(u.prompt_tokens ?? u.input_tokens ?? u.prompt_eval_count);
  const output = tokenCount(u.completion_tokens ?? u.output_tokens ?? u.eval_count);
  if (input === undefined && output === undefined) return undefined;
  return { input: input ?? 0, output: output ?? 0 };
}

function tokenCount(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

// ── Native Ollama protocol ────────────────────────────────────────────
// Calls Ollama's /api/chat endpoint directly. This skips the local
// Ollama server and talks to https://ollama.com (or any Ollama host)
// using the native protocol.
//
// Differences from OpenAI compat:
//   - Endpoint: /api/chat (not /chat/completions)
//   - Request:  { model, messages, tools, stream: false } (no temperature)
//   - Response: { message: { role, content, tool_calls? } } (not choices[])
//   - Tool args: objects (not JSON strings) — we stringify them
//   - Tool IDs:  absent — we generate them
async function callOllama(model, messages, { tools } = {}) {
  const baseURL = model.baseURL.replace(/\/$/, '');
  // Ollama expects tool_calls.arguments as objects, not JSON strings.
  // Convert any string arguments back to objects before sending.
  const ollamaMessages = messages.map(m => {
    if (!m.tool_calls) return m;
    return {
      ...m,
      tool_calls: m.tool_calls.map(tc => ({
        ...tc,
        function: {
          ...tc.function,
          arguments: typeof tc.function?.arguments === 'string'
            ? (() => { try { return JSON.parse(tc.function.arguments); } catch { return tc.function.arguments; } })()
            : tc.function?.arguments ?? {},
        },
      })),
    };
  });
  const body = { model: model.model, messages: ollamaMessages, stream: false };
  if (tools?.length) body.tools = tools;
  // Ollama's native `think` flag plus any extra model `options`, set per model
  // entry in models.json as `thinking.think` / `thinking.options`.
  if (model.thinking?.think !== undefined) body.think = model.thinking.think;
  if (model.thinking?.options) body.options = { ...(body.options || {}), ...model.thinking.options };

  const headers = { 'Content-Type': 'application/json' };
  if (model.apiKey && model.apiKey !== 'no-key') {
    headers.Authorization = `Bearer ${model.apiKey}`;
  }

  // Per-model timeout (ms); default 10 min. Ollama can be slow on large
  // prompts or deep-reasoning queries, so the default is generous. The
  // deadline covers the body read as well as the headers.
  const timeoutMs = typeof model.timeout === 'number' && model.timeout > 0
    ? model.timeout
    : 600_000;
  const data = await postJsonWithRetry(`${baseURL}/api/chat`, {
    headers,
    body,
    timeoutMs,
    idleTimeoutMs: model.idleTimeout,
    baseURL,
    kind: 'Ollama request',
    maxAttempts: model.retries,
  });

  const msg = data.message ?? {};

  // Map Ollama tool_calls to OpenAI shape: stringify arguments, add IDs.
  const tool_calls = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0
    ? msg.tool_calls.map((tc, i) => ({
        id: `ollama_${i}`,
        type: 'function',
        function: {
          name: tc.function?.name,
          arguments: typeof tc.function?.arguments === 'string'
            ? tc.function.arguments
            : JSON.stringify(tc.function?.arguments ?? {}),
        },
      }))
    : undefined;

  return {
    content: msg.content ?? '',
    reasoning: null,
    tool_calls,
    raw: data,
  };
}

// Parse DeepSeek's DSML tool-call envelope out of plain content. Some
// endpoints return the calls as text instead of lifting them into
// message.tool_calls; the envelope is XML-ish, with `|` as U+FF5C (the
// fullwidth bar DeepSeek wraps special tokens in).
//
// Returns { tool_calls, content } when at least one offered tool matched,
// else null. String parameters keep their raw text; untyped ones are parsed
// as JSON when possible.
const DSML_BAR = "\uFF5C";
const DSML_OPEN = `<${DSML_BAR}DSML${DSML_BAR}`;
const DSML_CLOSE = `</${DSML_BAR}DSML${DSML_BAR}`;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function parseDsmlToolCalls(text, tools) {
  if (typeof text !== "string" || !text.includes(`${DSML_OPEN} invoke`)) return null;
  const offered = new Set((tools ?? []).map((t) => t.function?.name).filter(Boolean));

  const invokeRe = new RegExp(
    `${escapeRe(DSML_OPEN)}\\s+invoke\\s+name=["']([^"']+)["']\\s*>([\\s\\S]*?)${escapeRe(DSML_CLOSE)}\\s+invoke>`,
    "g",
  );
  const parameterRe = new RegExp(
    `${escapeRe(DSML_OPEN)}\\s+parameter\\s+name=["']([^"']+)["'](?:\\s+string=["'](true|false)["'])?\\s*>([\\s\\S]*?)${escapeRe(DSML_CLOSE)}\\s+parameter>`,
    "g",
  );

  const tool_calls = [];
  let invoke;
  while ((invoke = invokeRe.exec(text))) {
    const name = invoke[1];
    if (!offered.has(name)) continue;
    const args = {};
    let param;
    parameterRe.lastIndex = 0;
    while ((param = parameterRe.exec(invoke[2]))) {
      const key = param[1];
      const raw = param[3].trim();
      if (param[2] === "true") {
        args[key] = raw;
        continue;
      }
      try {
        args[key] = JSON.parse(raw);
      } catch {
        args[key] = raw; // untyped but not JSON — keep the text
      }
    }
    tool_calls.push({
      id: `dsml_${tool_calls.length}`,
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    });
  }
  // Strip the envelope from the content. Remove the whole calls block when
  // there is one; otherwise remove the invoke blocks themselves. A block with
  // no offered-tool match still strips — the markup must not leak as text.
  const callsRe = new RegExp(
    `${escapeRe(DSML_OPEN)}\\s+calls>[\\s\\S]*?${escapeRe(DSML_CLOSE)}\\s+calls>`,
    "g",
  );
  const hasBlock = callsRe.test(text);
  if (tool_calls.length === 0 && !hasBlock) return null;
  const content = hasBlock ? text.replace(callsRe, "") : text.replace(invokeRe, "");
  return { tool_calls, content: content.trim() };
}

// Try to parse tool invocations from plain text. Only matches when the
// text is short and starts with a tool name — avoids false positives on
// long responses that happen to mention tool names in running text.
// Supports:
//   navigate https://example.com
//   click .contact-link
//   {"name":"navigate","arguments":{"url":"..."}}
function parseTextToolCalls(text, tools) {
  const toolNames = new Set(tools.map(t => t.function?.name).filter(Boolean));
  const trimmed = text.trim();

  // Only attempt parsing if the response is short (a real text-based tool
  // call is typically under 150 chars). Long responses are normal text.
  if (trimmed.length > 200) return null;

  // Try JSON format first: {"name":"tool","arguments":{...}}
  const jsonMatch = trimmed.match(/^\{[\s\S]*"name"\s*:\s*"([^"]+)"[\s\S]*\}$/);
  if (jsonMatch && toolNames.has(jsonMatch[1])) {
    try {
      const obj = JSON.parse(trimmed);
      if (obj.name && toolNames.has(obj.name)) {
        return [{
          id: 'text_0',
          type: 'function',
          function: {
            name: obj.name,
            arguments: typeof obj.arguments === 'string' ? obj.arguments : JSON.stringify(obj.arguments ?? {}),
          },
        }];
      }
    } catch { /* not valid JSON, continue */ }
  }

  // Tool name must appear at the start of the text (after optional
  // whitespace/newlines). This prevents matching "click" inside
  // "The clickable elements..." or other running text.
  for (const name of toolNames) {
    const re = new RegExp(`^\\s*(?:I'll\\s+)?(?:call\\s+)?${name}\\s+(?:with\\s+)?(?:url[:\\s]+)?([\\S]+)`, 'i');
    const m = trimmed.match(re);
    if (m) {
      const val = m[1].replace(/^["']|["']$/g, '');
      const paramKey = name === 'navigate' ? 'url' : name === 'click' ? 'selector' : 'input';
      return [{
        id: 'text_0',
        type: 'function',
        function: {
          name,
          arguments: JSON.stringify({ [paramKey]: val }),
        },
      }];
    }
  }

  return null;
}

export function normalizeMessages(value) {
  if (typeof value === 'string') return [{ role: 'user', content: value }];
  if (Array.isArray(value)) {
    for (const m of value) {
      if (!m || typeof m.role !== 'string') {
        throw new TypeError('message array entries must be objects with a role');
      }
    }
    return [...value];
  }
  throw new TypeError('prompt value must be a string or a message array');
}
