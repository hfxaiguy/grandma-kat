// person-scan — the greeted-person scan tree, translated from the line
// notation in notation.md. It models one turn of a "grandpa-bob" chat bot:
//
//   1. greet the human ("Hi. This is grandpa-bob")
//   2. wait for the human's message (stored as input_1)
//   3. ask a small model: does input_1 mention a person?
//   4. if yes, ask: how many people, and what info about them?
//
// This is a *teaching* tree: it exists to show how the five-symbol line
// notation maps onto grandma-kat's builder. See notation.md for the
// line-by-line translation and README.md for the notation spec.
//
// HOW IT'S STRUCTURED:
//
//   person-scan
//     ├── greet        — .emit() the verbatim greeting (from `<< output_msg:`)
//     ├── input_1      — .human() pause, stores the reply (from `>> human:`)
//     ├── scan_input   — named branch wrapping the detect-person prompt
//     │                   (from `-- prompt:`)
//     └── summarize_people — gated branch, runs only when scan_input said
//                             "yes" (from `** branch:` + `|| prompt:`)
//
// KEY DESIGN CHOICES:
//
//   - The `--` prompt is expanded to force a strict yes/no answer, because
//     the `** if above is true` gate needs a clean boolean. A small model
//     left unconstrained answers in prose ("Yes, it mentions John Doe"),
//     which a naive === "yes" test would reject and silently skip the branch.
//   - "above is true" is normalized with isYes, so "yes"/"YES"/"yes, ..."
//     all count. Anything else skips the branch (a false gate is a no-op).
//   - The `--` prompt lives in a *named* branch (scan_input) rather than a
//     bare .prompt(), so the `**` condition can reference its result by name
//     instead of a fragile auto-name like `#1`.

import { Tree, when } from "../../src/index.mjs";

// System prompt for the yes/no detection step: the model only judges
// presence of personal information, nothing else.
const DETECT_SYSTEM =
  "You detect personally identifying information in text. Answer with ONLY the requested format.";

// System prompt for the extraction step: pull out how many people and what
// information is present about each.
const SUMMARY_SYSTEM =
  "You extract information about people from text. Be precise and complete.";

// "true"/"yes" normalizer: a reply counts as yes if it *starts* with the
// word "yes" (case-insensitive). This is what binds the notation's
// "if above is true" to the scan_input result.
const isYes = (v) => typeof v === "string" && /^\s*yes\b/i.test(v.trim());

// The tree. Pass it to `grandma.knit(pattern, runtime)`. The runtime must
// provide the model(s) and, when several greeting turns run in one session,
// the `mem_global` seed (see the runner/smoke test).
export const pattern = Tree.name("person-scan")
  .model("default")

  // `<< output_msg: "Hi. This is grandpa-bob"` → .emit() the verbatim text.
  .emit(() => ({ text: "Hi. This is grandpa-bob" }))

  // `>> human: input_1` → pause for the human's message.
  .human("input_1")

  // `-- prompt: does input_1 contain information about a person` →
  // a named branch wrapping the detect-person prompt. The bare seed text is
  // expanded here: a system prompt, the injected input_1, and a strict
  // yes/no format the next gate depends on.
  .branch(
    Tree.name("scan_input").prompt((m) => [
      { role: "system", content: DETECT_SYSTEM },
      {
        role: "user",
        content: `Input:\n${m.branch.input_1}\n\nDoes this contain information about a person? Answer ONLY "yes" or "no".`,
      },
    ]),
  )

  // `** branch: if above is true, run:` → a branch gated on scan_input being
  // "yes". "above" binds to scan_input; isYes normalizes the answer.
  .branch(
    when((m) => isYes(m.branch.scan_input)),
    Tree.name("summarize_people")
      // `|| prompt: how many people and what kind of information...` →
      // the child prompt, expanded to extract counts + per-person info.
      .prompt((m) => [
        { role: "system", content: SUMMARY_SYSTEM },
        {
          role: "user",
          content: `Input:\n${
            m.branch.input_1
          }\n\nHow many people are mentioned, and what information is present about each?`,
        },
      ]),
  );
