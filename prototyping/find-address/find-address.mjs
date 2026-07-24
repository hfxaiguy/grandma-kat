// find-address — converted from prototyping/find-address/find-address.mjs.
//
// Wires the prototype's three-step loop (page → check for address → scan +
// rate clickables → pick + act) as a grandma-kat tree. The tree runs via
// `grandma.knit(pattern, runtime)`; the runtime supplies the LLM model and
// the browser-mcp tool registry.
//
// Tree layout (children of the root `find-address`):
//
//   1. navigate_initial          (gated on m.url) — open the target page
//   2. get_page                  — dump body text, url, title via exec_js
//   3. check_address             — prompt: "does this page have an address?"
//   4. try_find                  (gated on check_address saying "no")
//        ├── scan_clickables
//        ├── format_clickables
//        ├── pick_action
//        │     ├── prompt with tools (navigate/click)
//        │     ├── .check — retries on missing/invalid tool calls
//        │     └── .memory('tried') — appends the tool call args to the tried list
//        └── wait_for_load       (gated on pick_action emitting a tool call)
//
//   .until(address found, max(3)) — the outer loop. max(3) is one initial
//        pass plus three retries; the runner reports a loud KnitError on
//        exhaustion.
//
// "Tried" elements are tracked in memory as `tried` — a JSON string array
// of previous tool-call arguments. pick_action's prompt reads it via
// m.branch.tried; .memory('tried') appends after a successful tool call.
//
// The check inside pick_action accepts an explicit "no candidates"-style
// plain-text response as a pass (no tool call) — that's the prototype's
// "stop this iteration" signal in miniature. When pick_action passes that
// way, wait_for_load is gated off (no tool was actually called).

import { Tree, when, goback, max } from '../../src/index.mjs';

const SYSTEM_PROMPT = 'You are a web navigation assistant. You help find information on web pages by reading page content and deciding what to click or navigate to.';

const STEP1_PROMPT = `Below is the text content of a web page.

Your task: Does this page contain a business address? A business address has a street number, street name, city, and country or postal code.

If YES: Write the full address on one line.
If NO: Respond with exactly one word: no`;

const STEP3_PROMPT = `Below are candidate clickable elements that might lead to a business address:

{candidates}

Already tried (do NOT pick any of these): {tried}

{feedback}

Pick the element most likely to lead to a page containing a business address and call exactly one tool:
- Call "navigate" with the URL when the element has a URL.
- Call "click" with a CSS selector when the element has no URL.

If the candidates list is empty or nothing looks promising, call neither tool and just say "no candidates" in plain text.`;

const isNo = (v) => typeof v === 'string' && v.trim().toLowerCase() === 'no';

const GET_PAGE_CODE = `JSON.stringify({
  text: document.body ? document.body.innerText : '',
  url: location.href,
  title: document.title
})`;

// __CLICKABLES__ is substituted with the JSON-encoded scan_clickables result
// at argsFn time. Returns a newline-joined list of formatted lines.
const FORMAT_CLICKABLES_CODE = `(() => {
  const els = __CLICKABLES__;
  if (!Array.isArray(els) || !els.length) return '';
  return els.map((el) => {
    const tag = String(el.tag || el.tagName || '?').toLowerCase();
    const text = String(el.text || el.innerText || '').replace(/\\n/g, ' ').trim();
    let suffix = '';
    if (el.href) suffix += ' (' + el.href + ')';
    if (Array.isArray(el.listeners) && el.listeners.length) {
      suffix += ' [' + el.listeners.map((l) => l.type).join(',') + ']';
    }
    return (tag + ' "' + text + '"' + suffix).trim();
  }).filter((l) => l.length > 4).join('\\n');
})()`;

export function createFindAddressPattern({ model = 'default' } = {}) {
  const needsMore = (m) => isNo(m.branch.check_address);

  return Tree.name('find-address')
    .model(model)
    .call(when(m => typeof m.url === 'string' && m.url.length > 0),
      'navigate',
      m => ({ url: m.url }))
    .call('get_page', 'exec_js', () => ({ code: GET_PAGE_CODE }))
    .branch(Tree.name('check_address')
      .prompt(m => [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Page text:\n\n${m.branch.get_page?.text ?? ''}` },
        { role: 'user', content: STEP1_PROMPT },
      ]))
    // Everything below is gated on check_address returning "no" — one gate
    // for the whole "try to find the address" sub-tree.
    .branch(when(needsMore),
      Tree.name('try_find')
        .call('scan_clickables', 'scan_clickables', () => ({}))
        .call('format_clickables', 'exec_js', m => ({
          code: FORMAT_CLICKABLES_CODE.replace(
            '__CLICKABLES__',
            JSON.stringify(m.branch.scan_clickables ?? [])
          ),
        }))
        .branch(Tree.name('pick_action')
          .tools('navigate', 'click')
          .prompt(m => [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: STEP3_PROMPT
              .replace('{candidates}', m.branch.format_clickables || '(none)')
              .replace('{tried}', JSON.stringify(m.branch.tried ?? []))
              .replace('{feedback}', m.error ? `\nPrevious attempt: ${m.error}\n` : '') },
          ])
          .check(
            m => {
              const tc = m.raw.prev[0]?.toolCalls?.[0];
              if (!tc) {
                const text = String(m.prev[0] ?? '').trim().toLowerCase();
                if (!text) return 'Empty response. Call navigate/click or say "no candidates".';
                if (text.length < 80 && /\bno\b/.test(text)) return true;
                return 'Did not call a tool. Call navigate/click, or respond with "no candidates".';
              }
              try { JSON.parse(tc.arguments); return true; }
              catch { return 'Invalid JSON in tool call arguments.'; }
            },
            goback(1, max(3, m => `pick_action gave up: ${m.error}`))
          ))
        // Append the tool call args to the tried list in memory. Runs at
        // try_find level so the slot persists across loop iterations.
        .memory(when(m => {
            const tc = m.raw.branch.pick_action?.toolCalls?.[0];
            return Boolean(tc && tc.name);
          }),
          'tried',
          (m, cur) => {
            const tc = m.raw.branch.pick_action?.toolCalls?.[0];
            return [...(cur ?? []), tc.arguments];
          })
        // wait_for_load only fires when pick_action actually called a tool.
        // .memory('tried') only runs when a tool was called, so checking for
        // its existence is the signal.
        .call(when(m => m.branch.tried != null),
          'wait_for_load', 'wait_for_load', () => ({ timeoutMs: 10000 })))
    .until(
      m => !isNo(m.branch.check_address),
      max(3, m => `find-address: gave up after 3 iterations: ${m.error ?? 'address not found'}`)
    );
}
