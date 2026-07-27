#!/usr/bin/env node
import { startScrapeServer, callTool, stopScrapeServer } from '../lib/mcp.mjs';
import { setProvider } from '../lib/llm.mjs';
import { createLogger } from '../lib/logger.mjs';
import { createFindListingsThread } from './thread.mjs';

const url = process.argv[2];
const scope = process.argv[3] || 'body';

setProvider('local');

const log = createLogger('find-listings');
console.log(`Run ID: ${log.runId}`);
console.log(`Logs: ${log.logDir}`);
if (url) console.log(`Target URL: ${url}`);
console.log(`Scope: ${scope}`);

console.log('\nStarting scrape MCP server...');
const client = await startScrapeServer();

try {
  // Navigate to target URL if provided
  if (url) {
    console.log(`Navigating to ${url}...`);
    await callTool(client, 'navigate', { url });
  }

  const thread = createFindListingsThread({ scope, client, log });
  const result = await thread.run();

  console.log('\n=== Final Result ===');
  console.log(JSON.stringify(result, null, 2));
} catch (err) {
  console.error('Find Listings failed:', err.message);
  process.exit(1);
} finally {
  await stopScrapeServer(client);
}
