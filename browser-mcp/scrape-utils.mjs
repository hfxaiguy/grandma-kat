#!/usr/bin/env node
/**
 * General CDP-based scraping primitives.
 *
 * These functions build on top of cdp-browser.mjs and provide reusable
 * higher-level operations for extracting data from web pages.
 */

import {
  connectToCDP,
  ensureTarget,
  attachPage,
  evaluate,
  safeClose,
} from './cdp-browser.mjs';

/**
 * Wait for an element matching the selector to exist in the DOM.
 * @param {CDP.Client} pageClient
 * @param {string} selector
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
export async function waitForSelector(pageClient, selector, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await evaluate(pageClient, `
      !!document.querySelector(${JSON.stringify(selector)})
    `);
    if (found) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

/**
 * Click the first element matching the selector.
 * @param {CDP.Client} pageClient
 * @param {string} selector
 * @returns {Promise<string>}
 */
export async function clickSelector(pageClient, selector) {
  return evaluate(pageClient, `
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { error: 'Element not found: ${selector}' };
      el.click();
      return { clicked: true, selector: '${selector}' };
    })()
  `);
}

/**
 * Get the text content of the first matching element.
 * @param {CDP.Client} pageClient
 * @param {string} selector
 * @returns {Promise<string|null>}
 */
export async function getText(pageClient, selector) {
  return evaluate(pageClient, `
    document.querySelector(${JSON.stringify(selector)})?.textContent?.trim() || null
  `);
}

/**
 * Get the text content of all matching elements.
 * @param {CDP.Client} pageClient
 * @param {string} selector
 * @returns {Promise<string[]>}
 */
export async function getAllText(pageClient, selector) {
  return evaluate(pageClient, `
    Array.from(document.querySelectorAll(${JSON.stringify(selector)}))
      .map(el => el.textContent.trim())
  `);
}

/**
 * Get an attribute value from the first matching element.
 * @param {CDP.Client} pageClient
 * @param {string} selector
 * @param {string} attribute
 * @returns {Promise<string|null>}
 */
export async function getAttribute(pageClient, selector, attribute) {
  return evaluate(pageClient, `
    document.querySelector(${JSON.stringify(selector)})?.getAttribute(${JSON.stringify(attribute)}) || null
  `);
}

/**
 * Get an array of objects with text and href from matching anchor elements.
 * @param {CDP.Client} pageClient
 * @param {string} selector
 * @returns {Promise<Array<{text: string, href: string}>>}
 */
export async function getLinks(pageClient, selector) {
  return evaluate(pageClient, `
    Array.from(document.querySelectorAll(${JSON.stringify(selector)}))
      .map(el => ({ text: el.textContent.trim(), href: el.href }))
  `);
}

/**
 * Scroll an element into view.
 * @param {CDP.Client} pageClient
 * @param {string} selector
 */
export async function scrollTo(pageClient, selector) {
  return evaluate(pageClient, `
    document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    'scrolled';
  `);
}

/**
 * Get a JSON snapshot of the current page state.
 * @param {CDP.Client} pageClient
 * @returns {Promise<Object>}
 */
export async function snapshot(pageClient) {
  return evaluate(pageClient, `
    ({
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      scrollY: window.scrollY,
      scrollHeight: document.body?.scrollHeight || 0,
      clientHeight: window.innerHeight,
      textPreview: document.body?.innerText?.slice(0, 2000) || '',
    })
  `);
}

/**
 * Run arbitrary JavaScript in the page and return the result.
 * @param {CDP.Client} pageClient
 * @param {string} code
 * @returns {Promise<any>}
 */
export async function runJS(pageClient, code) {
  return evaluate(pageClient, code);
}

/**
 * Create a reusable scraping session.
 *
 * @param {Object} options
 * @param {string} options.targetUrl
 * @param {string} [options.cdpHost]
 * @param {number} [options.cdpPort]
 * @returns {Promise<{client: CDP.Client, pageClient: CDP.Client, close: Function}>}
 */
export async function createSession(options) {
  const client = await connectToCDP(options);
  const target = await ensureTarget(client, options.targetUrl, options.targetUrl);
  const pageClient = await attachPage(client, target);

  return {
    client,
    pageClient,
    close: async () => {
      await safeClose(pageClient);
      await safeClose(client);
    },
  };
}
