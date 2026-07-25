// find-address — a grandma-kat tree that finds a business address on a website.
//
// WHAT THIS DOES (plain English):
//
//   Imagine you're browsing a website looking for a company's street address.
//   You'd look at the page, check if the address is right there, and if not,
//   you'd click promising links (like "Contact" or "Locations") and check
//   those pages instead. That's exactly what this tree does — it automates
//   that browsing strategy.
//
//   The tree is a loop that repeats up to 3 times. Each time through the
//   loop, it:
//
//   1. Looks at the current page and asks an AI: "Is there an address here?"
//   2. If yes → done! Return the address.
//   3. If no → scan the page for things to click (links, buttons).
//   4. Ask the AI to pick the most promising thing to click.
//   5. Click it, wait for the new page to load, and repeat from step 1.
//
//   To avoid clicking the same thing twice, it keeps a "tried" list in
//   memory. Each time it tries something new, that choice is remembered
//   and shown to the AI next time so it doesn't repeat itself.
//
// HOW IT'S STRUCTURED:
//
//   The tree is built from nested "branches" — think of them as steps
//   within steps. Here's the shape:
//
//   find-address (the main loop)
//     ├── navigate        — if a starting URL was given, go there first
//     ├── get_page        — grab the text content of whatever page we're on
//     ├── check_address   — ask the AI: "Is there an address on this page?"
//     └── try_find        — only runs if check_address said "no"
//           ├── scan the page for clickable elements
//           ├── format those elements into a readable list
//           ├── pick_action — ask the AI to choose what to click
//           │     ├── the AI picks an element and calls a tool (navigate/click)
//           │     ├── validate that the AI actually made a valid choice
//           │     └── (if invalid, retry up to 3 times)
//           ├── remember what we tried (so we don't try it again)
//           └── wait for the page to load after clicking
//
//   The whole thing repeats until either the address is found or we've
//   looped 3 times without success.
//
// KEY DESIGN CHOICES:
//
//   - The AI is asked simple yes/no or pick-one questions, not complex
//     reasoning tasks. This keeps each step reliable.
//   - "Tried" elements are tracked in memory (not on the page) so they
//     persist across loop iterations.
//   - If the AI says "no candidates" (nothing worth clicking), the loop
//     stops early rather than wasting attempts.
//   - Each step can use different tools — the address-checking step needs
//     no tools at all, while the pick-action step needs navigate and click.

import { Tree, when, goback, max } from '../../src/index.mjs';

// The system prompt tells the AI what kind of assistant it is. Think of it
// as setting the AI's "job title" — it's a web navigation helper that
// always uses tools to interact with pages.
const SYSTEM_PROMPT = 'You are a web navigation assistant. You find business addresses on websites. Always use the provided tools to navigate or click elements. Never answer without calling a tool when tools are available.';

// This is the question we ask the AI when looking at a page. We show it
// the page's text and ask: "Is there a business address here?" The AI
// either writes out the address (if found) or says "no" (if not found).
const CHECK_ADDRESS_PROMPT = `Below is the text content of a web page.

Your task: Does this page contain a business address? A business address has a street number, street name, city, and country or postal code.

If YES: Write the full address on one line.
If NO: Respond with exactly one word: no`;

// When the address isn't on the current page, we scan for things to click.
// This prompt shows the AI the list of clickable elements and asks it to
// pick the best one. We also show what we've already tried (so it doesn't
// repeat mistakes) and any feedback from previous failed attempts.
const PICK_ACTION_PROMPT = `Clickable elements on this page:

{candidates}

Already tried (skip these): {tried}

{feedback}

Pick the best element and call a tool:
- "navigate" with the URL when the element has a URL
- "click" with a CSS selector when the element has no URL

If there are no good candidates, respond: no candidates`;

// A simple helper that checks if the AI's answer means "no address found."
// It handles variations like "No", "NO", "no " (with extra spaces), etc.
const isNo = (v) => typeof v === 'string' && v.trim().toLowerCase() === 'no';

