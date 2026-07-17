import { startScrapeServer, stopScrapeServer, callTool } from '../lib/mcp.mjs';
import { callLlm } from '../lib/llm.mjs';

const SYSTEM_PROMPT = 'You are a web navigation assistant. You help find information on web pages by reading page content and deciding what to click or navigate to.';

const STEP1_PROMPT = `Below is the text content of a web page.

Your task: Does this page contain a business address? A business address has a street number, street name, city, and country or postal code.

If YES: Write the full address on one line.
If NO: Respond with exactly one word: no`;

const STEP2_PROMPT = `Below is a numbered list of clickable elements found on the web page. Each line shows the HTML tag, the visible text, and either a URL in parentheses or event types in brackets.

Your task: Which element is most likely to lead to a page containing a business address?

Rules:
- Links with URLs in parentheses can be opened.
- Elements in brackets have click handlers and can be clicked.
- Prefer elements like "Contact", "About", "Visit Us", directions, or footer links.

If you find a candidate: List its number, tag, text, href (if any) in parentheses, and event types (if any) in brackets.
Example: 3 - <a> "Contact" (https://example.com/contact)
Example: 5 - <div> "Visit Us" [click,mousedown]

If none would lead to an address: Respond with exactly: no`;

const STEP3_PROMPT = `You identified these clickable elements that might lead to a business address:

{candidates}

Choose ONE element to interact with. You have two tools:

1. navigate - Opens a URL in the browser tab. Use this when the element has a URL in parentheses.
2. click - Clicks an element on the page by CSS selector. Use this when the element has no URL but has click handlers in brackets.

Respond with exactly one action in this format:
- To navigate: NAVIGATE <url>
- To click: CLICK <css-selector>

Examples:
NAVIGATE https://example.com/contact
CLICK a[href*="contact"]

Pick the element most likely to contain a business address.`;

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

export async function runFindAddress() {
  console.log('Starting scrape MCP server...');
  const client = await startScrapeServer();
  try {
    // Step 1: Dump page text and ask if it contains a business address
    console.log('Step 1: Dumping page text...');
    const pageText = await callTool(client, 'exec_js', {
      code: 'document.body ? document.body.innerText : ""',
    });

    if (!pageText) {
      throw new Error('No page text found. Is a page loaded in the CDP browser?');
    }

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

      const followup = await callLlm([
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: numberedLines },
        { role: 'user', content: STEP2_PROMPT },
      ]);

      console.log('--- Step 2: LLM Answer ---');
      if (followup.reasoning) {
        console.log('Thinking:');
        console.log(followup.reasoning);
        console.log('\nResponse:');
      }
      console.log(followup.content);

      if (!isNo(followup.content)) {
        // Step 3: Ask the LLM to choose an action (navigate or click)
        console.log('\nStep 3: Choosing action...');

        const step3 = await callLlm([
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: numberedLines },
          { role: 'user', content: followup.content },
          { role: 'user', content: STEP3_PROMPT.replace('{candidates}', followup.content) },
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
        if (action) {
          console.log(`\n--- Executing: ${action.type} ${action.value} ---`);
          if (action.type === 'navigate') {
            const result = await callTool(client, 'navigate', { url: action.value });
            console.log(JSON.stringify(result, null, 2));
          } else if (action.type === 'click') {
            const result = await callTool(client, 'click_selector', { selector: action.value });
            console.log(JSON.stringify(result, null, 2));
          }
        } else {
          console.log('Could not parse action from LLM response.');
        }
      }
    }

    return answer;
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