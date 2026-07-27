# Examples

Runnable, real-world material for learning Grandma KAT — organized as a
before/after pair:

| Directory | Style | What it does |
|---|---|---|
| **`find-address/`** | **Grandma KAT tree** | Finds a business's street address on its website by browsing around |
| `find-listings/` | Imperative prototype | Detects listing pages (directories, team pages) and analyzes each entry |
| `find-pagination/` | Imperative prototype | Detects pagination on a page and clicks through it |
| `lib/` | Shared plumbing | Config, direct LLM calls, file logging, MCP client for the prototypes |
| `browser-mcp/` | Tool server | CDP-backed Chrome, exposed as an MCP server (the browser tools) |

**Start with `find-address/`.** It's the only converted tree — heavily
commented for newcomers — and the two prototypes are the "before" picture:
the same kind of web task written as imperative scripts, which is exactly
the style a grandma-kat tree replaces. Comparing them is the fastest way to
see what the library buys you (validation, bounded retries, gates, memory,
structured logs).

## find-address — the tree (start here)

Automates what you'd do by hand: look at the page for an address; if it's
not there, click the most promising link ("Contact", "Locations", …) and
look again — with bounded retries, and never clicking the same thing twice.

```
find-address (loops until address found, max 3 passes)
  ├── navigate        — go to the starting URL, if one was given
  ├── get_page        — snapshot the current page (tool call, no LLM)
  ├── check_address   — ask the model: "is there an address here?"
  ├── get_company     — extract company name (runs once, when address not found)
  ├── tried_elements  — track what we've clicked (persists across iterations)
  └── try_find        — only runs when the answer was "no"
        ├── scan_clickables / filter — what could we click?
        ├── try_element   — ask the model about each untried element
        ├── pick_action   — model calls navigate/click, validated + retried
        └── wait_for_load — wait for page to load after clicking
```

- `find-address.mjs` — the pattern (`export const pattern = Tree.name(...)`).
  Every step has a plain-language comment; read it top to bottom.
- `entry.mjs` — the CLI wiring: launches Chrome, starts the MCP tool
  server, maps the tools into a grandma-kat registry, runs
  `grandma.knit(pattern, ...)`.

```sh
node examples/find-address/entry.mjs https://example.com
```

(No URL also works — it starts from whatever tab is open.)

**No browser or model needed to study it:** `tests/find-address.test.mjs`
runs the whole tree — gates, retries, loop exhaustion —
against a scripted mock model and an in-memory fake page. `npm test` covers
the happy path, wrong picks, invalid tool calls, and giving up.

Tree features demonstrated: `.branch()`, `.prompt()` (string fn + message
arrays), `.call()`, `.check()` + `goback()` + `max()`, `.memory()` /
`.memoryUpdate()`, `.return()`, `.until()`, `when()` gates, per-branch
`.tools()`.

## find-listings / find-pagination — the prototypes (before)

These are **imperative scripts**, not trees: linear sequences of
`callLlm(...)` / `callTool(...)` with `console.log` narration and hand-rolled
retry logic. They're kept because they're the raw material — the
conventions for converting such a prototype into a tree live in
[`examples/AGENTS.md`](AGENTS.md).

- **`find-listings/`** — "is this a listing page?" → ask the model for a CSS
  selector matching each repeating entry → per entry: what's here, is there
  more, what should I click?
  ```sh
  node examples/find-listings/entry.mjs [url] [scope]
  ```
- **`find-pagination/`** — describe anything that looks like pagination →
  isolate its HTML → click through pages (max 5), remembering what it did.
  ```sh
  node examples/find-pagination/entry.mjs [url] [scope] [provider]
  ```

Both take an optional `scope` CSS selector (default `body`) to work inside
a page region or iframe, and run against the current tab when no URL is
given. Their LLM calls are logged as one JSON file per call under
`logs/<script-name>/<run-id>/`.

## Setup

1. **Node.js ≥ 22.5.** The repo root has no dependencies.
2. **Install the tool server's deps** (it's a standalone subpackage):
   ```sh
   cd examples/browser-mcp && npm install && cd ../..
   ```
3. **Chrome** installed — the entry points auto-launch a detached instance
   with remote debugging on port 9222 (override with `CDP_PORT`).
4. **A model endpoint**, configured in `grandma-kat.config.json` at the
   repo root:
   - `"local"` (default) — any OpenAI-compatible server at
     `http://localhost:8080/v1`, e.g. `llama-server` with a small GGUF.
   - `"huggingface"` — the HF router; put your token in `.env`
     (`cp .env.example .env`). The `{env:HF_TOKEN}` syntax in the config
     resolves from the environment.
5. **Run from the repo root** — the config path resolves from the current
   working directory.

## lib/ — shared prototype plumbing

- `config.mjs` — reads `grandma-kat.config.json`, loads `.env`, resolves
  `{env:VAR}` API keys.
- `llm.mjs` — direct OpenAI-compatible chat calls (what the prototypes use
  instead of the grandma-kat runner).
- `logger.mjs` — per-call JSON file logging for the prototypes.
- `mcp.mjs` — starts `browser-mcp/scrape-server.mjs` over stdio and wraps
  `client.callTool`.

The tree example uses `config.mjs` and `mcp.mjs` too — models and tools are
just runtime arguments to `grandma.knit()`.

## browser-mcp/ — the tool server

A standalone MCP server (own `package.json`, own `node_modules`) that
drives Chrome over the DevTools protocol. Exposes ~20 tools — `navigate`,
`click_selector`, `exec_js`, `exec_js_in_scope`, `scan_clickables`,
`snapshot`, `wait_for_load`, `screenshot`, …

Note the decoupling: grandma-kat never imports MCP code. `entry.mjs` maps
these tools into a plain `{ description, parameters, execute }` registry,
which is all the tree ever sees.

## Logs

- **Prototypes** — one JSON per LLM call: `logs/<script>/<run-id>/`.
- **find-address** — `entry.mjs` runs with `logLevel: 'debug'`, so the full
  trace (prompts, reasoning, tool calls, checks, flow events) streams to
  the console. Add `logger: true` to the `knit()` call to also get the
  SQLite call log at `logs/grandma-kat.db` (see the main README's logging
  section).

## Further reading

- [`examples/AGENTS.md`](AGENTS.md) — the underlying Threads spec and the
  prototype→tree conversion conventions (written for the LLM agents that
  author trees, useful for humans too).
- [Main README](../README.md) — the library itself: concepts, runtime
  options, full API reference.
