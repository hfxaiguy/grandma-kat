#!/usr/bin/env node
/**
 * Low-level CDP (Chrome DevTools Protocol) helpers.
 *
 * These utilities connect to a Chrome instance already exposing its debugging
 * port (e.g. ../browser-mcp/launch-chrome.mjs) and provide a small ergonomic
 * wrapper around chrome-remote-interface.
 */

import CDP from 'chrome-remote-interface';

const DEFAULT_HOST = process.env.CDP_HOST || 'localhost';
const DEFAULT_PORT = Number(process.env.CDP_PORT || 9222);

/**
 * Connect to the CDP server.
 * @param {Object} options
 * @returns {Promise<CDP.Client>}
 */
export async function connectToCDP(options = {}) {
  const host = options.host || DEFAULT_HOST;
  const port = options.port || DEFAULT_PORT;
  return CDP({ host, port });
}

/**
 * Find a page target whose URL starts with the given prefix.
 * @param {CDP.Client} client
 * @param {string} urlPrefix
 * @returns {Promise<Object|undefined>}
 */
export async function findTarget(client, urlPrefix) {
  await client.Target.setDiscoverTargets({ discover: true });
  const { targetInfos } = await client.Target.getTargets();
  const pages = targetInfos.filter((t) => t.type === 'page');
  if (!pages.length) return undefined;
  if (!urlPrefix) {
    // CDP has no "active tab" concept. Heuristic: the last page target in the
    // list is the most recently created/focused one in a typical debugging
    // session. For true disambiguation, pass an explicit urlPrefix.
    return pages[pages.length - 1];
  }
  return pages.find((t) => t.url.startsWith(urlPrefix));
}

/**
 * Create or navigate a target to the given URL.
 * @param {CDP.Client} client
 * @param {string} urlPrefix
 * @param {string} fullUrl
 * @returns {Promise<Object>} targetInfo
 */
export async function ensureTarget(client, urlPrefix, fullUrl) {
  let target = await findTarget(client, urlPrefix);

  if (!target && fullUrl) {
    const { targetId } = await client.Target.createTarget({ url: fullUrl });
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250));
      target = await findTarget(client, urlPrefix);
      if (target) break;
    }
  }

  if (!target) {
    throw new Error(`Could not find or create target for ${fullUrl}`);
  }

  return target;
}

/**
 * Attach to a target and return a client scoped to that page.
 * @param {CDP.Client} client
 * @param {Object} target
 * @returns {Promise<CDP.Client>}
 */
export async function attachPage(client, target) {
  const host = client.host || DEFAULT_HOST;
  const port = client.port || DEFAULT_PORT;
  const pageClient = await CDP({ host, port, target: target.targetId });
  await pageClient.Runtime.enable();
  await pageClient.Page.enable();
  return pageClient;
}

/**
 * Evaluate JavaScript in a page client and return the value.
 * @param {CDP.Client} pageClient
 * @param {string} expression
 * @param {Object} options
 * @returns {Promise<any>}
 */
export async function evaluate(pageClient, expression, options = {}) {
  const result = await pageClient.Runtime.evaluate({
    expression,
    awaitPromise: true,
    returnByValue: true,
    timeout: 60000,
    ...options,
  });

  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  }

  return result.result.value;
}

/**
 * Close a CDP client, ignoring errors.
 * @param {CDP.Client|null} client
 */
export async function safeClose(client) {
  if (!client) return;
  try {
    await client.close();
  } catch {
    // ignore
  }
}

/**
 * Wait for the page to finish loading. Listens for Page.loadEventFired and
 * falls back to polling document.readyState (works for SPA route changes that
 * don't fire a load event). Resolves true on load, false on timeout.
 * @param {CDP.Client} pageClient
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
export async function waitForLoad(pageClient, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;

  let loadFired = false;
  try {
    pageClient.Page.loadEventFired(() => { loadFired = true; });
  } catch {}

  let lastHeight = -1;
  let stableSince = 0;
  while (Date.now() < deadline) {
    if (loadFired) return true;

    let ready = 'unknown';
    let h = 0;
    try {
      const r = await pageClient.Runtime.evaluate({
        expression: `JSON.stringify({ ready: document.readyState, h: document.body ? document.body.scrollHeight : 0 })`,
        returnByValue: true,
      });
      if (r.result?.value) {
        const o = JSON.parse(r.result.value);
        ready = o.ready;
        h = o.h;
      }
    } catch {}

    const now = Date.now();
    if (h === lastHeight) {
      if (stableSince === 0) stableSince = now;
      if (now - stableSince >= 500 && ready === 'complete') return true;
    } else {
      stableSince = 0;
      lastHeight = h;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/**
 * Resolve the CDP objectId for the first DOM element matching a selector.
 * Returns { objectId, value } or null if not found.
 * @param {CDP.Client} pageClient
 * @param {string} selector
 */
