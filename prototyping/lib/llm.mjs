import { loadConfig } from './config.mjs';

let cachedConfig = null;
let cachedProvider = null;

export function setProvider(name) {
  cachedProvider = name;
  cachedConfig = null;
}

export function getProvider() {
  return cachedProvider;
}

export async function callLlm(messages, options = {}) {
  console.log('\n--- Sending to LLM ---');
  for (const msg of messages) {
    const preview = msg.content.length > 200 ? msg.content.slice(0, 200) + '...' : msg.content;
    console.log(`[${msg.role}] ${preview}`);
  }
  console.log('--- End LLM Input ---\n');

  if (!cachedConfig || (options.provider && options.provider !== cachedProvider)) {
    const providerName = options.provider || cachedProvider;
    if (providerName) cachedProvider = providerName;
    cachedConfig = loadConfig(providerName);
  }
  const config = cachedConfig;

  const baseURL = config.provider.baseURL.replace(/\/$/, '');
  const url = `${baseURL}/chat/completions`;

  const body = {
    model: options.model || config.model,
    messages,
    temperature: options.temperature ?? 0,
  };
  if (options.max_tokens) body.max_tokens = options.max_tokens;
  if (options.tools) body.tools = options.tools;

  const headers = { 'Content-Type': 'application/json' };
  if (config.provider.apiKey && config.provider.apiKey !== 'no-key') {
    headers.Authorization = `Bearer ${config.provider.apiKey}`;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
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
  if (reasoning) {
    // llama.cpp puts reasoning in a separate field, but content may still
    // contain leaked </think> tags with thinking text. Extract only what's after </think>.
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

  return {
    content,
    reasoning,
    tool_calls: message.tool_calls,
    raw: data,
  };
}