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
//   4. Ask the AI: "Would clicking this element find the address?"
//   5. If yes → click it. If no → try the next element.
//   6. Wait for the page to load, then repeat from step 1.
//
//   To avoid clicking the same thing twice, it keeps a "tried_elements" list
//   in memory that persists across loop iterations.
//
// HOW IT'S STRUCTURED:
//
//   The tree is built from nested "branches" — think of them as steps
//   within steps. Here's the shape:
//
//   find-address (the main loop)
//     ├── navigate        — if a starting URL was given, go there first
//     ├── get_page        — snapshot the current page (tool call, no LLM)
//     ├── check_address   — ask the AI: "Is there an address on this page?"
//     ├── get_company     — extract company name (runs once, when address not found)
//     ├── tried_elements  — track what we've clicked (persists across iterations)
//     └── try_find        — only runs if check_address said "no"
//           ├── scan_clickables / filter — what could we click?
//           ├── try_element — ask the AI about each untried element
//           ├── pick_action — model calls navigate/click, validated + retried
//           └── wait_for_load — wait for page to load after clicking
//
//   The whole thing repeats until either the address is found or we've
//   looped 3 times without success.
//
// KEY DESIGN CHOICES:
//
//   - The AI is asked simple yes/no or pick-one questions, not complex
//     reasoning tasks. This keeps each step reliable.
//   - Steps without tools use a different system prompt to avoid confusing
//     the model into hallucinating tool calls.
//   - If the AI says "no candidates" (nothing worth clicking), the loop
//     stops early rather than wasting attempts.
//   - Each step can use different tools — the address-checking step needs
//     no tools at all, while the pick-action step needs navigate and click.

import { Tree, when, goback, max } from '../../src/index.mjs';

// The system prompt tells the AI what kind of assistant it is. Think of it
// as setting the AI's "job title" — it's a web navigation helper that
// always uses tools to interact with pages.
const SYSTEM_PROMPT = 'You are a web navigation assistant. You find business addresses on websites. Always use the provided tools to navigate or click elements. Never answer without calling a tool when tools are available.';

// System prompt for steps that don't have tools (like yes/no questions).
const SYSTEM_PROMPT_NO_TOOLS = 'You are a web navigation assistant. You find business addresses on websites. Answer with ONLY the requested format.';

// This is the question we ask the AI when looking at a page. We show it
// the page's text and ask: "Is there a business address here?" The AI
// either writes out the address (if found) or says "no" (if not found).
const CHECK_ADDRESS_PROMPT = `Below is the text content of a web page.

Your task: Does this page contain a business address? A business address has a street number, street name, city, and country or postal code.

If you find an address, write ONLY the address.
If there is no address, respond with exactly one word: no`;

// A simple helper that checks if the AI's answer means "no address found."
const isNo = (v) => typeof v === 'string' && v.trim().toLowerCase() === 'no';

// Tags to skip when filtering clickable elements (non-interactive).
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
      { role: "system", content: SYSTEM_PROMPT_NO_TOOLS },
      {
        role: "user",
        content: `Page text:\n\n${m.branch.get_page?.textPreview ?? ""}`,
      },
      { role: "user", content: CHECK_ADDRESS_PROMPT },
    ]),
  )

  .branch(
    when((m) => isNo(m.branch.check_address) && !m.branch.get_company_start),
    Tree.name("get_company_start").prompt((m) => [
      { role: "system", content: SYSTEM_PROMPT_NO_TOOLS },
      {
        role: "user",
        content: `Page title: ${m.branch.get_page?.title ?? ""}\nPage text: ${(m.branch.get_page?.textPreview ?? "").slice(0, 1000)}\n\nWhat is the name of the company or organization on this page? Answer with ONLY the name, nothing else.`,
      },
    ]),
  )

  // Track which elements we've already tried (persists across loop iterations).
  .memory(when((m) => isNo(m.branch.check_address)), "tried_elements", (m, current) => current || [])

  // STEP 4: If the address wasn't found, try to find it by clicking around.
  .branch(
    when((m) => isNo(m.branch.check_address)),
    Tree.name("try_find")
      // 4b: Scan the page for clickable elements.
      .call("scan_clickables", "scan_clickables", () => ({}))

      // 4c: Filter out non-useful elements (body, script, etc.).
      .memory("filtered", (m) =>
        (m.branch.scan_clickables ?? []).filter(
          (el) => !SKIP_TAGS.has(String(el.tag || "").toLowerCase()),
        ),
      )

      // 4d: Try elements one at a time. Pick the next untried element,
      // ask the AI if it would lead to the address. On "yes" → return it.
      // On "no" → try the next element.
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
          .prompt("try_interact", (m) => {
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
              { role: "system", content: SYSTEM_PROMPT_NO_TOOLS },
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
          // Record this element as tried (so we skip it in future iterations).
          .memoryUpdate("tried_elements", (m, cur) => {
            const el = m.branch.current;
            return [...(cur ?? []), el?.selector].filter(Boolean);
          })
          
          // If the answer is "yes", return the element. Tree stops.
          .return((m) => {
            const answer = m.try_interact?.trim().toLowerCase();
            if (answer?.startsWith("yes")) return m.branch.current;
          })

          // If "no", loop to the next element.
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

      // 4f: Wait for the page to load after clicking/navigating.
      .call(
        when((m) => {
          const tc = m.raw.branch.pick_action?.children?.['pick_action#1']?.toolCalls?.[0];
          return Boolean(tc && tc.name);
        }),
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
