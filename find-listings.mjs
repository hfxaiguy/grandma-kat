#!/usr/bin/env node
import { runFindListings } from './prototyping/find-listings/find-listings.mjs';

runFindListings().catch((err) => {
  console.error('Find Listings prototype failed:', err.message);
  process.exit(1);
});
