import { startScrapeServer, stopScrapeServer, callTool } from '../lib/mcp.mjs';
import { callLlm } from '../lib/llm.mjs';

const SYSTEM_PROMPT = 'You are a web navigation assistant. You help find information on web pages by reading page content and deciding what to click or navigate to.';

const STEP1_PROMPT = `Below is the text content of a web page.

Your task: Does this page contain a business address? A business address has a street number, street name, city, and country or postal code.

If YES: Write the full address on one line.
If NO: Respond with exactly one word: no`;

const RATING_PROMPT = `This clickable element was found on a web page:
{element}

The page is about: {pageTitle}

Rate from 1 to 10: how likely is clicking this element to lead to a page or popup that contains a business address?

Respond with only a single number.`;

const STEP3_PROMPT = `Below are candidate clickable elements that might lead to a business address:

{candidates}

Choose ONE element to interact with. Call the appropriate tool:
- Call "navigate" with the URL when the element has a URL in parentheses.
- Call "click" with a CSS selector when the element has no URL.

Pick the element most likely to contain a business address.`;

const STEP3_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'navigate',
      description: 'Open a URL in the browser tab.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The URL to navigate to.' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'click',
      description: 'Click an element on the page by CSS selector.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'A CSS selector targeting the element to click.' },
        },
        required: ['selector'],
      },
    },
  },
];

const MAX_ITERATIONS = 3;
const SCORE_THRESHOLD = 5;
const MAX_CANDIDATES = 5;

function isNo(content) {
  return String(content).trim().toLowerCase() === 'no';
}

function formatClickable(el) {
  const tag = `<${el.tag}>`;
  const text = el.text ? `"${el.text.replace(/\n/g, ' ')}"` : '';
  let suffix = '';
  if (el.href) suffix += ` (${el.href})`;
  if (el.listeners?.length) suffix += ` [${el.listeners.map((l) => l.type).join(',')}]`;
  return `${tag} ${text}${suffix}`.trim();
}

function parseScore(content) {
  const match = String(content).match(/\d+/);
  if (!match) return 0;
  return parseInt(match[0], 10);
}

function formatMemory(memory) {
  if (!memory.length) return '(none yet)';
  return memory
    .map(
      (m, i) =>
        `${i + 1}. Tried: ${m.candidate}\n   Action: ${m.action}\n   Result: ${m.result}`,
    )
    .join('\n');
}

function dumpMemory(memory) {
  console.log('\n--- Memory (tried elements) ---');
  if (!memory.length) {
    console.log('(empty)');
  } else {
    for (const m of memory) {
      console.log(`- ${m.candidate}`);
      console.log(`    action: ${m.action}`);
      console.log(`    result: ${m.result}`);
    }
  }
  console.log('--- End Memory ---\n');
}

function isAlreadyTried(line, memory) {
  return memory.some((m) => m.candidate === line);
}

