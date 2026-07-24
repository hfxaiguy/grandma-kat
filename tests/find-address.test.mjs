// Tests for the find-address pattern. These mock the LLM and the browser-mcp
// tools, so the runner exercises the full tree (gates, tools, agentic loop,
// .until) without needing a real browser.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import grandma from '../src/index.mjs';
import { tool } from './helpers.mjs';
import { createFindAddressPattern } from '../prototyping/find-address/find-address.mjs';

// Tool registry that mimics browser-mcp over an in-memory page. The exec_js
// tool runs a small interpreter for the patterns used by find-address.mjs.
function makeBrowserTools(page) {
  const execJs = tool(async ({ code }) => {
    if (code.includes('document.body ? document.body.innerText')) {
      return { text: page.text, url: page.url, title: page.title };
    }
    if (code === 'JSON.stringify(Array.isArray(window.__tried) ? window.__tried : [])') {
      return page.tried;
    }
    if (code.startsWith('(() => {')) {
      // format_clickables: code embeds `const els = <JSON>;`
      const m = code.match(/const els = (.+?);\n/);
      if (m) {
        const els = JSON.parse(m[1]);
        if (!Array.isArray(els) || !els.length) return '';
        return els.map((el) => {
          const tag = String(el.tag || '?').toLowerCase();
          const text = String(el.text || '').replace(/\n/g, ' ').trim();
          let suffix = '';
          if (el.href) suffix += ` (${el.href})`;
          if (Array.isArray(el.listeners) && el.listeners.length) {
            suffix += ` [${el.listeners.map((l) => l.type).join(',')}]`;
          }
          return `<${tag}> "${text}"${suffix}`.trim();
        }).filter((l) => l.length > 4).join('\n');
      }
      // record_tried: code embeds `const tc = <JSON>;`
      const tm = code.match(/const tc = (.+?);\n/);
      if (tm) {
        const tc = JSON.parse(tm[1]);
        if (tc?.arguments) page.tried.push(tc.arguments);
        return page.tried;
      }
    }
    return null;
  });

  return {
    navigate: tool(async (args) => {
      page.url = args.url;
      return 'navigated';
    }),
    click: tool(async (args) => {
      page.clicked.push(args.selector);
      return 'clicked';
    }),
    exec_js: execJs,
    scan_clickables: tool(async () => page.clickables),
    wait_for_load: tool(async () => ({ loaded: true })),
  };
}

function freshPage() {
  return {
    url: 'about:blank',
    title: '',
    text: '',
    clickables: [],
    clicked: [],
    tried: [],
  };
}

// A scripted handler that takes a list of "scenes" and a `sceneForCall`
// function. Each scene returns the response for the Nth LLM call. This
// models the agentic loop: a single pick_action invocation can take 2
// calls (one for the tool call, one for the final text after seeing the
// tool result).
function scriptedScenes(callCount, sceneForCall) {
  let i = 0;
  return async (messages, { tools } = {}) => {
    const idx = i++;
    return sceneForCall(idx, messages);
  };
}

test('find-address: exits on first iteration when page has an address', async () => {
  const page = freshPage();
  page.text = 'Acme Corp\n123 Main St\nSpringfield, USA';
  const handler = scriptedScenes(1, (i) => {
    if (i === 0) return { content: '123 Main St, Springfield, USA' };
    throw new Error('unexpected call');
  });

  const { result, memory } = await grandma.knit(
    createFindAddressPattern(),
    { models: { default: { model: 'mock', handler } }, tools: makeBrowserTools(page) }
  );

  assert.equal(result, '123 Main St, Springfield, USA');
  assert.equal(memory.check_address, '123 Main St, Springfield, USA');
  assert.equal(handler.calls ?? null, null); // function handler, not scripted
});

test('find-address: navigates when m.url is set', async () => {
  const page = freshPage();
  page.text = 'Acme Corp\n1 First Ave\nBoston, MA';
  const handler = scriptedScenes(1, (i) => {
    if (i === 0) return { content: '1 First Ave, Boston, MA' };
    throw new Error('unexpected call');
  });
  const tools = makeBrowserTools(page);

  await grandma.knit(createFindAddressPattern(), {
    models: { default: { model: 'mock', handler } },
    tools,
    memory: { url: 'https://acme.example/contact' },
  });

  assert.equal(page.url, 'https://acme.example/contact');
});