export async function getObjectForSelector(pageClient, selector) {
  const { result, exceptionDetails } = await pageClient.Runtime.evaluate({
    expression: `document.querySelector(${JSON.stringify(selector)})`,
    returnByValue: false,
  });
  if (exceptionDetails) return null;
  if (!result || result.subtype !== 'node') return null;
  return { objectId: result.objectId, value: result.value };
}

/**
 * Get the event listeners attached to a DOM node by objectId.
 * @param {CDP.Client} pageClient
 * @param {string} objectId
 * @returns {Promise<Array<{ type: string, useCapture: boolean, once: boolean }>>}
 */
export async function getEventListeners(pageClient, objectId) {
  const { listeners } = await pageClient.DOMDebugger.getEventListeners({ objectId, depth: 0, pierce: true });
  return (listeners || []).map((l) => ({
    type: l.type,
    useCapture: l.useCapture,
    once: l.once,
  }));
}

/**
 * Scan every element on the page and report those with at least one event listener.
 * Walks document.querySelectorAll('*'), resolves each objectId, and calls
 * Debugger.getEventListeners. Elements with no listeners are filtered out.
 * @param {CDP.Client} pageClient
 * @returns {Promise<Array<{ tag: string, text: string, href: string|null, listeners: Array }>>}
 */
