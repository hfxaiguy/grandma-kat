import path from 'node:path';
import { Client } from '../browser-mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../browser-mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';

const SERVER_PATH = path.resolve('prototyping/browser-mcp/scrape-server.mjs');

export async function startScrapeServer() {
  const transport = new StdioClientTransport({
    command: 'node',
    args: [SERVER_PATH],
    env: {
      ...process.env,
      CDP_PORT: process.env.CDP_PORT || '9222',
    },
  });

  const client = new Client(
    { name: 'threads-prototype', version: '0.0.1' },
    { capabilities: {} },
  );
  await client.connect(transport);
  return client;
}

export async function callTool(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.map((c) => c.text || '').join('\n').trim();
  if (result.isError) {
    throw new Error(text);
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function stopScrapeServer(client) {
  try {
    await client.close();
  } catch {
    // ignore
  }
}