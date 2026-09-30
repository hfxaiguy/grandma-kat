// caller-list walk helpers — pure functions, no database access.
//
// The tree fetches contacts through the contacts tools (`get_contact`) and
// calls these to shape the target at the cursor, match a stored phone against
// a caller-supplied number, and parse number text. Keeping them pure is what
// lets the register bodies reach every effect through declared host tools.

import { choosePhone, phoneOrder, toE164 } from "./phone.js";
import { briefContact } from "./brief.js";

export { splitPhones } from "../../contacts/src/index.js";
export { choosePhone, phoneOrder, toE164 };

/** How many previous call notes a number carries into the walk. */
const PHONE_HISTORY = 3;

/**
 * The call notes already logged against one number (format-tolerant: the
 * message may hold "+19025550199" while the phone holds "+1-902-555-0199").
 */
function phoneHistory(messages, number) {
  const wanted = toE164(number);
  return (Array.isArray(messages) ? messages : []).filter((m) => {
    const stored = String(m?.phone ?? "").trim();
    if (!stored) return false;
    return stored === number || (wanted && toE164(stored) === wanted);
  });
}

/** Trim a stored message to what the walk shows for a number. */
function historyNote(m) {
  return {
    ...(m?.channel ? { channel: String(m.channel) } : {}),
    ...(m?.outcome ? { outcome: String(m.outcome) } : {}),
    ...(m?.status ? { status: String(m.status) } : {}),
    ...(m?.dateSent ? { dateSent: String(m.dateSent) } : {}),
    text: String(m?.text ?? ""),
  };
}

/** The open items of a contact's follow-ups, soonest first (no date last). */
export function openFollowups(contact) {
  return (Array.isArray(contact?.followups) ? contact.followups : [])
    .filter((f) => (f?.status ?? "open") === "open")
    .sort((a, b) => String(a?.at ?? "9999").localeCompare(String(b?.at ?? "9999")));
}

/**
 * Build the target at a queue cursor: `{ ids, index, phoneIndex }` plus the
 * contact (fetched via get_contact). The phones are ordered the way the walk
 * dials them (valid first, work before mobile, then stored order) and each
 * carries its own lasting note and the call notes already logged against it.
 * Returns null when the cursor is past the end of the list.
 */
export function targetFrom(contact, queue = {}) {
  const index = queue.index ?? 0;
  const total = queue.ids?.length ?? 0;
  if (index >= total) return null;

  const id = queue.ids[index];
  if (!contact) {
    return {
      id,
      name: `#${id}`,
      phone: null,
      error: "contact not found",
      position: index + 1,
      total,
      remaining: total - index,
    };
  }

  const phones = (Array.isArray(contact.phones) ? contact.phones : [])
    .map((p, i) => {
      const number = String(p?.number ?? "").trim();
      if (!number) return null;
      const history = phoneHistory(contact.messages, number);
      return {
        number,
        label: String(p?.label ?? "").trim(),
        e164: toE164(number),
        i,
        ...(p?.status === "invalid" ? { status: "invalid" } : {}),
        ...(p?.note ? { note: String(p.note).trim() } : {}),
        ...(history.length ? { history: history.slice(-PHONE_HISTORY).map(historyNote) } : {}),
      };
    })
    .filter(Boolean)
    .sort((a, b) => phoneOrder(a) - phoneOrder(b) || a.i - b.i)
    .map(({ i, ...p }) => p);

  const phoneIndex = Math.min(Math.max(Number(queue.phoneIndex) || 0, 0), Math.max(phones.length - 1, 0));
  const current = phones[phoneIndex] ?? null;
  return {
    id: contact.id,
    name: contact.name ?? `#${contact.id}`,
    phone: current?.number ?? null,
    phoneLabel: current?.label ?? "",
    phoneE164: current?.e164 ?? null,
    phoneIndex,
    phones,
    followups: openFollowups(contact),
    brief: briefContact(contact),
    position: index + 1,
    total,
    remaining: total - index,
  };
}

/**
 * Find a stored phone by number, tolerant of formatting: the contact may hold
 * "+1-902-555-0150" while a caller-supplied number normalizes to
 * "+19025550150". Returns the stored item (what an update must target) or null.
 */
export function findStoredPhone(phones, number) {
  const wanted = toE164(number);
  return (Array.isArray(phones) ? phones : []).find(
    (p) => p?.number === number || (wanted && toE164(p?.number) === wanted),
  ) ?? null;
}