export async function scanClickables(pageClient) {
  const countRes = await pageClient.Runtime.evaluate({
    expression: `document.querySelectorAll('*').length`,
    returnByValue: true,
  });
  const total = countRes.result?.value || 0;

  const seen = new Set();
  const out = [];
  for (let i = 0; i < total; i++) {
    const meta = await pageClient.Runtime.evaluate({
      expression: `(() => {
        const el = document.querySelectorAll('*')[${i}];
        const tag = el.tagName.toLowerCase();
        const text = (el.innerText || el.textContent || '').trim().slice(0, 200);
        const href = el.href || null;
        return { tag, text, href };
      })()`,
      returnByValue: true,
    });
    if (meta.exceptionDetails || !meta.result?.value) continue;

    const m = meta.result.value;
    if (!m.text) continue;

    const isAnchor = m.tag === 'a';

    let listeners = [];
    if (!isAnchor || m.href) {
      const obj = await pageClient.Runtime.evaluate({
        expression: `document.querySelectorAll('*')[${i}]`,
        returnByValue: false,
      });
      if (obj.result?.subtype === 'node') {
        listeners = await getEventListeners(pageClient, obj.result.objectId);
      }
    }

    if (!listeners.length && !isAnchor) continue;

    const key = `${m.tag}:${m.text}:${m.href}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      tag: m.tag,
      text: m.text,
      href: m.href,
      listeners,
    });
  }

  return out;
}

/**
 * Execute JavaScript within a scoped element or iframe.
 *
 * For regular elements: binds `element` to document.querySelector(scope) and evaluates code.
 * For iframes: tries contentDocument first (same-origin), falls back to CDP frame context.
 *
 * @param {CDP.Client} pageClient
 * @param {string} scope - CSS selector for the scope element or iframe
 * @param {string} code - JavaScript to evaluate. For regular elements, `element` is bound.
 * @returns {Promise<any>}
 */
export async function execJsInScope(pageClient, scope, code) {
  // First, check if the scope is an iframe
  const isIframe = await evaluate(pageClient, `
    (() => {
      const el = document.querySelector(${JSON.stringify(scope)});
      if (!el) return 'not_found';
      return el.tagName === 'IFRAME' ? 'iframe' : 'element';
    })()
  `);

  if (isIframe === 'not_found') {
    throw new Error(`Scope element not found: ${scope}`);
  }

  if (isIframe === 'iframe') {
    // Try same-origin iframe access first
    const sameOrigin = await evaluate(pageClient, `
      (() => {
        try {
          const iframe = document.querySelector(${JSON.stringify(scope)});
          const doc = iframe.contentDocument;
          return doc !== null;
        } catch {
          return false;
        }
      })()
    `);

    if (sameOrigin) {
      // Same-origin: wrap code to use iframe's document, bind element to body
      return evaluate(pageClient, `
        (() => {
          const iframe = document.querySelector(${JSON.stringify(scope)});
          const document = iframe.contentDocument;
          const window = iframe.contentWindow;
          const element = document.body;
          return (${code});
        })()
      `);
    }

    // Cross-origin: the iframe is a separate CDP target.
    // Try multiple approaches to find and execute in the iframe.
    const iframeSrc = await evaluate(pageClient, `
      document.querySelector(${JSON.stringify(scope)}).src || ''
    `);

    const host = pageClient.host || DEFAULT_HOST;
    const port = pageClient.port || DEFAULT_PORT;

    // Approach 1: Try to find iframe as a CDP target
    const targets = await CDP.List({ host, port });
    const iframeTarget = targets.find((t) =>
      t.url === iframeSrc || t.url.startsWith(iframeSrc)
    );

    if (iframeTarget) {
      const iframeClient = await CDP({ host, port, target: iframeTarget.id });
      await iframeClient.Runtime.enable();
      try {
        // Wrap code to bind element to document.body for iframes
        const wrappedCode = `(() => { const element = document.body; return (${code}); })()`;
        const result = await iframeClient.Runtime.evaluate({
          expression: wrappedCode,
          returnByValue: true,
          awaitPromise: true,
        });
        if (result.exceptionDetails) {
          throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
        }
        return result.result.value;
      } finally {
        await safeClose(iframeClient);
      }
    }

    // Approach 2: Try to find iframe via frame tree (some browsers include it)
    const { frameTree } = await pageClient.Page.getFrameTree();
    const frameId = findFrameByUrl(frameTree, iframeSrc);
    if (frameId) {
      const { executionContextId } = await pageClient.Page.createIsolatedWorld({
        frameId,
        worldName: 'threads-scope',
      });
      // Wrap code to bind element to document.body for iframes
      const wrappedCode = `(() => { const element = document.body; return (${code}); })()`;
      const result = await pageClient.Runtime.evaluate({
        expression: wrappedCode,
        contextId: executionContextId,
        returnByValue: true,
        awaitPromise: true,
      });
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      }
      return result.result.value;
    }

    // Approach 3: Try to use DOM.describeNode to get the iframe's frameId
    const { root } = await pageClient.DOM.getDocument({ depth: 0 });
    const { node } = await pageClient.DOM.describeNode({
      objectId: await evaluate(pageClient, `document.querySelector(${JSON.stringify(scope)})`)?.objectId,
      depth: 0,
    });
    if (node && node.frameId) {
      const { executionContextId } = await pageClient.Page.createIsolatedWorld({
        frameId: node.frameId,
        worldName: 'threads-scope',
      });
      // Wrap code to bind element to document.body for iframes
      const wrappedCode = `(() => { const element = document.body; return (${code}); })()`;
      const result = await pageClient.Runtime.evaluate({
        expression: wrappedCode,
        contextId: executionContextId,
        returnByValue: true,
        awaitPromise: true,
      });
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      }
      return result.result.value;
    }

    throw new Error(`Could not find CDP target for iframe: ${scope} (src: ${iframeSrc})`);
  }

  // Regular element: bind `element` variable and evaluate
  return evaluate(pageClient, `
    (() => {
      const element = document.querySelector(${JSON.stringify(scope)});
      if (!element) throw new Error('Scope element not found: ${scope}');
      return (${code});
    })()
  `);
}

/**
 * Recursively search the frame tree for a frame matching a URL.
 * @param {Object} frameTree
 * @param {string} url
 * @returns {string|null} frameId
 */
function findFrameByUrl(frameTree, url) {
  const frame = frameTree.frame;
  if (!frame) return null;
  
  if (frame.url === url || frame.url.startsWith(url)) {
    return frame.id;
  }
  for (const child of frameTree.childFrames || []) {
    const found = findFrameByUrl(child, url);
    if (found) return found;
  }
  return null;
}
