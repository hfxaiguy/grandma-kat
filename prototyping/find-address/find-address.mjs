import { startScrapeServer, stopScrapeServer, callTool } from '../lib/mcp.mjs';
import { callLlm } from '../lib/llm.mjs';

const SYSTEM_PROMPT = 'You are a web navigation assistant. You help find information on web pages by reading page content and deciding what to click or navigate to.';

const STEP1_PROMPT = `Below is the text content of a web page.

Your task: Does this page contain a business address? A business address has a street number, street name, city, and country or postal code.

If YES: Write the full address on one line.
If NO: Respond with exactly one word: no`;

const STEP2_PROMPT = `Below is a list of clickable elements found on the web page. Each line is formatted as:
<html_tag> "text" (url)

Your task: Which elements are most likely to lead to a page containing a business address?

Think about which pages on a website typically contain a business address. A business address has a street number, street name, city, and country or postal code.

List the most promising candidates, one per line. For each candidate, copy the ENTIRE line from the list above, exactly as it appears, including the HTML tag, the text, and the URL.

If none would lead to an address: Respond with exactly: no`;

const STEP2_1_VERIFY_PROMPT = `Below is a list of all clickable elements found on the page (the source of truth):

{elements}

And here is a list of candidates chosen by another assistant. They may be incomplete or slightly different from the source list:

{candidates}

Your task: For each candidate, find the matching element in the source list above by comparing the HTML tag, visible text, and URL. Then copy the matching element EXACTLY as it appears in the source list.

List one matched element per line.

If a candidate does not match any element in the source list, skip it.
If no candidates match: Respond with exactly: no`;

const FILTER_PROMPT = `Below is a list of candidate clickable elements that might lead to a business address.

{candidates}

These elements have already been tried in previous iterations:

{memory}

Your task: Remove any candidates that have already been tried (matching by text, href, or tag). List ONLY the remaining candidates, one per line. Copy each candidate exactly as it appears above, including the number, HTML tag, text, and URL.

If no candidates remain: Respond with exactly: no`;

const STEP3_PROMPT = `Below are filtered candidate clickable elements that should be tried next:

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

function numbered(lines) {
  return lines.map((line, i) => `${i + 1}. ${line}`).join('\n');
}

function parseCandidateList(content) {
  const lines = String(content)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  // Accept lines starting with <tag> (proper format only)
  return lines.filter((l) => /^<\w+>/.test(l));
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
        // Step 2: Scan clickable elements and ask which might lead to an address
        console.log('\nStep 2: Scanning clickable elements...');
        const clickables = await callTool(client, 'scan_clickables', {});
        const lines = clickables.map(formatClickable);
        const numberedLines = numbered(lines);

        console.log('\n--- Clickable Elements ---');
        console.log(numberedLines);
        console.log('--- End Clickable Elements ---\n');

        const step2 = await callLlm([
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: numberedLines },
          { role: 'user', content: STEP2_PROMPT },
        ]);

        console.log('--- Step 2: LLM Answer ---');
        if (step2.reasoning) {
          console.log('Thinking:');
          console.log(step2.reasoning);
          console.log('\nResponse:');
        }
        console.log(step2.content);

        // Step 2.1: Reconcile raw step 2 output back to exact source elements
        console.log('\nStep 2.1: Reconciling candidates with source elements...');
        const verifyResp = await callLlm([
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: STEP2_1_VERIFY_PROMPT.replace('{elements}', numberedLines).replace('{candidates}', step2.content) },
        ]);

        console.log('--- Step 2.1: Reconciliation ---');
        if (verifyResp.reasoning) {
          console.log('Thinking:');
          console.log(verifyResp.reasoning);
          console.log('\nResponse:');
        }
        console.log(verifyResp.content);

        let candidates = parseCandidateList(verifyResp.content);
        if (!candidates.length) {
          console.log('\nNo candidates matched source elements. Stopping.');
          break;
        }
        console.log(`\n${candidates.length} reconciled candidate(s):`);
        candidates.forEach((c) => console.log(`  ${c}`));

        // Substep 2.5: Filter out already-tried elements using memory
        if (memory.length) {
          console.log('\nStep 2.5: Filtering already-tried elements...');
          const filterResp = await callLlm([
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: FILTER_PROMPT.replace('{candidates}', candidates.join('\n')).replace('{memory}', formatMemory(memory)) },
          ]);

          console.log('--- Step 2.5: LLM Answer ---');
          if (filterResp.reasoning) {
            console.log('Thinking:');
            console.log(filterResp.reasoning);
            console.log('\nResponse:');
          }
          console.log(filterResp.content);

          if (isNo(filterResp.content)) {
            console.log('\nAll candidates have been tried. Stopping.');
            break;
          }

          const filtered = parseCandidateList(filterResp.content);
          if (!filtered.length) {
            console.log('\nNo untried candidates remain. Stopping.');
            break;
          }
          candidates = filtered;
          console.log(`\n${candidates.length} candidate(s) after filtering:`);
          candidates.forEach((c) => console.log(`  ${c}`));
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
        const chosenCandidate = candidates[0] || fn.name;

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