// JavaScript code that runs in the browser to extract page information.
// This reads the page's text, the current URL, and the page title —
// everything the AI needs to understand what page it's looking at.
const GET_PAGE_CODE = `JSON.stringify({
  text: document.body ? document.body.innerText : '',
  url: location.href,
  title: document.title
})`;

// Formats a list of clickable elements into a human-readable string.
// Each line shows the element type, its text, where it links to, and
// whether it has click handlers. The AI uses this list to decide what to
// click next. Filters out non-interactive tags (body, script, etc.) and
// truncates long text to keep the list readable.
const SKIP_TAGS = new Set(['body', 'html', 'head', 'script', 'style', 'meta', 'link', 'noscript']);

// ─── THE TREE ────────────────────────────────────────────────────────────────
//
// The tree definition. Pass it to `grandma.knit(pattern, runtime)`.
// The runtime provides the AI model and the browser tools (navigate, click,
// etc.).
//
// The approach:
// 1. Check if the current page has an address
// 2. If not, scan for clickable elements
// 3. Rate each element individually (likely/unlikely to lead to an address)
// 4. Filter to only "likely" candidates
// 5. Ask the AI to pick from the filtered list and act on it
// 6. Loop until the address is found or we've tried 3 times

const RATE_ELEMENT_PROMPT = `Does this element likely lead to a page with a business address?

Element: <{tag}> "{text}"{href}
Selector: {selector}

Answer only: likely, maybe, or unlikely`;

