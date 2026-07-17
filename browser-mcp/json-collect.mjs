#!/usr/bin/env node
/**
 * Streaming JSON-array collector.
 *
 * Writes a JSON array incrementally to disk so that partial results are
 * preserved if the process crashes. Usage:
 *
 *   await startCollect('out.json');
 *   await collect('out.json', { name: 'Ada' });
 *   await collect('out.json', { name: 'Bob' });
 *   await endCollect('out.json'); // -> [{ name: 'Ada' }, { name: 'Bob' }]
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const STATE = new Map();

function getState(filePath) {
  return STATE.get(path.resolve(filePath));
}

function setState(filePath, state) {
  STATE.set(path.resolve(filePath), state);
}

/**
 * Format an object as an indented JSON block, suitable for pretty-printed arrays.
 * @param {Object} obj
 * @returns {string}
 */
function formatObject(obj) {
  return JSON.stringify(obj, null, 2).replace(/\n/g, '\n  ');
}

/**
 * Start collecting. Writes an opening bracket and prepares internal state.
 * @param {string} filePath
 */
export async function startCollect(filePath) {
  const resolved = path.resolve(filePath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, '[\n', 'utf8');
  setState(resolved, { count: 0, closed: false });
}

/**
 * Append a JavaScript object to the streaming JSON array.
 * @param {string} filePath
 * @param {Object} obj
 */
export async function collect(filePath, obj) {
  const resolved = path.resolve(filePath);
  const state = getState(resolved);

  if (!state) {
    throw new Error(`startCollect() was not called for ${filePath}`);
  }

  if (state.closed) {
    throw new Error(`Cannot collect into ${filePath}: array already closed`);
  }

  const prefix = state.count > 0 ? ',\n  ' : '  ';
  const chunk = prefix + formatObject(obj);
  await fs.appendFile(resolved, chunk, 'utf8');
  state.count += 1;
}

/**
 * Finish collecting by writing the closing bracket.
 * @param {string} filePath
 */
export async function endCollect(filePath) {
  const resolved = path.resolve(filePath);
  const state = getState(resolved);

  if (!state) {
    throw new Error(`startCollect() was not called for ${filePath}`);
  }

  if (!state.closed) {
    const terminator = state.count > 0 ? '\n]\n' : ']\n';
    await fs.appendFile(resolved, terminator, 'utf8');
    state.closed = true;
  }
}
