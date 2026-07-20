import { callTool } from '../lib/mcp.mjs';
import { callLlm, setProvider } from '../lib/llm.mjs';
import { createLogger } from '../lib/logger.mjs';

const MAX_RETRIES = 3;

/**
 * Create a pagination detection thread.
 */
export function createPaginationThread(options = {}) {
  const {
    scope = 'body',
    client,
    log = createLogger('find-pagination'),
  } = options;

  return {
    run: () => runPaginationDetection({ scope, client, log }),
  };
}

/**
 * Run pagination detection flow.
 */
async function runPaginationDetection({ scope, client, log }) {
  console.log(`\n=== Detecting pagination in scope: "${scope}" ===`);

  // Get cleaned HTML for LLM - strip styles, scripts, and filters
  const scopeHtml = await callTool(client, 'exec_js_in_scope', {
    scope,
    code: `(() => {
      const clone = element.cloneNode(true);
      clone.querySelectorAll('style, script, .filterBar, .AdvancedFilter, .SearchBar').forEach(el => el.remove());
      return clone.innerHTML.substring(0, 8000);
    })()`,
  });

  // Step 1: Is there pagination? What elements?
  console.log('\n--- Step 1: Is there pagination? ---');

  const step1Prompt = `Below is HTML from a webpage.

Look at this HTML and describe anything that could be pagination or navigation between pages/sections. This includes:
- Letter-based navigation (A, B, C...)
- Page numbers
- Next/prev buttons
- "Load more" buttons
- Any repeated links that look like navigation

Just describe what you see. Don't look for specific class names, just describe the structure and what it looks like it does.

HTML:
${String(scopeHtml).substring(0, 8000)}`;

  const step1Result = await callLlm([
    { role: 'user', content: step1Prompt }
  ]);
  log.logLlmCall('step1_has_pagination', [{ role: 'user', content: step1Prompt }], step1Result);

  const step1Response = step1Result.content;
  console.log(`Step 1 response:\n${step1Response}`);

  if (step1Response.trim().toLowerCase() === 'no') {
    console.log('No pagination detected. Stopping.');
    return { success: false, reason: 'No pagination detected' };
  }

  // Step 2: What type of pagination?
  console.log('\n--- Step 2: Identifying pagination type ---');

  const step2Prompt = `Look at this pagination description:

${step1Response}

What type of pagination is this? Choose ONE:
- "traditional" - page numbers and/or next/prev buttons that navigate to new pages
- "load_more" - "Load more" or "Show more" button that adds content to the same page
- "infinite_scroll" - automatically loads more content when scrolling down
- "carousel" - left/right arrows to navigate between items
- "alphabetical" - letter-based navigation (A, B, C, etc.)

Respond with ONLY the type name, nothing else.`;

  const step2Result = await callLlm([
    { role: 'user', content: step2Prompt }
  ]);
  log.logLlmCall('step2_pagination_type', [{ role: 'user', content: step2Prompt }], step2Result);

  const paginationTypeRaw = step2Result.content.toLowerCase().trim();
  const paginationType = paginationTypeRaw.match(/traditional|load_more|infinite_scroll|carousel|alphabetical/)?.[0] || 'unknown';
  console.log(`Pagination type: ${paginationType}`);

  // Step 3 & 4: Generate, execute, and verify pagination code in a retry loop
  console.log('\n--- Step 3 & 4: Generate and verify pagination code ---');

  let codeTemplate = '';
  let executionResult = null;
  let stateChanged = false;
  let beforeState = null;
  let afterState = null;
  let failureContext = '';

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 1) console.log(`\nRetry ${attempt} of ${MAX_RETRIES}...`);

    // Capture before state
    beforeState = await callTool(client, 'exec_js_in_scope', {
      scope,
      code: `({
        url: location.href,
        childCount: element.children.length,
        scrollHeight: element.scrollHeight,
        textLength: element.innerText.length,
      })`,
    });
    console.log('Before state:', JSON.stringify(beforeState));

    // Ask LLM to generate code
    // "element" is the scoped DOM node. Use element.querySelector() to find children.
    const step3Prompt = `Pagination type: ${paginationType}

Pagination elements found:
${step1Response}

Generate JavaScript code to interact with this pagination.

Rules:
- "element" is the scoped DOM node. Use element.querySelector() to find children.
- Return an object: { action: "click"|"navigate", selector: "css selector" } or { action: "navigate", url: "https://..." }
- Do NOT wait for page load. Just perform the click or navigation.
- Do NOT define functions. Just write the body code.
- Return ONLY the code, no explanation.
${failureContext}`;

    const step3Result = await callLlm([
      { role: 'user', content: step3Prompt }
    ]);
    log.logLlmCall(`step3_generate_code_${attempt}`, [{ role: 'user', content: step3Prompt }], step3Result);

    // Extract code from response
    codeTemplate = step3Result.content.match(/```(?:javascript|js)?\n([\s\S]*?)```/)?.[1]?.trim() ||
                   step3Result.content.match(/`([^`]+)`/)?.[1]?.trim() ||
                   step3Result.content.trim();

    console.log(`\nGenerated code (attempt ${attempt}):`);
    console.log(codeTemplate);

    // Execute the code
    console.log('\nExecuting...');
    try {
      executionResult = await callTool(client, 'exec_js_in_scope', {
        scope,
        code: `(async () => { ${codeTemplate} })()`,
      });
      console.log('Execution result:', JSON.stringify(executionResult));
    } catch (err) {
      console.log(`Execution error: ${err.message}`);
      executionResult = { error: err.message };
    }

    // Wait briefly for navigation/click to take effect
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Capture after state
    afterState = await callTool(client, 'exec_js_in_scope', {
      scope,
      code: `({
        url: location.href,
        childCount: element.children.length,
        scrollHeight: element.scrollHeight,
        textLength: element.innerText.length,
      })`,
    });
    console.log('After state:', JSON.stringify(afterState));

    // Check if state changed
    stateChanged =
      beforeState.url !== afterState.url ||
      beforeState.childCount !== afterState.childCount ||
      beforeState.scrollHeight !== afterState.scrollHeight ||
      beforeState.textLength !== afterState.textLength;

    if (stateChanged) {
      console.log('Pagination verified - content changed');
      break;
    }

    // Build failure context for retry
    const hasError = executionResult?.error || executionResult?.success === false;

    if (hasError) {
      console.log(`Execution failed. Feeding error back to LLM...`);
      failureContext = `\nPREVIOUS ATTEMPT FAILED:
Code: ${codeTemplate}
Error: ${JSON.stringify(executionResult)}
Fix the code and try again.`;
    } else {
      console.log(`No state change detected. The code ran but didn't trigger pagination.`);
      failureContext = `\nPREVIOUS ATTEMPT DID NOT WORK:
Code: ${codeTemplate}
Result: ${JSON.stringify(executionResult)}
Before: ${JSON.stringify(beforeState)}
After: ${JSON.stringify(afterState)}
The page did not change. Try a different selector or approach.`;
    }
  }

  return {
    success: stateChanged,
    paginationType,
    code: codeTemplate,
    verified: stateChanged,
    attempts: MAX_RETRIES,
    beforeState,
    afterState,
    executionResult,
  };
}
