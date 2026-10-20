// Test helpers: scripted mock models and runtimes (no live LLM needed).

// A mock model handler that plays back queued responses. Each response is
// { content?, tool_calls? } or a function (messages, callIndex) => response.
// handler.calls records every invocation for assertions.
export function scripted(responses) {
  let i = 0;
  const calls = [];
  const handler = async (messages, { tools } = {}) => {
    calls.push({ messages: messages.map((m) => ({ ...m })), tools });
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    if (typeof r === 'function') return r(messages, calls.length);
    if (typeof r === 'string') return { content: r };
    return r;
  };
  handler.calls = calls;
  return handler;
}

// A runtime with a single default mock model. Extra options are passed through
// on the runtime verbatim (e.g. maxToolResultChars, sessionId, context).
export function mockRuntime(handler, { tools = {}, memory, models, logger = false, ...rest } = {}) {
  return {
    models: models ?? { default: { model: 'mock', handler } },
    tools,
    memory,
    logger,
    ...rest,
  };
}

// A tool registry entry.
export function tool(execute, { description = 'test tool', parameters = {} } = {}) {
  return { description, parameters, execute };
}
