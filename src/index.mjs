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
//   // A tool's execute(args) may resolve to a string or a plain JSON
//   // object (structured output). Both are stored in branch slots / tool
//   // results verbatim; an object with an "error" key (or a string
//   // starting with "error") is treated as a tool error.
//   tools: {},
//   });

import { knit, resume, KnitError, PauseSignal } from './knit.mjs';

export { Tree } from './tree.mjs';
export { when, goback, goto, max, isWhen, isGoback, isGoto, isMax, DEFAULT_MAX } from './markers.mjs';
export { knit, resume, KnitError, PauseSignal } from './knit.mjs';
export { createLogger } from './logger.mjs';

export const grandma = { knit, resume };
export default grandma;
