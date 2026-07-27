// Tests for the find-address pattern. These mock the LLM and the browser-mcp
// tools, so the runner exercises the full tree (gates, tools, flow control)
// without needing a real browser.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import grandma from '../src/index.mjs';
import { tool } from './helpers.mjs';
import { pattern } from '../prototyping/find-address/find-address.mjs';

// Tool registry that mimics browser-mcp over an in-memory page. The snapshot
// tool returns page text, URL, and title matching the MCP server's response.
function makeBrowserTools(page) {
  const snapshot = tool(async () => ({
    url: page.url,
    title: page.title,
    textPreview: page.text,
    readyState: 'complete',
    scrollY: 0,
    scrollHeight: 0,
    clientHeight: 800,
  }));

  return {
    navigate: tool(async (args) => {
      page.url = args.url;
      return 'navigated';
    }),
    click: tool(async (args) => {
      page.clicked.push(args.selector);
      return 'clicked';
    }),
    snapshot: snapshot,
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
  };
}

// A scripted handler that returns responses for the Nth LLM call.
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
    pattern,
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

  await grandma.knit(pattern, {
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

  await grandma.knit(pattern, {
    models: { default: { model: 'mock', handler } },
    tools: makeBrowserTools(page),
  });

  assert.equal(page.url, 'about:blank');
});

