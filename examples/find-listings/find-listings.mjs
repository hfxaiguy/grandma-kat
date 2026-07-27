import { startScrapeServer, callTool, stopScrapeServer } from '../lib/mcp.mjs';
import { callLlm, setProvider } from '../lib/llm.mjs';
import { createLogger } from '../lib/logger.mjs';

const MAX_ELEMENTS = 10;
const MAX_TOKENS = 32000;

function estimateTokens(str) {
  return Math.ceil(str.length / 4);
}

export async function runFindListings() {
  setProvider('local');
  const log = createLogger('find-listings');
  console.log(`Run ID: ${log.runId}`);
  console.log(`Logs: ${log.logDir}`);

  console.log('Starting scrape MCP server...');
  const client = await startScrapeServer();
  try {
    // Step 1: Check if this page lists companies or people
    console.log('\n=== Step 1: Is this a listing page? ===');
    const currentUrl = await callTool(client, 'exec_js', { code: 'location.href' });
    const currentTitle = await callTool(client, 'exec_js', { code: 'document.title' });
    console.log(`Page: ${currentTitle} - ${currentUrl}`);

    const pageText = await callTool(client, 'exec_js', {
      code: `document.body.innerText.trim().substring(0, 3000)`
    });
    console.log(`Dumped ${String(pageText).length} chars.`);

    const step1Prompt = `Below is text from a webpage.

Does this page list multiple companies or people?

Common examples: business directory, team page, staff list, member list, search results, product catalog.

Page text:
${pageText}

Answer ONLY "yes" or "no".`;

    const step1Result = await callLlm([
      { role: 'user', content: step1Prompt }
    ]);
    log.logLlmCall('step1_listing_check', [{ role: 'user', content: step1Prompt }], step1Result);

    const step1Response = step1Result.content;
    console.log(`Step 1 response: ${step1Response}`);

    const isListing = step1Response.toLowerCase().trim() === 'yes';
    
    if (!isListing) {
      console.log('Not a listing page. Stopping.');
      return { success: false, reason: 'Not a listing page' };
    }

    console.log('Page appears to be a listing page.');

    // Step 2: Find repeating elements — use body HTML
    console.log('\n=== Step 2: Finding repeating elements ===');
    const bodyHtml = await callTool(client, 'exec_js', {
      code: `document.body.innerHTML.substring(0, 100000)`
    });
    const bodyHtmlStr = String(bodyHtml);
    console.log(`Body HTML: ${bodyHtmlStr.length} chars`);

    const step2Prompt = `Below is the HTML of a webpage body that lists multiple companies or people.

Find a CSS selector that matches EACH repeating item in the list. Examples:
- If items are in a grid: "div.card" or ".team-member"
- If items are in a table: "table tbody tr"
- If items are in a list: "ul li" or ".listing-item"

HTML:
${bodyHtmlStr}

Return ONLY a single CSS selector. No explanation.`;

    const step2Tokens = estimateTokens(step2Prompt);
    console.log(`Step 2 estimated tokens: ${step2Tokens}`);
    if (step2Tokens > MAX_TOKENS) {
      throw new Error(`Step 2 prompt too large: ${step2Tokens} estimated tokens exceeds ${MAX_TOKENS} limit`);
    }

    const step2Result = await callLlm([
      { role: 'user', content: step2Prompt }
    ]);
    log.logLlmCall('step2_find_selector', [{ role: 'user', content: step2Prompt }], step2Result);

    const step2Response = step2Result.content;
    console.log(`Step 2 response: ${step2Response}`);

    // Extract selector from response
    let selector = step2Response.match(/`([^`]+)`/)?.[1] || 
                   step2Response.match(/"([^"]+)"/)?.[1] || 
                   step2Response.match(/'([^']+)'/)?.[1] || 
                   step2Response.trim();

    // Clean up common prefixes
    selector = selector.replace(/^(css selector|selector|the selector|selector is|here is|here's):?\s*/i, '').trim();
    
    console.log(`Selector: "${selector}"`);

    // Step 3: Get elements and their inner text
    console.log('\n=== Step 3: Getting element text ===');
    const elements = await callTool(client, 'exec_js', {
      code: `Array.from(document.querySelectorAll('${selector}')).slice(0, ${MAX_ELEMENTS}).map((el, i) => ({
        index: i,
        text: el.innerText.trim().substring(0, 500)
      }))`
    });

    const elementData = typeof elements === 'string' ? JSON.parse(elements) : elements;
    console.log(`Found ${elementData.length} elements`);

    if (elementData.length === 0) {
      return { success: false, reason: 'No elements found with selector' };
    }

    // Step 4: Analyze each element
    console.log('\n=== Step 4: Analyzing elements ===');
    const results = [];

    for (const el of elementData) {
      console.log(`\n--- Element ${el.index + 1} ---`);
      console.log(`Text preview: ${el.text.substring(0, 100)}...`);

      // 4.1: What information is present?
      const step4_1Prompt = `Look at this text from a webpage element:

${el.text}

What information is available about this person or company?

List ONLY the information you can see. No guessing.`;

      const step4_1Result = await callLlm([
        { role: 'user', content: step4_1Prompt }
      ]);
      log.logLlmCall(`step4_1_info_${el.index}`, [{ role: 'user', content: step4_1Prompt }], step4_1Result);

      const step4_1Response = step4_1Result.content;
      console.log(`Info found: ${step4_1Response.substring(0, 200)}`);

      // 4.2: Is there more information available?
      const step4_2Prompt = `Look at this text:

${el.text}

Is there a way to get more details about this person/company?
- Look for links (like "View profile", "Read more", "Contact")
- Look for clickable elements
- Look for text that suggests more content

Answer "yes" if you see a way to get more info, "no" if this seems complete.`;

      const step4_2Result = await callLlm([
        { role: 'user', content: step4_2Prompt }
      ]);
      log.logLlmCall(`step4_2_more_info_${el.index}`, [{ role: 'user', content: step4_2Prompt }], step4_2Result);

      const step4_2Response = step4_2Result.content;
      console.log(`Step 4.2 response: ${step4_2Response}`);

      const hasMoreInfo = step4_2Response.toLowerCase().includes('yes');

      if (hasMoreInfo) {
        // 4.3: What action to perform?
        const step4_3Prompt = `Look at this text:

${el.text}

What action should I take to get more information?
- If there's a link, what text should I click?
- If there's a button, what does it say?
- If there's a URL, what is it?

Return the action to perform.`;

        const step4_3Result = await callLlm([
          { role: 'user', content: step4_3Prompt }
        ]);
        log.logLlmCall(`step4_3_action_${el.index}`, [{ role: 'user', content: step4_3Prompt }], step4_3Result);

        const step4_3Response = step4_3Result.content;
        console.log(`Action: ${step4_3Response.substring(0, 200)}`);
        
        results.push({
          element_index: el.index,
          info: step4_1Response,
          has_more: true,
          action: step4_3Response
        });
      } else {
        results.push({
          element_index: el.index,
          info: step4_1Response,
          has_more: false
        });
      }
    }

    console.log('\n=== Results ===');
    console.log(JSON.stringify(results, null, 2));

    return { success: true, results };

  } finally {
    await stopScrapeServer(client);
  }
}
