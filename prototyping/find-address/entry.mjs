#!/usr/bin/env node
import { runFindAddress } from './find-address.mjs';
import { listProviders } from '../lib/config.mjs';
import { setProvider } from '../lib/llm.mjs';

const url = process.argv[2];

const providers = listProviders();

if (providers.length > 1) {
  console.log('Available providers:');
  providers.forEach((p, i) => console.log(`  ${i + 1}. ${p}`));

  const answer = await new Promise((resolve) => {
    process.stdout.write('\nSelect provider (number): ');
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
      if (data.includes('\n')) {
        process.stdin.pause();
        resolve(data.trim());
      }
    });
  });

  const idx = parseInt(answer, 10) - 1;
  if (idx >= 0 && idx < providers.length) {
    setProvider(providers[idx]);
    console.log(`Using provider: ${providers[idx]}\n`);
  } else {
    console.error(`Invalid selection: ${answer}`);
    process.exit(1);
  }
}

if (url) console.log(`Target URL: ${url}\n`);

runFindAddress({ url }).catch((err) => {
  console.error('Find Address prototype failed:', err.message);
  process.exit(1);
});