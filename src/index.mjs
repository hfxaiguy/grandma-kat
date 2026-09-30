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
//   //
//   // A tool may instead declare a tree: { tree: 'name' } (a registered
//   // name, or a def/builder). The model and .call() then invoke the tree
//   // like any tool — it runs in place and its result is the tool result.
//   // loadTree(name) resolves names the process has never built (the host
//   // can load them from disk); it is also the resume fallback.
//   tools: {},
//   loadTree: async (name) => null,
//   });

import { knit, resume, KnitError, PauseSignal } from './knit.mjs';

export { Tree } from './tree.mjs';
export { when, update, goback, goto, max, calls, parameters, disableAuto, toolHookBefore, toolHookAfter, isWhen, isUpdate, isGoback, isGoto, isMax, isCalls, isParameters, isDisableAuto, isToolHookBefore, isToolHookAfter, DEFAULT_MAX } from './markers.mjs';
export { knit, resume, KnitError, PauseSignal } from './knit.mjs';
export { createLogger } from './logger.mjs';

export const grandma = { knit, resume };
export default grandma;
