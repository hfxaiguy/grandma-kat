import { callTool } from '../lib/mcp.mjs';
import { callLlm } from '../lib/llm.mjs';
import { createLogger } from '../lib/logger.mjs';

const MAX_ELEMENTS = 10;
const MAX_TOKENS = 32000;

function estimateTokens(str) {
  return Math.ceil(str.length / 4);
}

/**
 * Create a scoped find-listings thread.
 *
 * @param {Object} options
 * @param {string} [options.scope='body'] - CSS selector for the scope element or iframe
 * @param {Object} options.client - MCP client (from startScrapeServer)
 * @param {Object} [options.log] - Logger instance (creates one if not provided)
 * @param {number} [options.maxElements=10] - Max elements to analyze
 * @returns {{ run: () => Promise<{ success: boolean, results?: Array, reason?: string }> }}
 */
export function createFindListingsThread(options = {}) {
  const {
    scope = 'body',
    client,
    log = createLogger('find-listings'),
    maxElements = MAX_ELEMENTS,
  } = options;

  return {
    run: () => runFindListings({ scope, client, log, maxElements }),
  };
}

/**
 * Run the find-listings flow on a scoped element or iframe.
 *
 * @param {Object} options
 * @param {string} options.scope - CSS selector for the scope element or iframe
 * @param {Object} options.client - MCP client
 * @param {Object} options.log - Logger
 * @param {number} options.maxElements - Max elements to analyze
 * @returns {Promise<{ success: boolean, results?: Array, reason?: string }>}
 */
