// Contact matching: turn an input object into a profile id, or a reason why
// it cannot be matched. Shared by upsert.js (create-or-update) and
// messages.js (log a message against an existing contact).
//
//   match: id -> email address -> first (+last) name   (case-insensitive)
//
// `{ id: null, by: null }` means "no match found" (the caller decides whether
// that means "create" or "error").

import { getProfile, findIdsByEmail, findIdsByName } from "./db.js";

export function idFrom(input) {
  const raw = input.id ?? input.profile_id ?? input.profileId;
  if (raw == null || raw === "") return null;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new Error(`id must be a positive integer, got ${raw}`);
  return id;
}

/**
 * Decide which profile the input refers to.
 * @returns {{ id: number|null, by: string|null, error?: string }}
 *          `id: null` means "no match" (create, or error, depending on caller).
 */
export function findMatch(input, normalized) {
  const id = idFrom(input);
  if (id != null) {
    return getProfile(id)
      ? { id, by: "id" }
      : { id: null, by: null, error: `no contact with id ${id}` };
  }

  const email = normalized.lists.find((l) => l.attr === "email")?.items[0];
  if (email) {
    const ids = findIdsByEmail(email.value.address);
    if (ids.length === 1) return { id: ids[0], by: "email" };
    if (ids.length > 1) {
      return {
        id: null,
        by: null,
        error: `${ids.length} contacts share ${email.value.address} (ids ${ids.join(", ")}) — pass id to pick one`,
      };
    }
  }

  const firstName = normalized.scalars.find((s) => s.attr === "first_name")?.value;
  if (firstName) {
    const lastName = normalized.scalars.find((s) => s.attr === "last_name")?.value;
    const ids = findIdsByName(firstName, lastName);
    if (ids.length === 1) return { id: ids[0], by: "name" };
    if (ids.length > 1) {
      const name = [firstName, lastName].filter(Boolean).join(" ");
      return {
        id: null,
        by: null,
        error: `${ids.length} contacts are named ${name} (ids ${ids.join(", ")}) — pass id to pick one`,
      };
    }
  }

  if (!firstName && !email) {
    return {
      id: null,
      by: null,
      error: "nothing to match on — pass id, first_name, or an email address",
    };
  }

  return { id: null, by: null };
}
