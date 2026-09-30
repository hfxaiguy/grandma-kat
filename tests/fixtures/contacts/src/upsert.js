// The one job: add a contact, or update the contact that is already there.
//
//   match     id -> email address -> first (+last) name; create when nothing matches
//   merge     scalars are replaced, list items are appended unless that same
//             item (same address / number / url / text) is already stored
//
// Re-running with the same input writes nothing, so a tree can call it
// defensively.

import {
  db,
  getProfile,
  insertProfile,
  getAttributes,
  insertAttribute,
  setAttributeData,
  getRelationships,
} from "./db.js";
import { LISTS, normalizeInput, toContact, dedupeOf, parseData, text } from "./fields.js";
import { findMatch } from "./match.js";

const LIST_BY_ATTR = new Map(LISTS.map((spec) => [spec.attr, spec]));

// stderr, so the CLI can print its JSON result on stdout.
const log = (...m) => console.error("[contacts]", ...m);

const today = () => new Date().toISOString().slice(0, 10);

/**
 * A scalar that differs only in case is the same value: matching is
 * case-insensitive, so a re-typed name must not rewrite the stored one.
 */
const sameText = (a, b) => text(a).toLowerCase() === text(b).toLowerCase();

/**
 * Two values of the same list item are equal when every field matches. The
 * identity field (address, number, url) is compared case-insensitively — a
 * re-cased email is the same email, not an update.
 */
function sameValue(spec, a, b) {
  if (typeof a === "string" || typeof b === "string") return a === b;
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  for (const k of keys) {
    const x = text(a?.[k]);
    const y = text(b?.[k]);
    if (k === spec.primary ? x.toLowerCase() !== y.toLowerCase() : x !== y) return false;
  }
  return true;
}

/** Write normalized input onto a profile; report what actually changed. */
function applyChanges(profileId, { scalars, lists }) {
  const byType = new Map();
  for (const row of getAttributes(profileId)) {
    const stored = byType.get(row.type) ?? [];
    stored.push({ id: row.id, data: row.data, value: parseData(row.data) });
    byType.set(row.type, stored);
  }

  const added = [];
  const replaced = [];

  for (const { attr, value } of scalars) {
    const current = byType.get(attr)?.[0];
    if (!current) {
      insertAttribute(profileId, attr, JSON.stringify(value));
      added.push({ type: attr, value });
    } else if (!sameText(current.value, value)) {
      setAttributeData(current.id, JSON.stringify(value));
      replaced.push({ type: attr, value, previous: current.value });
    }
  }

  for (const { attr, items } of lists) {
    const spec = LIST_BY_ATTR.get(attr);
    const current = new Map(
      (byType.get(attr) ?? []).map((row) => [dedupeOf(spec, row.value), row]),
    );
    for (const item of items) {
      const stored = current.get(item.dedupe);
      if (!stored) {
        insertAttribute(profileId, attr, item.data);
        added.push({ type: attr, value: item.value });
      } else if (!sameValue(spec, stored.value, item.value)) {
        setAttributeData(stored.id, item.data);
        replaced.push({ type: attr, value: item.value, previous: stored.value });
      }
    }
  }

  return { added, replaced };
}

/**
 * Add a contact, or update the matching one.
 *
 * @param {object} input  Any mix of: id, first_name, last_name, group,
 *   connection_level, met, emails, phones, websites, socials, locations,
 *   companies, professions, interests, notes, podcasts, promises, proposals.
 *   camelCase keys and string shorthands ("ann@x.com") are accepted.
 * @returns {{ ok: boolean, profileId?: number, created?: boolean,
 *   matchedBy?: string|null, added?: Array, replaced?: Array,
 *   contact?: object, error?: string }}
 */
export function upsertContact(input) {
  if (input == null || typeof input !== "object") {
    return { ok: false, error: "expected a contact object" };
  }

  const normalized = normalizeInput(input);
  // `create: true` forces a new profile even when a name matches: the caller
  // knows this is a different person (e.g. a first-name-only referral).
  const forced = input.create === true || input.create === "true";
  const match = forced ? { id: null, by: null } : findMatch(input, normalized);
  if (match.error) return { ok: false, error: match.error };

  const created = match.id == null;
  let profileId = match.id;
  let added = [];
  let replaced = [];

  db.exec("BEGIN");
  try {
    if (created) {
      profileId = insertProfile();
      if (!normalized.scalars.some((s) => s.attr === "date_added")) {
        normalized.scalars.push({ attr: "date_added", value: today() });
      }
    }
    ({ added, replaced } = applyChanges(profileId, normalized));
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  const contact = toContact(getProfile(profileId), getAttributes(profileId), getRelationships(profileId));

  log(
    created
      ? `profile ${profileId} created (+${added.length})`
      : `profile ${profileId} updated by ${match.by} (+${added.length}, ~${replaced.length})`,
  );

  return { ok: true, profileId, created, matchedBy: match.by, added, replaced, contact };
}
