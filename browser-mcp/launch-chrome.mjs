#!/usr/bin/env node
// Launch Chrome once, detached, with a remote-debugging port so the MCP server
// can attach to it. The browser outlives this script.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import CDP from 'chrome-remote-interface';
import { Launcher } from 'chrome-launcher';

const PORT = Number(process.env.CDP_PORT || 9222);
const PROFILE_DIR = process.env.CDP_PROFILE_DIR || path.join(os.homedir(), '.browser-mcp-chrome-profile');
const STATE_DIR = process.env.CDP_STATE_DIR || path.join(os.homedir(), '.browser-mcp');
const STATE_FILE = path.join(STATE_DIR, 'chrome.json');

function findChrome() {
  const installations = Launcher.getInstallations();
  if (!installations.length) throw new Error('No Chrome installation found.');
  return installations[0];
}

async function isUp(port) {
  try {
    await CDP.Version({ port });
    return true;
  } catch {
    return false;
  }
}

async function launchChrome() {
  if (await isUp(PORT)) {
    console.log(`Chrome already running on port ${PORT}.`);
    const targets = await CDP.List({ port: PORT });
    const pages = targets.filter((t) => t.type === 'page');
    console.log(`Page targets: ${pages.map((p) => p.url).join(', ')}`);
    return { port: PORT, reused: true };
  }

  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  fs.mkdirSync(STATE_DIR, { recursive: true });

  const bin = findChrome();
  const args = [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate',
    'about:blank',
  ];

  const child = spawn(bin, args, { detached: true, stdio: 'ignore' });
  child.unref();

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await isUp(PORT)) {
      fs.writeFileSync(STATE_FILE, JSON.stringify({ pid: child.pid, port: PORT, profileDir: PROFILE_DIR }, null, 2));
      console.log(`Chrome launched (pid ${child.pid}) on port ${PORT}.`);
      console.log(`Profile: ${PROFILE_DIR}`);
      console.log('Navigate to your target page in this window, then use the browser tools.');
      return { port: PORT, pid: child.pid, reused: false };
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  throw new Error('Chrome did not expose its debugging port in time.');
}

launchChrome().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
