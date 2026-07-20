import { callTool } from '../lib/mcp.mjs';
import { callLlm } from '../lib/llm.mjs';
import { createLogger } from '../lib/logger.mjs';

const MAX_ELEMENTS = 10;
const MAX_TOKENS = 32000;
const MAX_STEP2_RETRIES = 3;

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
 * Get cleaned HTML from a scoped element (strips styles, scripts, nav, filters).
 */
async function getCleanedHtml(client, scope, maxChars = 20000) {
  return callTool(client, 'exec_js_in_scope', {
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
      return clone.innerHTML.substring(0, ${maxChars});
    })()`,
  });
}

/**
 * Find clickable/interactive elements within a scoped element.
 * Returns array of { tag, text, href, selector, listeners }
 */
async function findClickableInScope(client, scope) {
  return callTool(client, 'exec_js_in_scope', {
    scope,
    code: `(() => {
      const clickables = [];
      const selectors = 'a, button, [role="button"], [role="link"], [tabindex], [onclick], input[type="submit"], input[type="button"]';
      element.querySelectorAll(selectors).forEach((el, i) => {
        const tag = el.tagName.toLowerCase();
        const text = (el.innerText || el.textContent || '').trim().substring(0, 200);
        const href = el.href || el.getAttribute('href') || null;
        const cls = el.className && typeof el.className === 'string' ? el.className.trim() : '';
        const id = el.id || null;
        // Build a unique selector for this element
        let selector = tag;
        if (id) selector = '#' + id;
        else if (cls) selector = tag + '.' + cls.split(/\\s+/).join('.');
        else selector = tag + ':nth-child(' + (Array.from(el.parentNode.children).indexOf(el) + 1) + ')';
        
        if (text || href) {
          clickables.push({ tag, text: text.substring(0, 100), href, selector, index: i });
        }
      });
      return clickables;
    })()`,
  });
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

  // Step 2: Find repeating elements via LLM
  console.log('\n--- Step 2: Finding repeating elements ---');
  let selector = null;
  let step2Context = '';

  for (let attempt = 1; attempt <= MAX_STEP2_RETRIES; attempt++) {
    if (attempt > 1) console.log(`\nStep 2 retry ${attempt} of ${MAX_STEP2_RETRIES}...`);

    const scopeHtml = await getCleanedHtml(client, scope);
    const scopeHtmlStr = String(scopeHtml);
    console.log(`Scope HTML: ${scopeHtmlStr.length} chars`);

    const step2Prompt = `Below is HTML from a webpage element that lists multiple companies or people.

Find repeating elements that contain person or company information. Look for:
- Repeated tag patterns: "dl dt", "table tbody tr", "ul li"
- Repeated class names: ".member-card", ".listing-item"
- Elements that share the same class or structure

HTML:
${scopeHtmlStr}
${step2Context}
Return ONLY a single CSS selector that matches each listing item. No explanation.`;

    const step2Tokens = estimateTokens(step2Prompt);
    console.log(`Step 2 estimated tokens: ${step2Tokens}`);
    if (step2Tokens > MAX_TOKENS) {
      throw new Error(`Step 2 prompt too large: ${step2Tokens} estimated tokens exceeds ${MAX_TOKENS} limit`);
    }

    const step2Result = await callLlm([
      { role: 'user', content: step2Prompt }
    ]);
    log.logLlmCall(`step2_find_selector_${attempt}`, [{ role: 'user', content: step2Prompt }], step2Result);

    const step2Response = step2Result.content;
    console.log(`Step 2 response: ${step2Response}`);

    // Extract selector from response
    selector = step2Response.match(/`([^`]+)`/)?.[1] ||
               step2Response.match(/"([^"]+)"/)?.[1] ||
               step2Response.match(/'([^']+)'/)?.[1] ||
               step2Response.trim();

    selector = selector.replace(/^(css selector|selector|the selector|selector is|here is|here's):?\s*/i, '').trim();

    // Fix common LLM errors: spaces in class selectors should be dots
    // e.g., ".BlockRow actions-parent clickable" → ".BlockRow.actions-parent.clickable"
    if (selector.includes(' ') && !selector.includes('>') && !selector.includes('+') && !selector.includes('~')) {
      const parts = selector.split(/\s+/);
      // If first part starts with . or # or is a tag, join with dots
      if (parts[0].match(/^[.#]/)) {
        selector = parts[0] + '.' + parts.slice(1).map(p => p.replace(/^[.#]/, '')).join('.');
      } else if (parts[0].match(/^[a-z]/i)) {
        selector = parts.join('.');
      }
    }

    console.log(`Selector: "${selector}"`);

    // Step 3: Validate selector
    console.log('\n--- Step 3: Validating selector ---');
    const escapedSelector = selector.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

    const isValid = await callTool(client, 'exec_js_in_scope', {
      scope,
      code: `(() => { try { element.querySelectorAll('${escapedSelector}'); return true; } catch { return false; } })()`,
    });

    if (!isValid) {
      console.log(`Invalid selector: "${selector}"`);
      step2Context = `\nIMPORTANT: The selector "${selector}" was invalid for querySelectorAll. Use only valid CSS selectors (tag names, classes, IDs, combinators).`;
      continue;
    }

    // Check if it matches any elements
    const count = await callTool(client, 'exec_js_in_scope', {
      scope,
      code: `element.querySelectorAll('${escapedSelector}').length`,
    });

    if (count === 0) {
      console.log(`Selector "${selector}" matched 0 elements`);
      step2Context = `\nIMPORTANT: The selector "${selector}" matched 0 elements. Find a different selector that matches the repeating listing items.`;
      continue;
    }

    console.log(`Selector "${selector}" matched ${count} elements`);
    break;
  }

  if (!selector) {
    return { success: false, reason: 'Could not find a valid selector after retries' };
  }

  // Get elements and their inner text
  console.log('\n--- Getting element text ---');
  const escapedSelector = selector.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const elements = await callTool(client, 'exec_js_in_scope', {
    scope,
    code: `Array.from(element.querySelectorAll('${escapedSelector}')).slice(0, ${maxElements}).map((el, i) => ({
      index: i,
      text: el.innerText.trim().substring(0, 500),
      html: el.outerHTML.substring(0, 1000)
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

    // 4.1: What types of information are present?
    const step4_1Prompt = `Look at this text from a webpage element:

${el.text}

What TYPES of information are available about this person or company? Look for:
- Names (person, company, organization)
- Addresses (street, city, postal code)
- Contact info (phone, email, fax)
- Social media links (Facebook, LinkedIn, Twitter, Instagram)
- Web links (website, profile page)
- Descriptions or bios
- Categories or tags
- Dates or hours

List the types of information you can see. Be specific.`;

    const step4_1Result = await callLlm([
      { role: 'user', content: step4_1Prompt }
    ]);
    log.logLlmCall(`step4_1_info_types_${el.index}`, [{ role: 'user', content: step4_1Prompt }], step4_1Result);

    const step4_1Response = step4_1Result.content;
    console.log(`  Info types: ${step4_1Response.substring(0, 150)}`);

    // 4.2: Is there more information available? (with clickable elements)
    console.log('  Finding clickable elements in this item...');
    const elClickablesFor42 = await callTool(client, 'exec_js_in_scope', {
      scope,
      code: `(() => {
        const target = element.querySelectorAll('${escapedSelector}')[${el.index}];
        if (!target) return [];
        const clickables = [];
        const selectors = 'a, button, [role="button"], [role="link"], [tabindex], [onclick], [data-event]';

        // Check if the outer element itself is clickable
        const outerEvent = target.getAttribute('data-event');
        const outerHref = target.href || target.getAttribute('href');
        if (outerEvent || outerHref || target.onclick) {
          const tag = target.tagName.toLowerCase();
          const text = (target.innerText || '').trim().substring(0, 100);
          clickables.push({
            tag,
            text: text.substring(0, 60),
            href: outerHref || null,
            event: outerEvent || null,
            isOuter: true,
          });
        }

        // Check descendants
        target.querySelectorAll(selectors).forEach((c, i) => {
          const tag = c.tagName.toLowerCase();
          const text = (c.innerText || c.textContent || '').trim().substring(0, 100);
          const href = c.href || c.getAttribute('href') || null;
          const event = c.getAttribute('data-event') || null;
          if (text || href || event) {
            clickables.push({ tag, text, href, event, isOuter: false });
          }
        });
        return clickables;
      })()`,
    });
    const clickableText = Array.isArray(elClickablesFor42) && elClickablesFor42.length > 0
      ? elClickablesFor42.map((c, i) => {
          const outer = c.isOuter ? ' [this item]' : '';
          const evt = c.event ? ` (event: ${c.event.substring(0, 60)})` : '';
          return `${i + 1}. <${c.tag}> "${c.text}" ${c.href ? '→ ' + c.href : ''}${evt}${outer}`;
        }).join('\n')
      : 'No clickable elements in this item.';

    const step4_2Prompt = `Look at this element text:

${el.text}

Clickable elements in this listing item:
${clickableText}

Is there a way to get more details about this person/company?
- Can you click a link to see a full profile?
- Is there a "More Information" or "View Details" button?
- Are there links to social media or websites not shown in the text?

Answer "yes" if you see a way to get more info, "no" if this seems complete.`;

    const step4_2Result = await callLlm([
      { role: 'user', content: step4_2Prompt }
    ]);
    log.logLlmCall(`step4_2_more_info_${el.index}`, [{ role: 'user', content: step4_2Prompt }], step4_2Result);

    const step4_2Response = step4_2Result.content;
    const hasMoreInfo = step4_2Response.toLowerCase().includes('yes');

    if (hasMoreInfo) {
      // 4.3: What action to perform? (with HTML, event listeners, and tool calling)
      console.log('  Getting HTML and listeners for action...');

      // Find clickable elements within this specific element
      const elClickables = await callTool(client, 'exec_js_in_scope', {
        scope,
        code: `(() => {
          const target = element.querySelectorAll('${escapedSelector}')[${el.index}];
          if (!target) return [];
          const clickables = [];
          const selectors = 'a, button, [role="button"], [role="link"], [tabindex], [onclick]';
          target.querySelectorAll(selectors).forEach((el, i) => {
            const tag = el.tagName.toLowerCase();
            const text = (el.innerText || el.textContent || '').trim().substring(0, 100);
            const href = el.href || el.getAttribute('href') || null;
            const cls = el.className && typeof el.className === 'string' ? el.className.trim() : '';
            const id = el.id || null;
            let selector = tag;
            if (id) selector = '#' + id;
            else if (cls) selector = tag + '.' + cls.split(/\\s+/).join('.');
            if (text || href) {
              clickables.push({ tag, text, href, selector });
            }
          });
          return clickables;
        })()`,
      });

      const elClickableText = Array.isArray(elClickables) && elClickables.length > 0
        ? elClickables.map((c, i) => `${i + 1}. <${c.tag}> "${c.text}" ${c.href ? '→ ' + c.href : ''} [selector: ${c.selector}]`).join('\n')
        : 'No clickable elements in this item.';

      const step4_3Prompt = `Look at this element:

Text: ${el.text}

HTML: ${el.html}

Clickable elements in this item:
${elClickableText}

What action should I take to get more information about this person/company?

Choose ONE action:
- "navigate" if there's a URL to visit
- "click" if there's a button or link to click

Call the appropriate tool with the target.`;

      const step4_3Result = await callLlm([
        { role: 'user', content: step4_3Prompt }
      ], {
        tools: [
          {
            type: 'function',
            function: {
              name: 'navigate',
              description: 'Navigate to a URL to get more information.',
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
              description: 'Click an element by its CSS selector.',
              parameters: {
                type: 'object',
                properties: {
                  selector: { type: 'string', description: 'CSS selector of the element to click.' },
                },
                required: ['selector'],
              },
            },
          },
        ],
      });
      log.logLlmCall(`step4_3_action_${el.index}`, [{ role: 'user', content: step4_3Prompt }], step4_3Result);

      const step4_3Response = step4_3Result.content;
      const toolCall = step4_3Result.tool_calls?.[0];
      console.log(`  Action: ${step4_3Response?.substring(0, 100) || 'tool call'}`);
      if (toolCall) {
        console.log(`  Tool: ${toolCall.function.name}(${toolCall.function.arguments})`);
      }

      results.push({
        element_index: el.index,
        text: el.text,
        info_types: step4_1Response,
        has_more: true,
        action: step4_3Response,
        tool_call: toolCall ? {
          name: toolCall.function.name,
          arguments: JSON.parse(toolCall.function.arguments),
        } : null,
      });
    } else {
      results.push({
        element_index: el.index,
        text: el.text,
        info_types: step4_1Response,
        has_more: false,
      });
    }
  }

  console.log('\n=== Results ===');
  console.log(JSON.stringify(results, null, 2));

  return { success: true, results };
}
