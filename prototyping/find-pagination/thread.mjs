import { callTool } from '../lib/mcp.mjs';
import { callLlm } from '../lib/llm.mjs';
import { createLogger } from '../lib/logger.mjs';

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

  // Get cleaned HTML
  const scopeHtml = await callTool(client, 'exec_js_in_scope', {
    scope,
    code: `(() => {
      const clone = element.cloneNode(true);
      clone.querySelectorAll('style, script').forEach(el => el.remove());
      return clone.innerHTML.substring(0, 8000);
    })()`,
  });

  // Step 1: Describe what could be pagination
  console.log('\n--- Step 1: Describing pagination elements ---');

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
  log.logLlmCall('step1_describe', [{ role: 'user', content: step1Prompt }], step1Result);

  console.log(`Step 1 response:\n${step1Result.content}`);

  // Capture before state
  const beforeState = await callTool(client, 'exec_js_in_scope', {
    scope,
    code: `({
      url: location.href,
      childCount: element.children.length,
      textLength: element.innerText.length,
    })`,
  });
  console.log('\nBefore state:', JSON.stringify(beforeState));

  // Step 2: Ask LLM to navigate to a different page
  console.log('\n--- Step 2: Navigate to a different page ---');

  const step2Prompt = `Below is HTML from a webpage.

What the LLM saw:
${step1Result.content}

Click one of the letter links to go to a different page. Use element.querySelector() with the correct selector, then call .click() on it.

Rules:
- "element" is the scoped DOM node. Use element.querySelector() to find children.
- Just click the link. Do NOT wait for anything.
- Return ONLY the JavaScript code, no explanation.

HTML:
${String(scopeHtml).substring(0, 8000)}`;

  const step2Result = await callLlm([
    { role: 'user', content: step2Prompt }
  ]);
  log.logLlmCall('step2_navigate', [{ role: 'user', content: step2Prompt }], step2Result);

  // Extract code
  let code = step2Result.content.match(/```(?:javascript|js)?\n([\s\S]*?)```/)?.[1]?.trim() ||
             step2Result.content.match(/`([^`]+)`/)?.[1]?.trim() ||
             step2Result.content.trim();

  console.log(`Generated code:\n${code}`);

  // Execute
  console.log('\nExecuting...');
  try {
    const result = await callTool(client, 'exec_js_in_scope', {
      scope,
      code: `(async () => { ${code} })()`,
    });
    console.log('Result:', JSON.stringify(result));
  } catch (err) {
    console.log(`Error: ${err.message}`);
  }

  // Wait for navigation
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Step 3: Verify DOM changed
  console.log('\n--- Step 3: Verify DOM changed ---');

  const afterState = await callTool(client, 'exec_js_in_scope', {
    scope,
    code: `({
      url: location.href,
      childCount: element.children.length,
      textLength: element.innerText.length,
    })`,
  });
  console.log('After state:', JSON.stringify(afterState));

  const changed =
    beforeState.url !== afterState.url ||
    beforeState.childCount !== afterState.childCount ||
    beforeState.textLength !== afterState.textLength;

  if (changed) {
    console.log('Pagination verified - DOM changed');
  } else {
    console.log('No change detected');
  }

  // Step 3: Ask LLM to write a reusable function
  console.log('\n--- Step 3: Write a function to navigate to next page ---');

  const step3Prompt = `The following code was used to click a letter pagination link and it worked:

${code}

Write a reusable function called navigateToNextPage that:
1. Finds the currently active letter
2. Clicks the next letter in the sequence
3. Returns which letter it navigated to

Rules:
- "element" is the scoped DOM node. Use element.querySelector() to find children.
- The active link has class "active"
- Return ONLY the function code, no explanation.

HTML:
${String(scopeHtml).substring(0, 8000)}`;

  const step3Result = await callLlm([
    { role: 'user', content: step3Prompt }
  ]);
  log.logLlmCall('step3_write_function', [{ role: 'user', content: step3Prompt }], step3Result);

  let functionCode = step3Result.content.match(/```(?:javascript|js)?\n([\s\S]*?)```/)?.[1]?.trim() ||
                     step3Result.content.match(/`([^`]+)`/)?.[1]?.trim() ||
                     step3Result.content.trim();

  console.log(`Generated function:\n${functionCode}`);

  // Capture before state
  const beforeState2 = await callTool(client, 'exec_js_in_scope', {
    scope,
    code: `({
      url: location.href,
      textLength: element.innerText.length,
    })`,
  });
  console.log('\nBefore state:', JSON.stringify(beforeState2));

  // Execute the function
  console.log('\nExecuting...');
  try {
    const result = await callTool(client, 'exec_js_in_scope', {
      scope,
      code: `(async () => { ${functionCode} return navigateToNextPage(); })()`,
    });
    console.log('Result:', JSON.stringify(result));
  } catch (err) {
    console.log(`Error: ${err.message}`);
  }

  // Wait for navigation
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Verify
  const afterState2 = await callTool(client, 'exec_js_in_scope', {
    scope,
    code: `({
      url: location.href,
      textLength: element.innerText.length,
    })`,
  });
  console.log('After state:', JSON.stringify(afterState2));

  const changed2 = beforeState2.url !== afterState2.url || beforeState2.textLength !== afterState2.textLength;

  if (changed2) {
    console.log('Navigation verified - DOM changed');
  } else {
    console.log('No change detected');
  }

  return {
    success: changed,
    description: step1Result.content,
    clickCode: code,
    functionCode,
    beforeState,
    afterState,
  };
}