async function runFindListings({ scope, client, log, maxElements }) {
  console.log(`\n=== Finding listings in scope: "${scope}" ===`);

  // Step 1: Check if this scope contains a listing
  console.log('\n--- Step 1: Is this a listing? ---');
  const scopeText = await callTool(client, 'exec_js_in_scope', {
    scope,
    code: `element.innerText.trim().substring(0, 3000)`,
  });
  console.log(`Scope text: ${String(scopeText).length} chars`);

  const step1Prompt = `Below is text from a webpage element.

Does this element contain a list of multiple companies or people?

Common examples: business directory, team page, staff list, member list, search results, product catalog.

Text:
${scopeText}

Answer ONLY "yes" or "no".`;

  const step1Result = await callLlm([
    { role: 'user', content: step1Prompt }
  ]);
  log.logLlmCall('step1_listing_check', [{ role: 'user', content: step1Prompt }], step1Result);

  const step1Response = step1Result.content;
  console.log(`Step 1 response: ${step1Response}`);

  const isListing = step1Response.toLowerCase().trim() === 'yes';

  if (!isListing) {
    console.log('Not a listing. Stopping.');
    return { success: false, reason: 'Not a listing' };
  }

  console.log('Scope contains a listing.');

  // Step 2: Find repeating elements — try programmatic first, then LLM
  console.log('\n--- Step 2: Finding repeating elements ---');

  // Programmatic: find elements that repeat with the same tag+class pattern
  const candidateSelector = await callTool(client, 'exec_js_in_scope', {
    scope,
    code: `(() => {
      // Find all elements with text, group by tag+class
      const groups = {};
      element.querySelectorAll('*').forEach(el => {
        const text = el.innerText?.trim();
        if (!text || text.length < 10 || text.length > 500) return;
        const tag = el.tagName.toLowerCase();
        const cls = el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).join('.') : '';
        const key = tag + cls;
        if (!groups[key]) groups[key] = { count: 0, avgLen: 0 };
        groups[key].count++;
        groups[key].avgLen += text.length;
      });
      // Calculate avg text length per group
      Object.values(groups).forEach(g => g.avgLen = Math.round(g.avgLen / g.count));
      // Return selectors that match 5+ elements, sorted by avg text length (prefer richer elements)
      const candidates = Object.entries(groups)
        .filter(([_, g]) => g.count >= 5)
        .sort((a, b) => b[1].avgLen - a[1].avgLen)
        .slice(0, 10)
        .map(([sel, g]) => sel + ' (' + g.count + ', avg ' + g.avgLen + ' chars)');
      return candidates;
    })()`,
  });
  console.log('Candidate selectors:', candidateSelector);

  let selector;

  // If programmatic found candidates, try them in order
  if (Array.isArray(candidateSelector) && candidateSelector.length > 0) {
    // Parse the first candidate (e.g., "dl.BlockRows.dt (150)")
    selector = candidateSelector[0].split(' (')[0];
    console.log(`Trying programmatic selector: "${selector}"`);

    // Validate it
    const count = await callTool(client, 'exec_js_in_scope', {
      scope,
      code: `element.querySelectorAll('${selector.replace(/'/g, "\\'")}').length`,
    });

    if (count === 0) {
      // Try the next candidates
      for (let i = 1; i < candidateSelector.length; i++) {
        selector = candidateSelector[i].split(' (')[0];
        const c = await callTool(client, 'exec_js_in_scope', {
          scope,
          code: `element.querySelectorAll('${selector.replace(/'/g, "\\'")}').length`,
        });
        if (c > 0) break;
      }
    }
  }

  // Fallback to LLM if programmatic didn't work
  if (!selector) {
    console.log('Programmatic approach found no candidates. Falling back to LLM...');
    const scopeHtml = await callTool(client, 'exec_js_in_scope', {
      scope,
      code: `(() => {
        const clone = element.cloneNode(true);
        clone.querySelectorAll('style, script, link[rel="stylesheet"], nav, .filterBar, .SearchBar, .AdvancedFilter').forEach(el => el.remove());
        clone.querySelectorAll('*').forEach(el => {
          const keep = ['class', 'id', 'href', 'src'];
          [...el.attributes].forEach(a => {
            if (!keep.includes(a.name)) el.removeAttribute(a.name);
          });
        });
        return clone.innerHTML.substring(0, 20000);
      })()`,
    });
    const scopeHtmlStr = String(scopeHtml);
    console.log(`Scope HTML: ${scopeHtmlStr.length} chars`);

    const step2Prompt = `Below is HTML from a webpage element that lists multiple companies or people.

Find a CSS selector that matches EACH repeating item in the list. Look for:
- Repeated tag patterns: "dl dt", "table tbody tr", "ul li"
- Repeated class names: ".member-card", ".listing-item"
- Elements that share the same class or structure

HTML:
${scopeHtmlStr}

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

    selector = step2Response.match(/\`([^\`]+)\`/)?.[1] ||
               step2Response.match(/"([^"]+)"/)?.[1] ||
               step2Response.match(/'([^']+)'/)?.[1] ||
               step2Response.trim();

    selector = selector.replace(/^(css selector|selector|the selector|selector is|here is|here's):?\s*/i, '').trim();
  }

  console.log(`Selector: "${selector}"`);

  // Step 3: Get elements and their inner text (scoped)
  console.log('\n--- Step 3: Getting element text ---');

  // Escape the selector for safe JS embedding
  const escapedSelector = selector.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

  // Validate the selector first
  const isValid = await callTool(client, 'exec_js_in_scope', {
    scope,
    code: `(() => { try { element.querySelectorAll('${escapedSelector}'); return true; } catch { return false; } })()`,
  });

  if (!isValid) {
    console.log(`Invalid selector: "${selector}". Trying fallback...`);
    // Fallback: ask the LLM for a simpler selector
    const fallbackPrompt = `The CSS selector "${selector}" is not valid for querySelectorAll.

Give me a simpler CSS selector. Use only tag names, classes, or IDs. Examples:
- "dl dt"
- ".member-item"
- "tr"
- "li"

Return ONLY the selector. No explanation.`;

    const fallbackResult = await callLlm([
      { role: 'user', content: fallbackPrompt }
    ]);
    log.logLlmCall('step3_fallback_selector', [{ role: 'user', content: fallbackPrompt }], fallbackResult);

    selector = fallbackResult.content.match(/`([^`]+)`/)?.[1] ||
               fallbackResult.content.match(/"([^"]+)"/)?.[1] ||
               fallbackResult.content.match(/'([^']+)'/)?.[1] ||
               fallbackResult.content.trim();
    selector = selector.replace(/^(css selector|selector|the selector|selector is|here is|here's):?\s*/i, '').trim();
    console.log(`Fallback selector: "${selector}"`);
  }

  const elements = await callTool(client, 'exec_js_in_scope', {
    scope,
    code: `Array.from(element.querySelectorAll('${selector.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}')).slice(0, ${maxElements}).map((el, i) => ({
      index: i,
      text: el.innerText.trim().substring(0, 500)
    }))`,
  });

  const elementData = typeof elements === 'string' ? JSON.parse(elements) : elements;
  console.log(`Found ${elementData.length} elements`);

  if (elementData.length === 0) {
    return { success: false, reason: 'No elements found with selector' };
  }

  // Step 4: Analyze each element
  console.log('\n--- Step 4: Analyzing elements ---');
  const results = [];

  for (const el of elementData) {
    console.log(`\n  Element ${el.index + 1}: "${el.text.substring(0, 80)}..."`);

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
    console.log(`  Info: ${step4_1Response.substring(0, 100)}`);

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
      console.log(`  Action: ${step4_3Response.substring(0, 100)}`);

      results.push({
        element_index: el.index,
        text: el.text,
        info: step4_1Response,
        has_more: true,
        action: step4_3Response,
      });
    } else {
      results.push({
        element_index: el.index,
        text: el.text,
        info: step4_1Response,
        has_more: false,
      });
    }
  }

  console.log('\n=== Results ===');
  console.log(JSON.stringify(results, null, 2));

  return { success: true, results };
}
