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

// A simple helper that checks if the AI's answer means "no address found."
// It handles variations like "No", "NO", "no " (with extra spaces), etc.
const isNo = (v) => typeof v === 'string' && v.trim().toLowerCase() === 'no';

// Formats a list of clickable elements into a human-readable string.
// Each line shows the element type, its text, where it links to, and
// whether it has click handlers. The AI uses this list to decide what to
// click next. Filters out non-interactive tags (body, script, etc.) and
// truncates long text to keep the list readable.
const SKIP_TAGS = new Set(['body', 'html', 'head', 'script', 'style', 'meta', 'link', 'noscript']);

const ASK_ELEMENT_PROMPT = `
You are looking for the business address of {company}.

Would clicking this element be your first choice to find the address?
Element: <{tag}> "{text}" {href}
Selector: {selector}

Answer: yes or no
`

// ─── THE TREE ────────────────────────────────────────────────────────────────
//
// The tree definition. Pass it to `grandma.knit(pattern, runtime)`.
// The runtime provides the AI model and the browser tools (navigate, click,
// etc.).
//
// The approach:
// 1. Check if the current page has an address
// 2. If not, extract the company name from the page
// 3. Scan for clickable elements
// 4. Try each element one at a time: "Would clicking this find the address?"
// 5. On "yes" → act on that element. On "no" → try the next one.
// 6. Loop until the address is found or we've tried 3 times

