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
//   4. scan_clickables           (gated on check_address saying "no")
//   5. format_clickables         (gated on "no")
//   6. get_tried                 (gated on "no")
//   7. pick_action               (gated on "no")
//        ┌── prompt with tools (navigate/click)
//        ├── .check — retries on missing/invalid tool calls
//        └── record_tried — appends the executed tool call's args to tried
//   8. wait_for_load             (gated on pick_action emitting a tool call)
//
//   .until(address found, max(3)) — the outer loop. max(3) is one initial
//        pass plus three retries; the runner reports a loud KnitError on
//        exhaustion.
//
// "Tried" elements are tracked in the browser page's `window.__tried` (a
// JSON array of last-tried tool-arguments). get_tried reads it;
// record_tried appends to it. The first call to get_tried initializes the
// array.
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

const GET_TRIED_CODE = `JSON.stringify(Array.isArray(window.__tried) ? window.__tried : [])`;

// __TOOL_CALL__ is substituted with the JSON-encoded pick_action prompt's
// first tool call (or null) at argsFn time. Pushes the tool arguments to
// window.__tried and returns the updated list.
const RECORD_TRIED_CODE = `(() => {
  window.__tried = Array.isArray(window.__tried) ? window.__tried : [];
  const tc = __TOOL_CALL__;
  if (tc && tc.arguments) window.__tried.push(tc.arguments);
  return JSON.stringify(window.__tried);
})()`;

export function createFindAddressPattern({ model = 'default' } = {}) {
  const needsMore = (m) => isNo(m.branch.check_address);
  // pick_action emits a tool call when it has work to do. We surface that
  // by reading the prompt's record — the agentic loop's toolCalls land on
  // the prompt's raw record.
  const pickEmittedTool = (m) => {
    const tc = m.raw.prev[0]?.toolCalls?.[0];
    return Boolean(tc && tc.name);
  };

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
    .call(when(needsMore), 'scan_clickables', 'scan_clickables', () => ({}))
    .call(when(needsMore), 'format_clickables', 'exec_js', m => ({
      code: FORMAT_CLICKABLES_CODE.replace(
        '__CLICKABLES__',
        JSON.stringify(m.branch.scan_clickables ?? [])
      ),
    }))
    .call(when(needsMore), 'get_tried', 'exec_js', () => ({ code: GET_TRIED_CODE }))
    .branch(when(needsMore),
      Tree.name('pick_action')
        .tools('navigate', 'click')
        .prompt(m => [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: STEP3_PROMPT
            .replace('{candidates}', m.branch.format_clickables || '(none)')
            .replace('{tried}', m.branch.get_tried || '[]')
            .replace('{feedback}', m.error ? `\nPrevious attempt: ${m.error}\n` : '') },
        ])
        .check(
          m => {
            // Validate tool calls when the LLM makes one. Plain-text
            // responses are accepted as a pass when they look like an
            // explicit "I'm done" signal — "no", "no candidates",
            // "nothing useful", etc. The check is loose because the
            // STEP3 prompt instructs the LLM to say "no candidates" when
            // nothing looks promising; we don't want to retry-loop on
            // that. A long-form or off-topic response is rejected so the
            // LLM is nudged to either commit to a tool call or explicitly
            // say no.
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
        )
        // record_tried is a sibling of the prompt inside pick_action so it
        // can read the prompt's record via m.raw.prev[0] (no scope-chain
        // gymnastics). It's gated on the check having passed *and* a tool
        // having actually been called.
        .call(when(m => {
            const tc = m.raw.prev[0]?.toolCalls?.[0];
            return Boolean(tc && tc.name);
          }),
          'exec_js',
          m => ({
            code: RECORD_TRIED_CODE.replace(
              '__TOOL_CALL__',
              JSON.stringify(m.raw.prev[0]?.toolCalls?.[0] ?? null)
            ),
          })))
    .call(when(m => needsMore(m) && pickEmittedTool(m)),
      'wait_for_load', 'wait_for_load', () => ({ timeoutMs: 10000 }))
    .until(
      m => !isNo(m.branch.check_address),
      max(3, m => `find-address: gave up after 3 iterations: ${m.error ?? 'address not found'}`)
    );
}
