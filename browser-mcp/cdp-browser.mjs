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
