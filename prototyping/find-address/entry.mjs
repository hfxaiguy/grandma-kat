#!/usr/bin/env node
// Entry point for the find-address pattern. Launches Chrome if needed,
// starts the browser-mcp scrape server, wires grandma-kat to the tools,
// and runs the pattern against the optional URL passed on the command line.

import { launchChrome } from '../browser-mcp/launch-chrome.mjs';
import { startScrapeServer, callTool, stopScrapeServer } from '../lib/mcp.mjs';
import { loadConfig } from '../lib/config.mjs';
import grandma, { KnitError } from '../../src/index.mjs';
import { pattern } from './find-address.mjs';

const url = process.argv[2];

if (url) console.log(`Target URL: ${url}\n`);

await launchChrome();

const config = loadConfig();
console.log('Starting scrape MCP server...');
const client = await startScrapeServer();

try {
  const { result, memory, runId } = await grandma.knit(
    pattern,
    {
      models: {
        default: {
          baseURL: config.provider.baseURL,
          apiKey: config.provider.apiKey,
          model: config.model,
        },
      },
      tools: makeToolRegistry(client),
      memory: url ? { url } : {},
      logLevel: 'debug',
    }
  );

  console.log(`\nRun: ${runId}`);
  console.log('Address:', result);
  if (memory.check_address) console.log('check_address slot:', memory.check_address);
} catch (err) {
  if (err instanceof KnitError) {
    console.error(`find-address failed: ${err.message}`);
  } else {
    console.error('find-address failed:', err);
  }
  process.exit(1);
} finally {
  await stopScrapeServer(client);
}

function makeToolRegistry(client) {
  return {
    navigate: {
      description: 'Open a URL in the browser tab.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'The URL to navigate to.' } },
        required: ['url'],
      },
      execute: async (args) => callTool(client, 'navigate', args),
    },
    click: {
      description: 'Click an element on the page by CSS selector.',
      parameters: {
        type: 'object',
        properties: { selector: { type: 'string', description: 'CSS selector for the element.' } },
        required: ['selector'],
      },
      execute: async (args) => callTool(client, 'click_selector', args),
    },
    exec_js: {
      description: 'Run JavaScript in the page and return the JSON-stringified result.',
      parameters: {
        type: 'object',
        properties: { code: { type: 'string', description: 'JavaScript source to evaluate.' } },
        required: ['code'],
      },
      execute: async (args) => callTool(client, 'exec_js', args),
    },
    scan_clickables: {
      description: 'Scan the page for clickable elements and return them as an array of { tag, text, href, listeners }.',
      parameters: { type: 'object', properties: {} },
      execute: async () => callTool(client, 'scan_clickables', {}),
    },
    wait_for_load: {
      description: 'Wait until the page has finished loading.',
      parameters: {
        type: 'object',
        properties: { timeoutMs: { type: 'number', description: 'How long to wait in ms.' } },
      },
      execute: async (args) => callTool(client, 'wait_for_load', args),
    },
    snapshot: {
      description: 'Return page URL, title, scroll position, and text preview.',
      parameters: { type: 'object', properties: {} },
      execute: async () => callTool(client, 'snapshot', {}),
    },
  };
}
