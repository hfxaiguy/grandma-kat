#!/usr/bin/env node
import { runFindAddress } from './prototyping/find-address/find-address.mjs';

runFindAddress().catch((err) => {
  console.error('Find Address prototype failed:', err.message);
  process.exit(1);
});