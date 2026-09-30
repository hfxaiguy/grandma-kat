import { getAttributes, getProfile, getRelationships, listProfileIds } from "./db.js";
import { toContact } from "./fields.js";

function contact(id) {
  const profile = getProfile(id);
  return profile
    ? toContact(profile, getAttributes(id), getRelationships(id))
    : null;
}

export function getContact(id) {
  const profileId = Number(id);
  if (!Number.isInteger(profileId) || profileId < 1) {
    return { ok: false, error: "id must be a positive integer" };
  }
  const result = contact(profileId);
  return result ? { ok: true, contact: result } : { ok: false, error: "contact not found" };
}

export function searchContacts({ query = "", group = "", limit = 50 } = {}) {
  let needle = String(query).trim().toLowerCase();
  if (needle === "*") needle = "";
  const groupNeedle = String(group).trim().toLowerCase();
  const max = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const contacts = [];
  for (const id of listProfileIds()) {
    const result = contact(id);
    if (!result) continue;
    const groupMatch = !groupNeedle || result.groups.some((value) =>
      value.toLowerCase() === groupNeedle);
    const textMatch = !needle || JSON.stringify(result).toLowerCase().includes(needle);
    if (groupMatch && textMatch) contacts.push(result);
    if (contacts.length >= max) break;
  }
  return { ok: true, query, group, count: contacts.length, contacts, limit: max };
}
