// Manual entry point: upsert one contact from a JSON argument or stdin.
//
//   node src/cli.js '{"first_name":"Ann","emails":["ann@x.com"],"notes":["met at disruptHR"]}'
//   cat contact.json | node src/cli.js

import { upsertContact } from "./upsert.js";
import { closeDb } from "./db.js";
import { config } from "../config.js";

const USAGE = `usage: node src/cli.js '<contact json>'   (or pipe JSON on stdin)
db: ${config.dbPath}`;

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

const arg = process.argv.slice(2).find((a) => !a.startsWith("-"));
const raw = arg ?? (process.stdin.isTTY ? "" : await readStdin());

if (!raw.trim()) {
  console.error(USAGE);
  process.exit(2);
}

let input;
try {
  input = JSON.parse(raw);
} catch (err) {
  console.error(`[contacts] not valid JSON: ${err.message}`);
  process.exit(2);
}

const result = upsertContact(input);
console.log(JSON.stringify(result, null, 2));
closeDb();
process.exit(result.ok ? 0 : 1);
