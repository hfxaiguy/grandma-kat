// Tool export for a grandma-kat tree.
//
// Same shape the comms package uses (communications/src/tools.mjs):
// { name, description, parameters, execute }. The harness merges it into the
// runtime's tools:
//
//   import { tools as contactTools } from "<workspace>/app/contacts/src/tools.js";
//   const allTools = { ...katTools, ...Object.fromEntries(contactTools.map(t => [t.name, t])) };
//
// A branch then just names it: .tools("upsert_contact")

import { upsertContact } from "./upsert.js";
import { logMessage } from "./messages.js";
import { getContact, searchContacts } from "./search.js";

const str = (description) => ({ type: "string", description });
const strs = (description) => ({ type: "array", items: { type: "string" }, description });
const bool = (description) => ({ type: "boolean", description });
const objects = (description, properties) => ({
  type: "array",
  items: { type: "object", properties },
  description,
});

export const tools = [
  {
    name: "upsert_contact",
    description:
      "Add a contact, or update the one that already exists. The contact is matched by id, else by email address, else by first (+last) name (matching is case-insensitive); when nothing matches a new contact is created. Single-value fields (names, connection level, where met) are replaced; multi-value fields (groups, emails, phones, notes, companies, follow-ups, ...) are appended unless that same value is already stored, so calling this twice with the same input is a no-op (a follow-up with the same note updates in place — pass its other fields too when changing status). Returns { ok, profileId, created, matchedBy, added, replaced, contact } — the contact is the full stored profile after the change; on a problem it returns { ok: false, error } (e.g. several contacts share that name, so pass id).",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "integer",
          description: "Contact id to update. Omit to match by email, then by name.",
        },
        create: bool(
          "Force a new contact even when one matches by name (use when the person is known to be new, e.g. a first-name-only referral).",
        ),
        first_name: str("First name. Required when creating a contact."),
        last_name: str("Last name."),
        groups: strs("Groups / lists this contact belongs to."),
        connection_level: str("How well we know them, e.g. 'close', 'acquaintance'."),
        met: str("Where or how we met."),
        emails: objects("Email addresses.", {
          address: str("Address"),
          label: str("e.g. work"),
          id: str("Stable read-only reference id (auto 'eml_XXXXXXXX' when omitted)"),
          source: str("Where the address came from, e.g. 'enrich-profile: acme.com'"),
        }),
        phones: objects("Phone numbers.", {
          number: str("Number"),
          label: str("e.g. mobile"),
          id: str("Stable read-only reference id (auto 'phn_XXXXXXXX' when omitted)"),
          status: str("'valid' or 'invalid' — an invalid number was tried and rejected"),
          note: str("Lasting fact about the line, e.g. 'voicemail box not set up' (pass the other fields too when updating)"),
          source: str("Where the number came from, e.g. 'caller-list: wrong-number'"),
        }),
        websites: objects("Websites.", { url: str("URL"), label: str("Label") }),
        socials: objects("Social profiles.", { url: str("Profile URL"), label: str("Platform") }),
        locations: objects("Locations.", {
          city: str("City"),
          region: str("Province / state"),
          country: str("Country"),
          street: str("Street address, e.g. '204 E. Hill Avenue'"),
          postal: str("Postal / ZIP code"),
          id: str("Stable read-only reference id (auto 'loc_XXXXXXXX' when omitted)"),
          confirmed: bool("True when the address is verified"),
          source: str("Where the address came from, e.g. 'enrich-profile: acme.com, google.com'"),
        }),
        companies: strs("Companies or organizations."),
        professions: strs("Professions, titles or roles."),
        interests: strs("Interests or topics."),
        notes: strs("Notes about this contact."),
        podcasts: strs("Podcasts they appear on or run."),
        promises: strs("Things we promised them."),
        proposals: strs("Things we proposed to them."),
        followups: objects("Scheduled follow-ups: promises we owe and best-time windows.", {
          note: str("What the follow-up is about — its identity, so the same note updates it in place"),
          kind: str("'promise' (we committed to reach back out) or 'window' (their best time to be reached)"),
          at: str("When, ISO 8601 (e.g. '2026-09-30T14:00:00-03:00')"),
          until: str("End of a window, ISO 8601 (optional)"),
          status: str("'open' (default), 'done', or 'cancelled'"),
          id: str("Stable read-only reference id (auto 'fu_XXXXXXXX' when omitted)"),
          source: str("Where it came from, e.g. 'caller-list: caller-promised'"),
        }),
      },
    },
    execute(input) {
      try {
        return upsertContact(input);
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
  },
  {
    name: "get_contact",
    description: "Get one complete contact by numeric id, including groups, attributes, relationships, and message history.",
    parameters: {
      type: "object",
      properties: { id: { type: "integer", description: "Contact id" } },
      required: ["id"],
    },
    execute(input) {
      try {
        return getContact(input?.id);
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
  },
  {
    name: "search_contacts",
    description: "Search contacts by text across stored fields, optionally restricted to an exact group. With neither query nor group it lists contacts up to the limit, so use it to answer \"which contacts exist / were imported\".",
    parameters: {
      type: "object",
      properties: {
        query: str("Text to find in contact fields, such as a name, email, company, or phone."),
        group: str("Exact group/list name to filter by."),
        limit: { type: "integer", description: "Maximum results, default 50, maximum 100." },
      },
    },
    execute(input) {
      try {
        return searchContacts(input);
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
  },
  {
    name: "log_message",
    description:
      "Log a message sent to or received from a contact (email, WhatsApp, SMS, call, ...). The contact is matched by id, else by email address, else by first (+last) name (case-insensitive), exactly like upsert_contact; it must already exist, so create/update the contact first. Stores { text, channel, status, dateSent } plus the optional `outcome` (a structured call result, e.g. 'connected', 'voicemail-left', 'no-answer') and `phone` (the number the call was placed to) — status: sent, received, draft, or failed (a failed call attempt) — and returns { ok, profileId, matchedBy, message, messages } (messages is the full history); on a problem returns { ok: false, error }.",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "integer",
          description: "Contact id. Omit to match by email, then by name.",
        },
        first_name: str("First name of the contact."),
        last_name: str("Last name of the contact."),
        email: str("Email address to match the contact by."),
        text: str("The message text (or email subject)."),
        channel: str("Channel: Email, WhatsApp, SMS, Call, etc."),
        status: str("Status: sent (default), received, draft, or failed."),
        dateSent: str("Date (YYYY-MM-DD); defaults to today."),
        outcome: str("Structured call outcome when the message is a call log, e.g. 'connected', 'voicemail-left', 'no-answer'."),
        phone: str("The number the call was placed to (calls are logged number by number)."),
      },
    },
    execute(input) {
      try {
        return logMessage(input);
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
  },
];
