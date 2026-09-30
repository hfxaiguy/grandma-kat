import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));

// The database lives at the workspace root, not inside the app folder, so it
// sits next to comms.db and the rest of the workspace's durable state.
// app/contacts -> app -> workspace root.
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT
  ? path.resolve(process.env.WORKSPACE_ROOT)
  : path.resolve(APP_DIR, "..", "..");

export const config = {
  workspaceRoot: WORKSPACE_ROOT,
  dbPath: process.env.DB_PATH
    ? path.resolve(process.env.DB_PATH)
    : path.join(WORKSPACE_ROOT, "contacts.db"),
};
