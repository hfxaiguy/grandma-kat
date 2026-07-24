// Grandma KAT — Grandma Knits Agent Trees.
//
//   import grandma, { Tree, when, goback, max } from 'grandma-kat';
//
//   const pattern = Tree.name('agent')
//     .prompt(m => `Define success conditions for: ${m.task}`)
//     .prompt(m => `Attempt: ${m.prev[0]}`)
//     .check(m => m.prev[0] === 'yes' || 'Answer only yes or no.',
//       goback(1, max(3)));
//
//   const { result, memory } = await grandma.knit(pattern, {
//     models: { default: { baseURL, apiKey, model } },
//     tools: {},
//   });

import { knit, KnitError } from './knit.mjs';

export { Tree } from './tree.mjs';
export { when, goback, max, isWhen, isGoback, isMax, DEFAULT_MAX } from './markers.mjs';
export { knit, KnitError } from './knit.mjs';

export const grandma = { knit };
export default grandma;