test('find-address: does not navigate when m.url is absent', async () => {
  const page = freshPage();
  page.text = 'Acme Corp\n1 First Ave\nBoston, MA';
  const handler = scriptedScenes(1, (i) => {
    if (i === 0) return { content: '1 First Ave, Boston, MA' };
    throw new Error('unexpected call');
  });

  await grandma.knit(createFindAddressPattern(), {
    models: { default: { model: 'mock', handler } },
    tools: makeBrowserTools(page),
  });

  assert.equal(page.url, 'about:blank');
});

test('find-address: loops, picks a clickable, then finds the address', async () => {
  const page = freshPage();
  page.clickables = [
    { tag: 'a', text: 'Locations', href: 'https://example.com/locations' },
    { tag: 'a', text: 'About', href: 'https://example.com/about' },
  ];
  const tools = {
    ...makeBrowserTools(page),
    navigate: tool(async (args) => {
      page.url = args.url;
      if (args.url.includes('locations')) page.text = '500 Elm St, Portland, OR 97201';
      return 'navigated';
    }),
  };

  let i = 0;
  const handler = async () => {
    const n = i++;
    if (n === 0) return { content: 'no' };
    if (n === 1) return { tool_calls: [{ id: 'tc1', function: { name: 'navigate', arguments: '{"url":"https://example.com/locations"}' } }] };
    if (n === 2) return { content: '' };
    if (n === 3) return { content: '500 Elm St, Portland, OR 97201' };
    throw new Error('unexpected call ' + n);
  };

  const { result } = await grandma.knit(createFindAddressPattern(), {
    models: { default: { model: 'mock', handler } },
    tools,
  });

  assert.equal(result, '500 Elm St, Portland, OR 97201');
  assert.deepEqual(page.tried, ['{"url":"https://example.com/locations"}']);
});

test('find-address: passes tried list into the next pick_action prompt', async () => {
  const page = freshPage();
  page.clickables = [
    { tag: 'a', text: 'Locations', href: 'https://example.com/locations' },
    { tag: 'a', text: 'About',    href: 'https://example.com/about' },
  ];
  const tools = {
    ...makeBrowserTools(page),
    navigate: tool(async (args) => { page.url = args.url; return 'n'; }),
  };

  const calls = [];
  let i = 0;
  // max(3) → 4 passes (initial + 3 retries). Each pass does check_address
  // (1 call) + pick_action (2 calls, agentic loop). Total = 12 calls; we
  // supply the first 8 (which include 3 successful pick_actions) and let
  // the runner exhaust on pass 4.
  const handler = async (messages) => {
    calls.push(messages.map((m) => ({ ...m })));
    const n = i++;
    if (n === 0) return { content: 'no' };
    if (n === 1) return { tool_calls: [{ id: 'tc1', function: { name: 'navigate', arguments: '{"url":"https://example.com/locations"}' } }] };
    if (n === 2) return { content: '' };
    if (n === 3) return { content: 'no' };
    if (n === 4) return { tool_calls: [{ id: 'tc2', function: { name: 'navigate', arguments: '{"url":"https://example.com/about"}' } }] };
    if (n === 5) return { content: '' };
    if (n === 6) return { content: 'no' };
    if (n === 7) return { tool_calls: [{ id: 'tc3', function: { name: 'navigate', arguments: '{"url":"https://example.com/third"}' } }] };
    if (n === 8) return { content: '' };
    if (n === 9) return { content: 'no' };
    // Pass 4's pick_action would emit a tool call; we don't care — the
    // .until() check fires after all children and throws.
    return { content: 'no' };
  };

  await assert.rejects(
    grandma.knit(createFindAddressPattern(), {
      models: { default: { model: 'mock', handler } },
      tools,
    }),
    /gave up/i
  );

  // pick_action on iter 2 (call index 4) saw the tried list from iter 1.
  const iter2Pick = calls[4].find((m) => m.content.includes('Already tried'));
  assert.ok(iter2Pick, 'iter 2 pick_action prompt must include the tried list');
  assert.ok(iter2Pick.content.includes('https://example.com/locations'));

  // Final tried list contains the URLs from each pass that ran pick_action.
  assert.equal(page.tried.length, 3);
  assert.ok(page.tried[0].includes('locations'));
  assert.ok(page.tried[1].includes('about'));
  assert.ok(page.tried[2].includes('third'));
});

