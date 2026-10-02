// Grandma KAT — Grandma Knits Agent Trees.
//
//   import grandma, { Tree, name, Prompt, Check, goback, max } from 'grandma-kat';
//
//   const pattern = Tree(
//     name('agent'),
//     Prompt(m => `Define success conditions for: ${m.task}`),
//     Prompt(m => `Attempt: ${m.prev[0]}`),
//     Check(m => m.prev[0] === 'yes' || 'Answer only yes or no.',
//       goback(1, max(3))),
//   );
//
//   const { result, memory } = await grandma.knit(pattern, {
//     models: { default: { baseURL, apiKey, model } },
//   // A tool's execute(args) may resolve to a string or a plain JSON
//   // object (structured output). Both are stored in branch slots / tool
//   // results verbatim; an object with an "error" key (or a string
//   // starting with "error") is treated as a tool error.
//   //
//   // A tool may instead declare a tree: { tree: 'name' } (a registered
//   // name, or a def). The model and Call(...) then invoke the tree
//   // like any tool — it runs in place and its result is the tool result.
//   // loadTree(name) resolves names the process has never built (the host
//   // can load them from disk); it is also the resume fallback.
//   tools: {},
//   loadTree: async (name) => null,
//   });

import { knit, resume, KnitError, PauseSignal } from './knit.mjs';

export { Tree, From } from './tree.mjs';
// The element surface: Tree(name('agent'), Prompt('ask', …), Branch(sub), …)
// — markers may sit anywhere among an element's arguments.
export { name, Model, Tools, Needs, Human, Prompt, Memory, Register, Branch, Each, Call, Check, Emit, Return, Until } from './records.mjs';
export { when, update, memory, version, goback, goto, max, calls, parameters, disableAuto, toolHookBefore, toolHookAfter, description, optional, isWhen, isUpdate, isMemory, isVersion, isGoback, isGoto, isMax, isCalls, isParameters, isDisableAuto, isToolHookBefore, isToolHookAfter, isDescription, isOptional, DEFAULT_MAX } from './markers.mjs';
export { knit, resume, KnitError, PauseSignal } from './knit.mjs';
export { createLogger } from './logger.mjs';

export const grandma = { knit, resume };
export default grandma;