test('find-address: loops, picks a clickable, then finds the address', async () => {
  const page = freshPage();
  page.clickables = [
    { tag: 'a', text: 'Locations', href: 'https://example.com/locations', selector: 'a[href="https://example.com/locations"]' },
    { tag: 'a', text: 'About', href: 'https://example.com/about', selector: 'a[href="https://example.com/about"]' },
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
  const handler = async (messages) => {
    const n = i++;
    const last = messages[messages.length - 1];
    // check_address: first call says no, second says address found
    if (last.content.startsWith('Below is the text content'))
      return { content: n === 0 ? 'no' : '500 Elm St, Portland, OR 97201' };
    // get_company
    if (last.content.includes('What is the name of the company'))
      return { content: 'AC-ADA' };
    // try_element: answer yes on first element
    if (last.content.includes('Would clicking this element'))
      return { content: 'yes' };
    // pick_action: navigate
    return { tool_calls: [{ id: 'tc1', function: { name: 'navigate', arguments: '{"url":"https://example.com/locations"}' } }] };
  };

  const { result } = await grandma.knit(pattern, {
    models: { default: { model: 'mock', handler } },
    tools,
  });

  assert.equal(result, '500 Elm St, Portland, OR 97201');
});

test('find-address: tries multiple elements before finding one', async () => {
  const page = freshPage();
  page.clickables = [
    { tag: 'a', text: 'About', href: 'https://example.com/about', selector: 'a[href="https://example.com/about"]' },
    { tag: 'a', text: 'Contact', href: 'https://example.com/contact', selector: 'a[href="https://example.com/contact"]' },
  ];
  const tools = {
    ...makeBrowserTools(page),
    navigate: tool(async (args) => { page.url = args.url; return 'n'; }),
  };

  const askCalls = [];
  let checkCount = 0;
  let i = 0;
  const handler = async (messages) => {
    const n = i++;
    const last = messages[messages.length - 1];
    if (last.content.startsWith('Below is the text content')) {
      checkCount++;
      // First check: no address. Second check: address found.
      return { content: checkCount === 1 ? 'no' : '123 Main St, Springfield, USA' };
    }
    if (last.content.includes('What is the name of the company')) return { content: 'Test Corp' };
    if (last.content.includes('Would clicking this element')) {
      askCalls.push(last.content);
      // First element: no. Second element: yes.
      return { content: askCalls.length === 1 ? 'no' : 'yes' };
    }
    // pick_action
    return { tool_calls: [{ id: 'tc1', function: { name: 'navigate', arguments: '{"url":"https://example.com/contact"}' } }] };
  };

  const { result } = await grandma.knit(pattern, {
    models: { default: { model: 'mock', handler } },
    tools,
  });

  assert.equal(result, '123 Main St, Springfield, USA');
  // First ask was about "About", second was about "Contact"
  assert.ok(askCalls[0].includes('About'));
  assert.ok(askCalls[1].includes('Contact'));
});

test('find-address: retries pick_action when the LLM emits no tool call', async () => {
  const page = freshPage();
  page.clickables = [{ tag: 'a', text: 'Contact', href: 'https://example.com/c', selector: 'a[href="https://example.com/c"]' }];
  const tools = {
    ...makeBrowserTools(page),
    navigate: tool(async (args) => { page.url = args.url; page.text = '1 Acme Way, NYC'; return 'n'; }),
  };

  let pickCount = 0;
  let i = 0;
  const handler = async (messages) => {
    const n = i++;
    const last = messages[messages.length - 1];
    if (last.content.startsWith('Below is the text content'))
      return { content: n === 0 ? 'no' : '1 Acme Way, NYC' };
    if (last.content.includes('What is the name of the company')) return { content: 'Acme' };
    if (last.content.includes('Would clicking this element')) return { content: 'yes' };
    // pick_action: first time ramble, second time tool call
    pickCount++;
    if (pickCount === 1) {
      return { content: 'I am thinking very hard about the situation and considering all of the various elements on the page that might be relevant. There are several candidates to evaluate and I want to be thorough in my analysis.' };
    }
    return { tool_calls: [{ id: 'tc1', function: { name: 'navigate', arguments: '{"url":"https://example.com/c"}' } }] };
  };

  const { result } = await grandma.knit(pattern, {
    models: { default: { model: 'mock', handler } },
    tools,
  });

  assert.equal(result, '1 Acme Way, NYC');
});

test('find-address: until loop exhausts after max iterations', async () => {
  const page = freshPage();
  page.clickables = [{ tag: 'a', text: 'X', href: 'https://x', selector: 'a[href="https://x"]' }];
  const tools = makeBrowserTools(page);

  let i = 0;
  // Each pass = check + company + try_element ask + pick = 4 calls.
  // 4 passes × 4 = 16 calls total.
  const handler = async (messages) => {
    const n = i++;
    const last = messages[messages.length - 1];
    if (last.content.startsWith('Below is the text content')) return { content: 'no' };
    if (last.content.includes('What is the name of the company')) return { content: 'X Corp' };
    if (last.content.includes('Would clicking this element')) return { content: 'yes' };
    return { tool_calls: [{ id: `tc${n}`, function: { name: 'navigate', arguments: `{"url":"https://p${Math.floor(n/4)}"}` } }] };
  };

  await assert.rejects(
    grandma.knit(pattern, {
      models: { default: { model: 'mock', handler } },
      tools,
    }),
    (err) => {
      assert.match(err.message, /gave up after 3 iterations/);
      return true;
    }
  );

  assert.equal(i, 16); // 4 passes × 4 calls
});

test('find-address: pick_action passes through with "no candidates" text', async () => {
  const page = freshPage();
  page.clickables = []; // empty — no elements to try

  let i = 0;
  // Each pass = check + company + try_element (no elements, prompt still runs) + pick = 4 calls.
  // 4 passes × 4 = 16 calls total.
  const handler = async (messages) => {
    const n = i++;
    const last = messages[messages.length - 1];
    if (last.content.startsWith('Below is the text content')) return { content: 'no' };
    if (last.content.includes('What is the name of the company')) return { content: 'Empty Corp' };
    if (last.content.includes('Would clicking this element') || last.content.includes('No more elements'))
      return { content: 'no' };
    return { content: 'no candidates' };
  };

  await assert.rejects(
    grandma.knit(pattern, {
      models: { default: { model: 'mock', handler } },
      tools: makeBrowserTools(page),
    }),
    /gave up after 3 iterations/
  );

  assert.equal(i, 16); // 4 passes × 4 calls
});

test('find-address: pattern validates at knit() time (all tools exist)', async () => {
  // A pattern referencing tools not in the runtime registry should fail
  // loudly at knit() start.
  await assert.rejects(
    grandma.knit(pattern, {
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