export async function runFindAddress() {
  console.log('Starting scrape MCP server...');
  const client = await startScrapeServer();
  const memory = [];
  try {
    for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
      console.log(`\n${'='.repeat(60)}`);
      console.log(`Iteration ${iteration} of ${MAX_ITERATIONS}`);
      console.log(`${'='.repeat(60)}\n`);

      // Step 1: Dump page text and ask if it contains a business address
      console.log('Step 1: Dumping page text...');
      const pageText = await callTool(client, 'exec_js', {
        code: 'document.body ? document.body.innerText : ""',
      });

      if (!pageText) {
        throw new Error('No page text found. Is a page loaded in the CDP browser?');
      }

      const currentUrl = await callTool(client, 'exec_js', { code: 'location.href' });
      const currentTitle = await callTool(client, 'exec_js', { code: 'document.title' });
      console.log(`Page: ${currentTitle} - ${currentUrl}`);
      console.log(`Dumped ${String(pageText).length} chars.\n`);
      console.log('--- Page Dump ---');
      console.log(pageText);
      console.log('--- End Page Dump ---\n');

      const answer = await callLlm([
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: pageText },
        { role: 'user', content: STEP1_PROMPT },
      ]);

      console.log('--- Step 1: LLM Answer ---');
      if (answer.reasoning) {
        console.log('Thinking:');
        console.log(answer.reasoning);
        console.log('\nResponse:');
      }
      console.log(answer.content);

      if (isNo(answer.content)) {
        // Step 2: Scan clickable elements and rate each one
        console.log('\nStep 2: Scanning and rating clickable elements...');
        const clickables = await callTool(client, 'scan_clickables', {});
        const lines = clickables.map(formatClickable);

        console.log(`\nFound ${lines.length} clickable elements. Rating each...\n`);

        const ratingPromises = lines.map((line) =>
          callLlm([
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: RATING_PROMPT.replace('{element}', line).replace('{pageTitle}', currentTitle) },
          ]).then((resp) => ({ line, score: parseScore(resp.content) })),
        );

        const ratings = await Promise.all(ratingPromises);

        for (const r of ratings) {
          console.log(`  [${r.score}/10] ${r.line}`);
        }

        // Filter: score > threshold, not already tried, max N candidates
        const ranked = ratings
          .filter((r) => r.score > SCORE_THRESHOLD)
          .filter((r) => !isAlreadyTried(r.line, memory))
          .sort((a, b) => b.score - a.score)
          .slice(0, MAX_CANDIDATES);

        if (!ranked.length) {
          console.log(`\nNo elements scored above ${SCORE_THRESHOLD} (or all already tried). Stopping.`);
          break;
        }

        const candidates = ranked.map((r) => r.line);
        console.log(`\n${candidates.length} candidate(s) (scored > ${SCORE_THRESHOLD}, not yet tried):`);
        for (const r of ranked) {
          console.log(`  [${r.score}/10] ${r.line}`);
        }

        // Step 3: Ask the LLM to choose an action (navigate or click)
        console.log('\nStep 3: Choosing action...');

        const step3 = await callLlm(
          [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: STEP3_PROMPT.replace('{candidates}', candidates.join('\n')) },
          ],
          { tools: STEP3_TOOLS },
        );

        console.log('--- Step 3: LLM Answer ---');
        if (step3.reasoning) {
          console.log('Thinking:');
          console.log(step3.reasoning);
          console.log('\nResponse:');
        }
        if (step3.content) console.log(step3.content);

        // Extract the tool call
        const toolCall = step3.tool_calls?.[0];
        if (!toolCall) {
          console.log('No tool call returned by LLM. Stopping.');
          break;
        }

        const fn = toolCall.function;
        console.log(`\n--- Tool call: ${fn.name}(${fn.arguments}) ---`);

        let actionResult;
        let actionLabel;
        if (fn.name === 'navigate') {
          const args = JSON.parse(fn.arguments);
          actionResult = await callTool(client, 'navigate', { url: args.url });
          actionLabel = `NAVIGATE ${args.url}`;
        } else if (fn.name === 'click') {
          const args = JSON.parse(fn.arguments);
          actionResult = await callTool(client, 'click_selector', { selector: args.selector });
          await callTool(client, 'wait_for_load', { timeoutMs: 10000 });
          actionLabel = `CLICK ${args.selector}`;
        } else {
          console.log(`Unknown tool: ${fn.name}`);
          break;
        }
        console.log(JSON.stringify(actionResult, null, 2));

        // Find which candidate was chosen for memory
        const chosenCandidate = candidates.find((c) =>
          fn.name === 'navigate'
            ? c.includes(JSON.parse(fn.arguments).url)
            : true,
        ) || candidates[0] || fn.name;

        // Fetch resulting page info
        const resultUrl = await callTool(client, 'exec_js', { code: 'location.href' });
        const resultTitle = await callTool(client, 'exec_js', { code: 'document.title' });
        const resultStr = `${resultTitle} - ${resultUrl}`;

        // Append to memory and dump state
        memory.push({
          candidate: chosenCandidate,
          action: actionLabel,
          result: resultStr,
        });
        dumpMemory(memory);

        // Loop back to step 1 with the new page
        console.log('Looping back to step 1...\n');
      } else {
        console.log('\n--- ADDRESS FOUND ---');
        console.log(answer.content);
        break;
      }
    }

    if (memory.length) dumpMemory(memory);
    return;
  } finally {
    await stopScrapeServer(client);
  }
}