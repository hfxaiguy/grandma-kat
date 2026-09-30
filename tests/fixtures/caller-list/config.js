import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));

// The queue state lives at the workspace root, next to contacts.db, so the
// CLI and the bot share the same caller-list progress.
// app/caller-list -> app -> workspace root.
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT
  ? path.resolve(process.env.WORKSPACE_ROOT)
  : path.resolve(APP_DIR, "..", "..");

export const config = {
  workspaceRoot: WORKSPACE_ROOT,
  statePath: process.env.CALLER_LIST_STATE
    ? path.resolve(process.env.CALLER_LIST_STATE)
    : path.join(WORKSPACE_ROOT, "caller-list.json"),
  // The caller's own zone; briefs show a contact's local time relative to
  // this. Defaults to the machine's zone (CALLER_TIMEZONE overrides).
  timeZone: process.env.CALLER_TIMEZONE ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
};