export const pattern = Tree.name("find-address")
  .model("default")

  // STEP 1: Navigate to the starting URL (if one was provided).
  .call(
    when((m) => typeof m.url === "string" && m.url.length > 0),
    "navigate",
    (m) => ({ url: m.url }),
  )

  // STEP 2: Grab the page content (text, URL, title) using the snapshot tool.
  .call("get_page", "snapshot", () => ({}))

  // STEP 3: Ask the AI "Is there an address on this page?"
  .branch(
    Tree.name("check_address").prompt((m) => [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `Page text:\n\n${m.branch.get_page?.textPreview ?? ""}`,
      },
      { role: "user", content: CHECK_ADDRESS_PROMPT },
    ]),
  )

  .branch(
    when((m) => isNo(m.branch.check_address)),
    Tree.name("get_company_start").prompt((m) => [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `Page title: ${m.branch.get_page?.title ?? ""}\nPage text: ${(m.branch.get_page?.textPreview ?? "").slice(0, 1000)}\n\nWhat is the name of the company or organization on this page? Answer with ONLY the name, nothing else.`,
      },
    ]),
  )

  // STEP 4: If the address wasn't found, try to find it by clicking around.
  .branch(
    when((m) => isNo(m.branch.check_address)),
    Tree.name("try_find")
      // Initialize the tried list for tracking visited elements.
      .memory('tried_elements', (m, current) => current || [])

      // 4b: Scan the page for clickable elements.
      .call("scan_clickables", "scan_clickables", () => ({}))

      // 4c: Filter out non-useful elements (body, script, etc.).
      .memory('filtered', m =>
        (m.branch.scan_clickables ?? [])
          .filter(el => !SKIP_TAGS.has(String(el.tag || '').toLowerCase()))
        )

      // 4d: Try elements one at a time. Pick the next untried element,
      // ask the AI if it would lead to the address. On "yes" → return it.
      // On "no" → add to tried, loop to the next element.
      .branch(
        Tree.name("try_element")
          // Pick the first element not yet tried.
          .memory("current", (m) => {
            const tried = m.branch.tried_elements ?? [];
            return (
              (m.branch.filtered ?? []).find(
                (el) => !tried.includes(el.selector),
              ) ?? null
            );
          })
          // Ask the AI: would clicking this find the address?
          .prompt((m) => {
            const el = m.branch.current;
            if (!el)
              return [{ role: "user", content: "No more elements to try." }];
            const tag = String(el.tag || "?").toLowerCase();
            const text = String(el.text || "")
              .replace(/\n/g, " ")
              .trim()
              .slice(0, 80);
            const href = el.href ? ` (${el.href})` : "";
            const selector = el.selector || tag;
            const company = m.branch.get_company_start ?? "this company";
            return [
              { role: "system", content: SYSTEM_PROMPT },
              {
                role: "user",
                content: ASK_ELEMENT_PROMPT.replace("{company}", company)
                  .replace("{tag}", tag)
                  .replace("{text}", text)
                  .replace("{href}", href)
                  .replace("{selector}", selector),
              },
            ];
          })
          // If the answer is "yes", return the element. Tree stops.
          .return((m) => {
            const answer = m.prev[0]?.trim().toLowerCase();
            if (answer?.startsWith("yes")) return m.branch.current;
          })
          // "no" → add this element to the tried list, loop.
          .memoryUpdate("tried_elements", (m, cur) => {
            const el = m.branch.current;
            return [...(cur ?? []), el?.selector].filter(Boolean);
          })
          .until((m) => {
            // Stop if we got a yes (current was returned) or no more elements.
            const current = m.branch.current;
            return current == null;
          }, max(10)),
      )

      // 4e: Act on the chosen element. Navigate to its URL or click it.
      .branch(
        Tree.name("pick_action")
          .tools("navigate", "click")
          .prompt((m) => {
            const el = m.branch.try_element;
            if (!el)
              return [
                {
                  role: "user",
                  content: 'No suitable element found. Say "no candidates".',
                },
              ];
            const tag = String(el.tag || "?").toLowerCase();
            const text = String(el.text || "")
              .replace(/\n/g, " ")
              .trim()
              .slice(0, 80);
            const href = el.href || "";
            const selector = el.selector || tag;
            return [
              { role: "system", content: SYSTEM_PROMPT },
              {
                role: "user",
                content: `The best element to find the address is:\n<${tag}> "${text}" (${href})\nSelector: ${selector}\n\nCall "navigate" with the URL, or "click" with the selector. If neither makes sense, say "no candidates".`,
              },
            ];
          })
          .check(
            (m) => {
              const tc = m.raw.prev[0]?.toolCalls?.[0];
              const tr = m.raw.prev[0]?.toolResults?.[0];
              if (!tc) {
                const text = String(m.prev[0] ?? "")
                  .trim()
                  .toLowerCase();
                if (!text)
                  return 'Empty response. Call navigate/click or say "no candidates".';
                if (text.length < 80 && /\bno\b/.test(text)) return true;
                return 'Did not call a tool. Call navigate/click, or respond with "no candidates".';
              }
              if (tr?.isError)
                return `Tool '${tc.name}' failed: ${tr.result}. Try a different element or use navigate instead of click.`;
              try {
                JSON.parse(tc.arguments);
                return true;
              } catch {
                return "Invalid JSON in tool call arguments.";
              }
            },
            goback(
              1,
              max(3, (m) => `pick_action gave up: ${m.error}`),
            ),
          ),
      )

      // 4f: Remember what we just tried for the outer loop.
      .memory(
        when((m) => {
          const tc = m.raw.branch.pick_action?.toolCalls?.[0];
          return Boolean(tc && tc.name);
        }),
        "tried",
        (m, cur) => {
          const tc = m.raw.branch.pick_action?.toolCalls?.[0];
          return [...(cur ?? []), tc.arguments];
        },
      )

      // 4g: Wait for the page to load after clicking.
      .call(
        when((m) => m.branch.tried != null),
        "wait_for_load",
        "wait_for_load",
        () => ({ timeoutMs: 10000 }),
      ),
  )

  // THE LOOP: Keep going until the address is found, or give up after
  // 3 full attempts.
  .until(
    (m) => !isNo(m.branch.check_address),
    max(
      3,
      (m) =>
        `find-address: gave up after 3 iterations: ${m.error ?? "address not found"}`,
    ),
  );
