#!/usr/bin/env node
/**
 * General CDP scraping MCP server.
 *
 * Exposes reusable scraping primitives (selectors, extraction, collection)
 * on top of the Chrome DevTools Protocol. Combine these tools to build
 * site-specific scrapers.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import CDP from 'chrome-remote-interface';
import {
  connectToCDP,
  ensureTarget,
  attachPage,
  evaluate,
  safeClose,
  scanClickables,
  waitForLoad,
} from './cdp-browser.mjs';
import { startCollect, collect, endCollect } from './json-collect.mjs';

// We keep one page session per MCP session. It is lazily attached on the
// first tool call that needs it.
const state = {
  client: null,
  pageClient: null,
  targetUrl: null,
};

async function ensurePage() {
  if (state.pageClient) {
    try {
      await evaluate(state.pageClient, '1');
      return state.pageClient;
    } catch {
      state.pageClient = null;
    }
  }

  state.client = await connectToCDP();
  const target = await ensureTarget(state.client, state.targetUrl, state.targetUrl);
  state.pageClient = await attachPage(state.client, target);
  return state.pageClient;
}

async function safeCleanup() {
  await safeClose(state.pageClient);
  await safeClose(state.client);
  state.pageClient = null;
  state.client = null;
}

const server = new Server(
  { name: 'cdp-scrape', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [
    {
      name: 'navigate',
      description: 'Navigate the attached CDP page to a URL.',
      inputSchema: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
      },
    },
    {
      name: 'exec_js',
      description: 'Run arbitrary JavaScript in the page and return a JSON-serializable result.',
      inputSchema: {
        type: 'object',
        properties: { code: { type: 'string' } },
        required: ['code'],
      },
    },
    {
      name: 'wait_for_selector',
      description: 'Wait until an element matching the selector exists.',
      inputSchema: {
        type: 'object',
        properties: {
          selector: { type: 'string' },
          timeoutMs: { type: 'number' },
        },
        required: ['selector'],
      },
    },
    {
      name: 'click_selector',
      description: 'Click the first element matching the selector.',
      inputSchema: {
        type: 'object',
        properties: { selector: { type: 'string' } },
        required: ['selector'],
      },
    },
    {
      name: 'get_text',
      description: 'Get trimmed text content of the first matching element.',
      inputSchema: {
        type: 'object',
        properties: { selector: { type: 'string' } },
        required: ['selector'],
      },
    },
    {
      name: 'get_all_text',
      description: 'Get trimmed text content of all matching elements.',
      inputSchema: {
        type: 'object',
        properties: { selector: { type: 'string' } },
        required: ['selector'],
      },
    },
    {
      name: 'get_attribute',
      description: 'Get an attribute value from the first matching element.',
      inputSchema: {
        type: 'object',
        properties: {
          selector: { type: 'string' },
          attribute: { type: 'string' },
        },
        required: ['selector', 'attribute'],
      },
    },
    {
      name: 'get_links',
      description: 'Get text and href for all matching anchor elements.',
      inputSchema: {
        type: 'object',
        properties: { selector: { type: 'string' } },
        required: ['selector'],
      },
    },
    {
      name: 'scroll_to',
      description: 'Scroll an element into view.',
      inputSchema: {
        type: 'object',
        properties: { selector: { type: 'string' } },
        required: ['selector'],
      },
    },
    {
      name: 'snapshot',
      description: 'Return page URL, title, scroll position, and text preview.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'click',
      description:
        'Send a real (x, y) mouse click through CDP, plus a synthetic DOM fallback. Set waitForNav=true if the click is expected to navigate.',
      inputSchema: {
        type: 'object',
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          waitForNav: { type: 'boolean' },
        },
        required: ['x', 'y'],
      },
    },
    {
      name: 'type',
      description: 'Insert text into the currently focused element.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
    },
    {
      name: 'screenshot',
      description: 'Capture a PNG screenshot of the full page.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'list_targets',
      description: 'List all page targets available on the CDP port.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'scan_clickables',
      description: 'Scan candidate clickable elements (a, button, [role], [tabindex]) and report their text, href, and attached event listeners via the Debugger domain.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'wait_for_load',
      description: 'Wait for the page to finish loading (Page.loadEventFired or readyState complete + stable). Returns true on load, false on timeout.',
      inputSchema: {
        type: 'object',
        properties: { timeoutMs: { type: 'number' } },
      },
    },
    {
      name: 'start_collect',
      description: 'Start a streaming JSON array output file.',
      inputSchema: {
        type: 'object',
        properties: { filePath: { type: 'string' } },
        required: ['filePath'],
      },
    },
    {
      name: 'collect',
      description: 'Append a JSON object to a streaming JSON array file started with start_collect.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: { type: 'string' },
          obj: { type: 'object' },
        },
        required: ['filePath', 'obj'],
      },
    },
    {
      name: 'end_collect',
      description: 'Close a streaming JSON array file.',
      inputSchema: {
        type: 'object',
        properties: { filePath: { type: 'string' } },
        required: ['filePath'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result;

    switch (name) {
      case 'navigate': {
        state.targetUrl = args.url;
        const pageClient = await ensurePage();
        await pageClient.Page.navigate({ url: args.url });
        await waitForLoad(pageClient, 10000);
        result = await evaluate(pageClient, '({ url: location.href, title: document.title })');
        break;
      }

      case 'exec_js': {
        const pageClient = await ensurePage();
        result = await evaluate(pageClient, args.code);
        break;
      }

      case 'wait_for_selector': {
        const pageClient = await ensurePage();
        const found = await (async () => {
          const deadline = Date.now() + (args.timeoutMs || 10000);
          while (Date.now() < deadline) {
            const exists = await evaluate(pageClient, `!!document.querySelector(${JSON.stringify(args.selector)})`);
            if (exists) return true;
            await new Promise((r) => setTimeout(r, 150));
          }
          return false;
        })();
        result = { found, selector: args.selector };
        break;
      }

      case 'click_selector': {
        const pageClient = await ensurePage();
        result = await evaluate(pageClient, `
          (() => {
            const el = document.querySelector(${JSON.stringify(args.selector)});
            if (!el) return { error: 'Element not found' };
            el.click();
            return { clicked: true };
          })()
        `);
        break;
      }

      case 'get_text': {
        const pageClient = await ensurePage();
        result = await evaluate(pageClient, `document.querySelector(${JSON.stringify(args.selector)})?.textContent?.trim() || null`);
        break;
      }

      case 'get_all_text': {
        const pageClient = await ensurePage();
        result = await evaluate(pageClient, `
          Array.from(document.querySelectorAll(${JSON.stringify(args.selector)}))
            .map(el => el.textContent.trim())
        `);
        break;
      }

      case 'get_attribute': {
        const pageClient = await ensurePage();
        result = await evaluate(pageClient, `
          document.querySelector(${JSON.stringify(args.selector)})?.getAttribute(${JSON.stringify(args.attribute)}) || null
        `);
        break;
      }

      case 'get_links': {
        const pageClient = await ensurePage();
        result = await evaluate(pageClient, `
          Array.from(document.querySelectorAll(${JSON.stringify(args.selector)}))
            .map(el => ({ text: el.textContent.trim(), href: el.href }))
        `);
        break;
      }

      case 'scroll_to': {
        const pageClient = await ensurePage();
        result = await evaluate(pageClient, `
          document.querySelector(${JSON.stringify(args.selector)})?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          'scrolled';
        `);
        break;
      }

      case 'snapshot': {
        const pageClient = await ensurePage();
        result = await evaluate(pageClient, `
          ({
            url: location.href,
            title: document.title,
            readyState: document.readyState,
            scrollY: window.scrollY,
            scrollHeight: document.body?.scrollHeight || 0,
            clientHeight: window.innerHeight,
            textPreview: document.body?.innerText?.slice(0, 2000) || '',
          })
        `);
        break;
      }

      case 'click': {
        const pageClient = await ensurePage();
        await pageClient.Input.dispatchMouseEvent({ type: 'mouseMoved', x: args.x, y: args.y, buttons: 0 });
        await pageClient.Input.dispatchMouseEvent({ type: 'mousePressed', x: args.x, y: args.y, button: 'left', buttons: 1, clickCount: 1 });
        await pageClient.Input.dispatchMouseEvent({ type: 'mouseReleased', x: args.x, y: args.y, button: 'left', buttons: 0, clickCount: 1 });
        // Fallback for React/synthetic event systems.
        await pageClient.Runtime.evaluate({
          expression: `
            const el = document.elementFromPoint(${args.x}, ${args.y});
            if (el) {
              el.click();
              el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
            }
          `,
          awaitPromise: false,
        });
        result = { x: args.x, y: args.y };
        break;
      }

      case 'type': {
        const pageClient = await ensurePage();
        await pageClient.Input.insertText({ text: args.text });
        result = { typed: args.text.length };
        break;
      }

      case 'screenshot': {
        const pageClient = await ensurePage();
        const { data } = await pageClient.Page.captureScreenshot({ format: 'png' });
        const bytes = Buffer.from(data, 'base64').length;
        return {
          content: [
            { type: 'image', data, mimeType: 'image/png' },
            { type: 'text', text: `Screenshot captured (${bytes} bytes)` },
          ],
        };
      }

      case 'list_targets': {
        const port = Number(process.env.CDP_PORT || 9222);
        const targets = await CDP.List({ port });
        result = targets
          .filter((t) => t.type === 'page')
          .map((t) => ({ id: t.id, url: t.url, title: t.title, type: t.type }));
        break;
      }

      case 'scan_clickables': {
        const pageClient = await ensurePage();
        result = await scanClickables(pageClient);
        break;
      }

      case 'wait_for_load': {
        const pageClient = await ensurePage();
        const loaded = await waitForLoad(pageClient, args.timeoutMs || 10000);
        result = { loaded };
        break;
      }

      case 'start_collect': {
        await startCollect(args.filePath);
        result = { started: true, filePath: args.filePath };
        break;
      }

      case 'collect': {
        await collect(args.filePath, args.obj);
        result = { collected: true, filePath: args.filePath };
        break;
      }

      case 'end_collect': {
        await endCollect(args.filePath);
        result = { ended: true, filePath: args.filePath };
        break;
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error: ${err.message}` }],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('[scrape-server] fatal:', err);
  process.exit(1);
});
