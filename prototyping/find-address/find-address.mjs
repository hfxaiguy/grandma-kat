import { startScrapeServer, stopScrapeServer, callTool } from '../lib/mcp.mjs';
import { callLlm } from '../lib/llm.mjs';

const SYSTEM_PROMPT = 'You are a web navigation assistant. You help find information on web pages by reading page content and deciding what to click or navigate to.';

const STEP1_PROMPT = `Below is the text content of a web page.

Your task: Does this page contain a business address? A business address has a street number, street name, city, and country or postal code.

If YES: Write the full address on one line.
If NO: Respond with exactly one word: no`;

const STEP2_PROMPT = `Below is a numbered list of clickable elements found on the web page. Each line shows the HTML tag, the visible text, and either a URL in parentheses or event types in brackets.

Your task: Which elements are most likely to lead to a page containing a business address?

Rules:
- Links with URLs in parentheses can be opened.
- Elements in brackets have click handlers and can be clicked.
- Prefer elements like "Contact", "About", "Visit Us", directions, or footer links.

List the most promising candidates, one per line, in this exact format:
N - <tag> "text" (href) [events]

Examples:
3 - <a> "Contact" (https://example.com/contact)
5 - <div> "Visit Us" [click,mousedown]

If none would lead to an address: Respond with exactly: no`;

const FILTER_PROMPT = `Below is a list of candidate clickable elements that might lead to a business address.

{candidates}

These elements have already been tried in previous iterations:

{memory}

Your task: Remove any candidates that have already been tried (matching by text, href, or tag). List ONLY the remaining candidates, one per line, in the same format:
N - <tag> "text" (href) [events]

If no candidates remain: Respond with exactly: no`;

const STEP3_PROMPT = `Below are filtered candidate clickable elements that should be tried next:

{candidates}

Choose ONE element to interact with. You have two tools:

1. navigate - Opens a URL in the browser tab. Use this when the element has a URL in parentheses.
2. click - Clicks an element on the page by a CSS selector. Use this when the element has no URL but has click handlers in brackets.

Respond with exactly one action in this format:
- To navigate: NAVIGATE <url>
- To click: CLICK <css-selector>

Examples:
NAVIGATE https://example.com/contact
CLICK a[href*="contact"]

Pick the element most likely to contain a business address.`;

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
  // Keep lines that look like candidate entries: "N - <tag> ..."
  return lines.filter((l) => /^\d+\s*-\s*<\w+>/.test(l));
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

        let candidates = parseCandidateList(step2.content);
        if (!candidates.length) {
          console.log('\nNo candidates found. Stopping.');
          break;
        }

        console.log(`\nParsed ${candidates.length} candidate(s):`);
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

        const step3 = await callLlm([
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: candidates.join('\n') },
          { role: 'user', content: STEP3_PROMPT.replace('{candidates}', candidates.join('\n')) },
        ]);

        console.log('--- Step 3: LLM Answer ---');
        if (step3.reasoning) {
          console.log('Thinking:');
          console.log(step3.reasoning);
          console.log('\nResponse:');
        }
        console.log(step3.content);

        // Execute the action
        const action = parseAction(step3.content);
        if (!action) {
          console.log('Could not parse action from LLM response.');
          break;
        }

        console.log(`\n--- Executing: ${action.type} ${action.value} ---`);
        let actionResult;
        if (action.type === 'navigate') {
          actionResult = await callTool(client, 'navigate', { url: action.value });
        } else {
          actionResult = await callTool(client, 'click_selector', { selector: action.value });
          await callTool(client, 'wait_for_load', { timeoutMs: 10000 });
        }
        console.log(JSON.stringify(actionResult, null, 2));

        // Find which candidate was chosen for memory
        const chosenCandidate = candidates.find((c) =>
          action.type === 'navigate'
            ? c.includes(action.value)
            : true,
        ) || candidates[0] || step3.content.trim();

        // Fetch resulting page info
        const resultUrl = await callTool(client, 'exec_js', { code: 'location.href' });
        const resultTitle = await callTool(client, 'exec_js', { code: 'document.title' });
        const resultStr = `${resultTitle} - ${resultUrl}`;

        // Append to memory and dump state
        memory.push({
          candidate: chosenCandidate,
          action: `${action.type.toUpperCase()} ${action.value}`,
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

function parseAction(content) {
  const text = String(content).trim();
  const navMatch = text.match(/NAVIGATE\s+(https?:\/\/\S+)/i);
  if (navMatch) return { type: 'navigate', value: navMatch[1] };
  const clickMatch = text.match(/CLICK\s+(.+)$/im);
  if (clickMatch) return { type: 'click', value: clickMatch[1].trim() };
  return null;
}