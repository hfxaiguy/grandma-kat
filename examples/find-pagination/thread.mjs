import { callTool } from '../lib/mcp.mjs';
import { callLlm } from '../lib/llm.mjs';
import { createLogger } from '../lib/logger.mjs';

const MAX_PAGES = 5;

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
 * Get cleaned HTML from scope.
 */
async function getHtml(client, scope) {
  return callTool(client, 'exec_js_in_scope', {
    scope,
    code: `(() => {
      const clone = element.cloneNode(true);
      clone.querySelectorAll('style, script').forEach(el => el.remove());
      return clone.innerHTML.substring(0, 8000);
    })()`,
  });
}

/**
 * Get current page state.
 */
async function getState(client, scope) {
  return callTool(client, 'exec_js_in_scope', {
    scope,
    code: `({
      url: location.href,
      textLength: element.innerText.length,
    })`,
  });
}

/**
 * Run pagination detection flow.
 */
async function runPaginationDetection({ scope, client, log }) {
  console.log(`\n=== Detecting pagination in scope: "${scope}" ===`);

  const html = await getHtml(client, scope);

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
${String(html).substring(0, 8000)}`;

  const step1Result = await callLlm([
    { role: 'user', content: step1Prompt }
  ]);
  log.logLlmCall('step1_describe', [{ role: 'user', content: step1Prompt }], step1Result);

  console.log(`Step 1 response:\n${step1Result.content}`);

  // Step 2: Isolate relevant HTML
  console.log('\n--- Step 2: Isolating relevant HTML ---');

  const step2Prompt = `Below is HTML from a webpage.

The LLM described this pagination:
${step1Result.content}

Extract ONLY the HTML that contains the pagination/navigation elements. Return just the HTML, nothing else.

HTML:
${String(html).substring(0, 8000)}`;

  const step2Result = await callLlm([
    { role: 'user', content: step2Prompt }
  ]);
  log.logLlmCall('step2_isolate', [{ role: 'user', content: step2Prompt }], step2Result);

  // Extract HTML from response
  let isolatedHtml = step2Result.content.match(/```(?:html)?\n([\s\S]*?)```/)?.[1]?.trim() ||
                     step2Result.content.match(/`([^`]+)`/)?.[1]?.trim() ||
                     step2Result.content.trim();

  console.log(`Isolated HTML:\n${isolatedHtml}`);

  // Step 3: Click a link
  console.log('\n--- Step 3: Click a pagination link ---');

  const state0 = await getState(client, scope);
  console.log('Before:', JSON.stringify(state0));

  const step3Prompt = `Below is HTML containing pagination/navigation links.

Click one of the links. Use element.querySelector() with the correct selector, then call .click() on it.

Rules:
- "element" is the scoped DOM node. Use element.querySelector() to find children.
- Just click the link. Do NOT wait for anything.
- Return ONLY the JavaScript code, no explanation.

HTML:
${isolatedHtml}`;

  const step3Result = await callLlm([
    { role: 'user', content: step3Prompt }
  ]);
  log.logLlmCall('step3_click', [{ role: 'user', content: step3Prompt }], step3Result);

  let code = step3Result.content.match(/```(?:javascript|js)?\n([\s\S]*?)```/)?.[1]?.trim() ||
             step3Result.content.match(/`([^`]+)`/)?.[1]?.trim() ||
             step3Result.content.trim();

  console.log(`Code: ${code}`);

  try {
    await callTool(client, 'exec_js_in_scope', {
      scope,
      code: `(async () => { ${code} })()`,
    });
  } catch (err) {
    console.log(`Error: ${err.message}`);
  }

  await new Promise(resolve => setTimeout(resolve, 2000));

  const state1 = await getState(client, scope);
  console.log('After:', JSON.stringify(state1));

  const firstChanged = state0.url !== state1.url || state0.textLength !== state1.textLength;
  console.log(firstChanged ? 'Navigation worked' : 'No change');

  if (!firstChanged) {
    return { success: false, reason: 'Could not navigate to a different page' };
  }

  // Step 4: Loop - ask LLM to go to next page
  console.log('\n--- Step 4: Navigate through pages ---');
  const memory = [{ action: code, result: state1.url }];

  for (let page = 2; page <= MAX_PAGES; page++) {
    console.log(`\nPage ${page} of ${MAX_PAGES}`);

    const currentHtml = await getHtml(client, scope);
    const currentState = await getState(client, scope);

    const step4Prompt = `You are on a webpage with pagination. You need to go to the next page.

Current URL: ${currentState.url}

What you've done so far:
${memory.map((m, i) => `${i + 1}. Clicked: ${m.action} → ${m.result}`).join('\n')}

Use element.querySelector() to find the next pagination link and click it.

Rules:
- "element" is the scoped DOM node. Use element.querySelector() to find children.
- Just click the link. Do NOT wait for anything.
- Return ONLY the JavaScript code, no explanation.

HTML:
${String(currentHtml).substring(0, 8000)}`;

    const step4Result = await callLlm([
      { role: 'user', content: step4Prompt }
    ]);
    log.logLlmCall(`step4_navigate_${page}`, [{ role: 'user', content: step4Prompt }], step4Result);

    let navCode = step4Result.content.match(/```(?:javascript|js)?\n([\s\S]*?)```/)?.[1]?.trim() ||
                  step4Result.content.match(/`([^`]+)`/)?.[1]?.trim() ||
                  step4Result.content.trim();

    console.log(`Code: ${navCode}`);

    const beforeState = await getState(client, scope);

    try {
      await callTool(client, 'exec_js_in_scope', {
        scope,
        code: `(async () => { ${navCode} })()`,
      });
    } catch (err) {
      console.log(`Error: ${err.message}`);
    }

    await new Promise(resolve => setTimeout(resolve, 2000));

    const afterState = await getState(client, scope);
    const changed = beforeState.url !== afterState.url || beforeState.textLength !== afterState.textLength;

    memory.push({ action: navCode, result: afterState.url });

    if (changed) {
      console.log(`Navigated to: ${afterState.url}`);
    } else {
      console.log('No change - stopping');
      break;
    }
  }

  return {
    success: true,
    description: step1Result.content,
    isolatedHtml,
    pagesVisited: memory.length,
    memory,
  };
}
