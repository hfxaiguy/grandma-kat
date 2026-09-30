import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { config } from "../config.js";

// The comms EAV model: a contact is a `profiles` row, every field of that
// contact is an `attributes` row whose `data` is a JSON value keyed by `type`
// ("first_name", "email", "note", ...). Same schema as the workspace's
// comms.db, so contacts move between the two without translation.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS profiles (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS attributes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  data       TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_attr_profile ON attributes(profile_id);
CREATE INDEX IF NOT EXISTS idx_attr_type    ON attributes(type);

CREATE TABLE IF NOT EXISTS relationships (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  from_profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  to_profile_id   INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  type            TEXT NOT NULL DEFAULT 'related_to',
  created_at      TEXT DEFAULT (datetime('now')),
  UNIQUE(from_profile_id, to_profile_id, type)
);
CREATE INDEX IF NOT EXISTS idx_rel_from ON relationships(from_profile_id);
CREATE INDEX IF NOT EXISTS idx_rel_to   ON relationships(to_profile_id);
`;

mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new DatabaseSync(config.dbPath);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
db.exec(SCHEMA);

export function closeDb() {
  db.close();
}

export function getProfile(id) {
  return db.prepare("SELECT id, created_at FROM profiles WHERE id = ?").get(id) ?? null;
}

/**
 * Run a caller-supplied selection query read-only and return the contact ids
 * it selects. The query must be one SELECT/WITH statement exposing an `id`
 * column; it is wrapped and capped, and runs on a read-only connection so a
 * mis-written query can never mutate contacts.db.
 *
 * @param {string} sql    the selection query
 * @param {number} limit  maximum ids to return (default 500, hard max 5000)
 * @returns {number[]}
 */
export function queryContactIds(sql, limit = 500) {
  const statement = String(sql ?? "").trim().replace(/;\s*$/, "");
  if (!/^(SELECT|WITH)\b/i.test(statement)) {
    throw new Error("selection query must be a single SELECT (or WITH ... SELECT)");
  }
  if (statement.includes(";")) throw new Error("selection query must be one statement");
  const max = Math.min(Math.max(Number(limit) || 500, 1), 5000);
  const ro = new DatabaseSync(config.dbPath, { readOnly: true });
  try {
    const rows = ro.prepare(`SELECT id FROM (\n${statement}\n) LIMIT ${max}`).all();
    return rows.map((row) => Number(row.id)).filter((n) => Number.isInteger(n) && n > 0);
  } finally {
    ro.close();
  }
}

export function listProfileIds() {
  return db.prepare("SELECT id FROM profiles ORDER BY id").all().map((row) => row.id);
}

export function insertProfile() {
  return Number(db.prepare("INSERT INTO profiles DEFAULT VALUES").run().lastInsertRowid);
}

export function getAttributes(profileId) {
  return db
    .prepare(
      `SELECT id, type, data, sort_order
       FROM attributes
       WHERE profile_id = ?
       ORDER BY sort_order, id`,
    )
    .all(profileId);
}

export function insertAttribute(profileId, type, data) {
  const { max_order: order } = db
    .prepare(
      "SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM attributes WHERE profile_id = ?",
    )
    .get(profileId);
  db.prepare(
    "INSERT INTO attributes (profile_id, type, data, sort_order) VALUES (?, ?, ?, ?)",
  ).run(profileId, type, data, order + 1);
}

export function setAttributeData(attributeId, data) {
  db.prepare("UPDATE attributes SET data = ? WHERE id = ?").run(data, attributeId);
}

export function findIdsByEmail(address) {
  return db
    .prepare(
      `SELECT DISTINCT profile_id AS id
       FROM attributes
       WHERE type = 'email'
         AND lower(trim(json_extract(data, '$.address'))) = ?`,
    )
    .all(String(address).trim().toLowerCase())
    .map((r) => r.id);
}

export function findIdsByName(firstName, lastName) {
  const last = lastName == null ? null : String(lastName).trim().toLowerCase();
  const rows = last
    ? db
        .prepare(
          `SELECT DISTINCT p.id
           FROM profiles p
           JOIN attributes f ON f.profile_id = p.id AND f.type = 'first_name'
           JOIN attributes l ON l.profile_id = p.id AND l.type = 'last_name'
           WHERE lower(trim(json_extract(f.data, '$'))) = ?
             AND lower(trim(json_extract(l.data, '$'))) = ?`,
        )
        .all(String(firstName).trim().toLowerCase(), last)
    : db
        .prepare(
          `SELECT DISTINCT p.id
           FROM profiles p
           JOIN attributes f ON f.profile_id = p.id AND f.type = 'first_name'
           WHERE lower(trim(json_extract(f.data, '$'))) = ?`,
        )
        .all(String(firstName).trim().toLowerCase());
  return rows.map((r) => r.id);
}

function profileName(id) {
  const parts = db
    .prepare(
      `SELECT json_extract(data, '$') AS v
       FROM attributes
       WHERE profile_id = ? AND type IN ('first_name', 'last_name')
       ORDER BY sort_order, id`,
    )
    .all(id)
    .map((r) => String(r.v ?? "").trim())
    .filter(Boolean);
  return parts.length ? parts.join(" ") : null;
}

/**
 * Append a `message` attribute (a sent/received email, WhatsApp, SMS, call,
 * ...) to a profile. Same shape the comms package logs — `data` is the JSON
 * value the `message` attribute stores, e.g.
 * { text, channel, status, dateSent }.
 */
export function logMessage(profileId, data) {
  insertAttribute(profileId, "message", JSON.stringify(data));
}

export function getRelationships(profileId) {
  return db
    .prepare(
      `SELECT r.type,
              CASE WHEN r.from_profile_id = ? THEN r.to_profile_id ELSE r.from_profile_id END AS id
       FROM relationships r
       WHERE r.from_profile_id = ? OR r.to_profile_id = ?
       ORDER BY r.id`,
    )
    .all(profileId, profileId, profileId)
    .map((r) => ({ type: r.type, id: r.id, name: profileName(r.id) }));
}
