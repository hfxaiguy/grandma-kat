import { loadConfig } from './config.mjs';

export async function callLlm(messages, options = {}) {
  const config = loadConfig();
  const baseURL = config.provider.baseURL.replace(/\/$/, '');
  const url = `${baseURL}/chat/completions`;

  const body = {
    model: options.model || config.model,
    messages,
    temperature: options.temperature ?? 0,
  };
  if (options.max_tokens) body.max_tokens = options.max_tokens;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.provider.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LLM request failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  const choice = data.choices?.[0];
  const message = choice?.message ?? {};
  let content = message.content ?? '';
  let reasoning = message.reasoning ?? message.reasoning_content ?? '';

  // Qwen thinking models via HF router: thinking is inline in `content`,
  // delimited by a closing tag like `</output>`. The opening tag is stripped
  // by the router. Split into reasoning + final answer.
  if (!reasoning) {
    const match = content.match(/^(.*?)<\/(?:output|think)>\s*(.*)$/s);
    if (match) {
      reasoning = match[1].trim();
      content = match[2].trim();
    }
  }

  return { content, reasoning, raw: data };
}