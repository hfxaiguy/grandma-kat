// LLM call layer. A model entry is { baseURL, apiKey, model } for an
// OpenAI-compatible endpoint, or { model, handler } for a mock/injected
// caller (used by tests).

export async function callLlm(model, messages, { tools } = {}) {
  if (typeof model.handler === 'function') {
    return model.handler(messages, { tools, model: model.model });
  }

  const baseURL = model.baseURL.replace(/\/$/, '');
  const body = { model: model.model, messages, temperature: 0 };
  if (tools?.length) body.tools = tools;

  const headers = { 'Content-Type': 'application/json' };
  if (model.apiKey && model.apiKey !== 'no-key') {
    headers.Authorization = `Bearer ${model.apiKey}`;
  }

  const res = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`LLM request failed (${res.status}): ${await res.text()}`);
  }

  const data = await res.json();
  const message = data.choices?.[0]?.message ?? {};
  let content = message.content ?? '';
  let reasoning = message.reasoning ?? message.reasoning_content ?? '';

  // Thinking-model handling (same as prototyping/lib/llm.mjs): reasoning
  // may be a separate field with leaked </think> in content, or inline in
  // content delimited by a closing tag.
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

  return { content, reasoning, tool_calls: message.tool_calls, raw: data };
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