export const pattern = Tree.name('find-address')
  .model('default')

  // STEP 1: Navigate to the starting URL (if one was provided).
  // This is gated — it only runs if `m.url` exists and is non-empty.
  // If no URL was given (already on a page), this step is skipped.
  .call(when(m => typeof m.url === 'string' && m.url.length > 0),
    'navigate',
    m => ({ url: m.url }))

  // STEP 2: Grab the page content. This runs a small piece of JavaScript
  // in the browser that reads the page text, URL, and title. The result
  // is stored in memory as `get_page` so later steps can read it.
  .call('get_page', 'exec_js', () => ({ code: GET_PAGE_CODE }))

  // STEP 3: Ask the AI "Is there an address on this page?"
  // The AI sees the page text and responds with either the address (yes)
  // or the word "no". The response is stored as `check_address`.
  .branch(Tree.name('check_address')
    .prompt(m => [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `Page text:\n\n${m.branch.get_page?.text ?? ''}` },
        { role: 'user', content: CHECK_ADDRESS_PROMPT },
    ]))

  // STEP 4: If the address wasn't found, try to find it by clicking around.
  // This entire branch only runs when check_address said "no". Inside it,
  // we scan the page for clickable things, rate each one, filter to the
  // promising candidates, pick one, click it, and loop.
  .branch(when(m => isNo(m.branch.check_address)),
    Tree.name('try_find')

      // 4a: Scan the page for clickable elements (links, buttons, etc.).
      // Returns an array of { tag, text, href, listeners } objects.
      .call('scan_clickables', 'scan_clickables', () => ({}))

      // 4b: Filter out non-useful elements (body, script, etc.).
      .memory('filtered', m =>
        (m.branch.scan_clickables ?? [])
          .filter(el => !SKIP_TAGS.has(String(el.tag || '').toLowerCase())))

      // 4c: Rate each element individually. One LLM call per element.
      // The AI sees a single element and answers "likely", "maybe", or "unlikely".
      .map('ratings', m => m.branch.filtered ?? [],
        Tree.name('rate_element')
          .prompt(m => {
            const el = m.item;
            const tag = String(el.tag || '?').toLowerCase();
            const text = String(el.text || '').replace(/\n/g, ' ').trim().slice(0, 80);
            const href = el.href ? ` (${el.href})` : '';
            const selector = el.selector || tag;
            return [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user', content: RATE_ELEMENT_PROMPT
                .replace('{tag}', tag)
                .replace('{text}', text)
                .replace('{href}', href)
                .replace('{selector}', selector) },
            ];
          })
          .check(
            m => {
              const answer = m.prev[0]?.trim().toLowerCase();
              if (answer.startsWith('likely') || answer.startsWith('maybe') || answer.startsWith('unlikely')) return true;
              return 'Answer only: likely, maybe, or unlikely';
            },
            goback(1, max(2))
          ))

      // 4d: Build the filtered candidate list. Pair each element
      // with its rating, keep only "likely" ones.
      .memory('candidates', m => {
        const ratings = m.branch.ratings ?? [];
        const filtered = m.branch.filtered ?? [];
        return filtered
          .map((el, i) => ({ element: el, rating: ratings[i] }))
          .filter(r => r.rating?.trim().toLowerCase().startsWith('likely'))
          .map(r => r.element);
      })

      // 4e: Ask the AI to pick the best candidate and act on it.
      // The AI sees only the "likely" elements, what we've already tried,
      // and any feedback from previous failures.
      .branch(Tree.name('pick_action')
        .tools('navigate', 'click')
        .prompt(m => [
          { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: PICK_ACTION_PROMPT
            .replace('{candidates}', (m.branch.candidates ?? []).map(el => {
              const tag = String(el.tag || '?').toLowerCase();
              const text = String(el.text || '').replace(/\n/g, ' ').trim().slice(0, 80);
              const href = el.href ? ` (${el.href})` : '';
              const selector = el.selector || tag;
              return `<${tag}> "${text}"${href} [selector: ${selector}]`;
            }).join('\n') || '(none)')
            .replace('{tried}', JSON.stringify(m.branch.tried ?? []))
            .replace('{feedback}', m.error ? `\nPrevious attempt: ${m.error}\n` : '') },
        ])

        // Validate the AI's choice. The AI must either:
        //   - Call a tool (navigate or click) that succeeds, OR
        //   - Say "no candidates" (a short text response containing "no")
        //
        // If the AI gives a long rambling answer, calls a tool that fails,
        // or provides invalid tool arguments, the check fails and the AI
        // is asked to try again (up to 3 times).
        .check(
          m => {
            const tc = m.raw.prev[0]?.toolCalls?.[0];
            const tr = m.raw.prev[0]?.toolResults?.[0];
            if (!tc) {
              const text = String(m.prev[0] ?? '').trim().toLowerCase();
              if (!text) return 'Empty response. Call navigate/click or say "no candidates".';
              if (text.length < 80 && /\bno\b/.test(text)) return true;
              return 'Did not call a tool. Call navigate/click, or respond with "no candidates".';
            }
            if (tr?.isError) return `Tool '${tc.name}' failed: ${tr.result}. Try a different element or use navigate instead of click.`;
            try { JSON.parse(tc.arguments); return true; }
            catch { return 'Invalid JSON in tool call arguments.'; }
          },
          goback(1, max(3, m => `pick_action gave up: ${m.error}`))
        ))

      // 4f: Remember what we just tried. This adds the tool call arguments
      // (e.g., the URL we navigated to, or the selector we clicked) to a
      // running list in memory. Next time through the loop, this list is
      // shown to the AI so it doesn't pick the same thing again.
      //
      // This runs at the try_find level (not inside pick_action) so the
      // memory slot persists across loop iterations.
      .memory(when(m => {
          const tc = m.raw.branch.pick_action?.toolCalls?.[0];
          return Boolean(tc && tc.name);
        }),
        'tried',
        (m, cur) => {
          const tc = m.raw.branch.pick_action?.toolCalls?.[0];
          return [...(cur ?? []), tc.arguments];
        })

      // 4g: Wait for the page to load after clicking. This only runs if
      // pick_action actually called a tool (navigated or clicked). If the
      // AI said "no candidates" instead, there's nothing to wait for.
      .call(when(m => m.branch.tried != null),
        'wait_for_load', 'wait_for_load', () => ({ timeoutMs: 10000 })))

  // THE LOOP: Keep going until the address is found, or give up after
  // 3 full attempts. Each attempt = check the page, scan for clicks,
  // rate each, pick one, click it, check the new page. If we exhaust
  // all attempts, the tree throws an error with a descriptive message.
  .until(
    m => !isNo(m.branch.check_address),
    max(3, m => `find-address: gave up after 3 iterations: ${m.error ?? 'address not found'}`)
  );