test('find-address: retries pick_action when the LLM emits no tool call', async () => {
  const page = freshPage();
  page.clickables = [{ tag: 'a', text: 'Contact', href: 'https://example.com/c' }];
  const tools = {
    ...makeBrowserTools(page),
    navigate: tool(async (args) => { page.url = args.url; page.text = '1 Acme Way, NYC'; return 'n'; }),
  };

  const calls = [];
  let i = 0;
  // LLM first responds with a long, off-topic ramble — check rejects it.
  // Then a tool call succeeds. The check accepts tool calls with valid args.
  const handler = async (messages) => {
    calls.push(messages.map((m) => ({ ...m })));
    const n = i++;
    if (n === 0) return { content: 'no' };
    if (n === 1) return { content: 'I am thinking very hard about the situation and considering all of the various elements on the page that might be relevant. There are several candidates to evaluate and I want to be thorough in my analysis. Let me describe each one carefully and explain my reasoning for why each might or might not lead to a useful page.' };
    if (n === 2) return { tool_calls: [{ id: 'tc1', function: { name: 'navigate', arguments: '{"url":"https://example.com/c"}' } }] };
    if (n === 3) return { content: '' };
    if (n === 4) return { content: '1 Acme Way, NYC' };
    throw new Error('unexpected call ' + n);
  };

  const { result } = await grandma.knit(createFindAddressPattern(), {
    models: { default: { model: 'mock', handler } },
    tools,
  });

  assert.equal(result, '1 Acme Way, NYC');
  // The retry prompt (call index 2) should have included the check feedback
  // about the missing tool call.
  const retry = calls[2].find((m) => m.content.includes('Previous attempt'));
  assert.ok(retry, 'retry prompt should include check feedback');
});

test('find-address: until loop exhausts after max iterations', async () => {
  const page = freshPage();
  page.clickables = [{ tag: 'a', text: 'X', href: 'https://x' }];
  const tools = makeBrowserTools(page);

  let i = 0;
  // max(3) → 4 passes. Each pass = 1 check + 2 pick_action rounds = 3 calls.
  // We supply 12 responses (covering all 4 passes) so the runner can finish
  // pass 4 and throw on the .until() exhaustion check.
  const handler = async () => {
    const n = i++;
    if (n % 3 === 0) return { content: 'no' };
    if (n % 3 === 1) return { tool_calls: [{ id: `tc${n}`, function: { name: 'navigate', arguments: `{"url":"https://p${Math.floor(n/3)}"}` } }] };
    return { content: '' };
  };

  await assert.rejects(
    grandma.knit(createFindAddressPattern(), {
      models: { default: { model: 'mock', handler } },
      tools,
    }),
    (err) => {
      assert.match(err.message, /gave up after 3 iterations/);
      return true;
    }
  );

  assert.equal(i, 12); // 4 passes × 3 calls
});

test('find-address: pick_action passes through with "no candidates" text', async () => {
  // The check accepts `m.prev[0] === 'no'` as a pass (no tool call, no
  // retry) — this is how the prototype signals "nothing useful to do".
  const page = freshPage();
  page.clickables = []; // empty candidates list — pick_action gets '(none)'

  let i = 0;
  // max(3) → 4 passes. Each pass = 1 check + 1 pick_action "no candidates"
  // (no agentic round 2 since no tool call) = 2 calls. 4 × 2 = 8 calls.
  // The handler discriminates by prompt content so check_address always
  // returns 'no' and pick_action always returns 'no candidates'.
  const handler = async (messages) => {
    const n = i++;
    const last = messages[messages.length - 1];
    const isCheckAddress = last.content.startsWith('Below is the text content');
    if (isCheckAddress) return { content: 'no' };
    return { content: 'no candidates' };
  };

  await assert.rejects(
    grandma.knit(createFindAddressPattern(), {
      models: { default: { model: 'mock', handler } },
      tools: makeBrowserTools(page),
    }),
    /gave up after 3 iterations/
  );

  assert.equal(i, 8); // 4 passes × 2 calls
});

test('find-address: pattern validates at knit() time (all tools exist)', async () => {
  // A pattern referencing tools not in the runtime registry should fail
  // loudly at knit() start.
  await assert.rejects(
    grandma.knit(createFindAddressPattern(), {
      models: { default: { model: 'mock', handler: async () => ({ content: 'x' }) } },
      tools: {
        navigate: tool(async () => 'n'),
        click: tool(async () => 'c'),
        exec_js: tool(async () => null),
        // missing scan_clickables and wait_for_load
      },
    }),
    /scan_clickables|wait_for_load/
  );
});
