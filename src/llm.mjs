// LLM call layer. A model entry is { baseURL, apiKey, model } for an
// OpenAI-compatible endpoint, { model, handler } for a mock/injected
// caller (used by tests), or { baseURL, apiKey, model, protocol: 'ollama' }
// for Ollama's native API (https://ollama.com/api/chat).
//
// The `transform` hook on the model entry (optional) runs after all
// built-in handling (thinking-model extraction, text-to-tool-call
// recovery) and before the response is returned. See the inline
// comment below for details.

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

    const headers = { 'Content-Type': 'application/json' };
    if (model.apiKey && model.apiKey !== 'no-key') {
      headers.Authorization = `Bearer ${model.apiKey}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);

    let res;
    try {
      res = await fetch(`${baseURL}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeout);
      if (err.name === 'AbortError') {
        throw new Error(`LLM request timed out after 120s (${baseURL})`);
      }
      throw err;
    }
    clearTimeout(timeout);

    if (!res.ok) {
      throw new Error(`LLM request failed (${res.status}): ${await res.text()}`);
    }

    const data = await res.json();
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

  return { content, reasoning, tool_calls, raw };
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
  const body = { model: model.model, messages, stream: false };
  if (tools?.length) body.tools = tools;

  const headers = { 'Content-Type': 'application/json' };
  if (model.apiKey && model.apiKey !== 'no-key') {
    headers.Authorization = `Bearer ${model.apiKey}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);

  let res;
  try {
    res = await fetch(`${baseURL}/api/chat`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      throw new Error(`Ollama request timed out after 120s (${baseURL})`);
    }
    throw err;
  }
  clearTimeout(timeout);

  if (!res.ok) {
    throw new Error(`Ollama request failed (${res.status}): ${await res.text()}`);
  }

  const data = await res.json();
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
