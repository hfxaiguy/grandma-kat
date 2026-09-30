// Deep-context briefing: turn a full contact (the object `toContact` builds)
// into a compact text a caller can read before dialing — who they are, what
// they do, what we promised, and the most recent message history.

import { localTimeNote } from "./timezone.js";

const truncate = (s, n) => {
  const t = String(s ?? "").trim();
  return t.length > n ? t.slice(0, n) + "\u2026" : t;
};

const join = (values) =>
  (Array.isArray(values) ? values : [])
    .map((v) => String(v ?? "").trim())
    .filter(Boolean)
    .join(", ");

/** "2026-09-30T14:00 — call back (promise); after 6pm (window)" — open only. */
function followupsText(followups) {
  const open = (Array.isArray(followups) ? followups : [])
    .filter((f) => (f?.status ?? "open") === "open")
    .sort((a, b) => String(a?.at ?? "9999").localeCompare(String(b?.at ?? "9999")));
  if (!open.length) return "";
  return open
    .map((f) => {
      const when = [f?.at, f?.until ? `until ${f.until}` : ""].filter(Boolean).join(" ");
      const what = f?.note || f?.kind || "follow up";
      return `${when ? `${when} — ` : ""}${what}${f?.kind ? ` (${f.kind})` : ""}`;
    })
    .join("; ");
}

function messagesText(messages, recent) {
  const msgs = (Array.isArray(messages) ? messages : []).slice(-recent);
  if (!msgs.length) return "";
  return msgs
    .map((m) => {
      const meta = [m?.channel, m?.outcome, m?.status, m?.dateSent].filter(Boolean).join(" ");
      return `  [${meta}] ${truncate(m?.text, 120)}`;
    })
    .join("\n");
}

/**
 * @param {object} contact  Full contact object from the contacts app.
 * @param {{ recentMessages?: number, now?: Date, homeZone?: string }} opts
 *   `now`/`homeZone` are test seams for the local-time line.
 * @returns {string} Multi-line briefing (empty string for a null contact).
 */
export function briefContact(contact, { recentMessages = 5, now, homeZone } = {}) {
  if (!contact) return "";

  const header = contact.name ? `${contact.name} (#${contact.id})` : `#${contact.id}`;
  const meta = [
    contact.groups?.length ? join(contact.groups) : "",
    contact.connection_level ? String(contact.connection_level) : "",
    contact.met ? `met ${contact.met}` : "",
  ].filter(Boolean);

  const lines = [meta.length ? `${header} \u2014 ${meta.join(" \u00b7 ")}` : header];

  const add = (label, value) => {
    const v = Array.isArray(value) ? join(value) : String(value ?? "").trim();
    if (v) lines.push(`${label}: ${v}`);
  };

  add("Company", contact.companies);
  add("Profession", contact.professions);
  add(
    "Email",
    (contact.emails ?? []).map((e) => e?.address).filter(Boolean).join(", "),
  );
  add("Interests", contact.interests);
  add(
    "Location",
    (contact.locations ?? [])
      .map((l) => [l?.city, l?.region, l?.country].filter(Boolean).join(", "))
      .filter(Boolean)
      .join("; "),
  );
  // Local time + how far it is from the caller's zone (omitted when the
  // location is missing or its zone cannot be resolved).
  add("Local time", localTimeNote((contact.locations ?? [])[0], { now, homeZone }));
  add("Notes", contact.notes);
  add("Promises", contact.promises);
  add("Proposals", contact.proposals);
  add("Follow-ups", followupsText(contact.followups));
  add("Podcasts", contact.podcasts);
  if (contact.relationships?.length) {
    add("Related", contact.relationships.map((r) => r?.name).filter(Boolean).join(", "));
  }

  const history = messagesText(contact.messages, recentMessages);
  if (history) lines.push("Recent:", history);

  return lines.join("\n");
}
