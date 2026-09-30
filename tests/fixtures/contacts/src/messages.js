// Message logging: record a message sent to or received from a contact.
//
//   logMessage({ first_name: "Ann", text: "...", channel: "Email" })
//     -> match: id -> email -> first (+last) name (must already exist)
//     -> store a `message` attribute: { text, channel, status, dateSent }
//     -> return { ok, profileId, matchedBy, message, messages }
//
// A message is *not* a contact field: it is a log entry keyed to the profile,
// stored under the same `message` attribute type the comms package uses, so
// history stays compatible with comms.db.

import { getAttributes, logMessage as insertMessage } from "./db.js";
import { normalizeInput, parseData, text } from "./fields.js";
import { findMatch } from "./match.js";

const today = () => new Date().toISOString().slice(0, 10);

const STATUS = {
  sent: "sent",
  outgoing: "sent",
  received: "received",
  incoming: "received",
  draft: "draft",
  failed: "failed",
};

/**
 * Log a message against a contact.
 *
 * @param {object} input  { id? | first_name?/last_name? | email?,
 *                          text, channel, status?/direction?, dateSent?/date? }
 *   `text` and `channel` are required; `status` defaults to "sent"
 *   (`received`, `draft`, and `failed` are kept as given), `dateSent`
 *   defaults to today. The contact is matched exactly like
 *   upsertContact (id -> email -> name) and must already exist.
 * @returns {{ ok: boolean, profileId?: number, matchedBy?: string,
 *   message?: object, messages?: Array, error?: string }}
 */
export function logMessage(input) {
  if (input == null || typeof input !== "object") {
    return { ok: false, error: "expected a message object" };
  }

  const match = findMatch(input, normalizeInput(input));
  if (match.error) return { ok: false, error: match.error };
  if (match.id == null) {
    return {
      ok: false,
      error: "no contact matches — create it with upsert_contact first (pass id, email, or first/last name)",
    };
  }

  const messageText = text(input.text ?? input.message ?? input.body);
  const channel = text(input.channel ?? input.medium ?? input.via);
  if (!messageText) return { ok: false, error: "message text is required" };
  if (!channel) return { ok: false, error: "channel is required (e.g. Email, WhatsApp, SMS)" };

  const status = STATUS[text(input.status ?? input.direction).toLowerCase()] ?? "sent";
  const dateSent =
    text(input.dateSent ?? input.date_sent ?? input.date) || today();
  // Optional structured result (calls: connected, voicemail-left, ...).
  const outcome = text(input.outcome ?? input.callOutcome ?? input.call_outcome);
  // Optional number the call was placed to (calls made number by number).
  const phone = text(input.phone);

  const message = {
    text: messageText,
    channel,
    status,
    dateSent,
    ...(outcome ? { outcome } : {}),
    ...(phone ? { phone } : {}),
  };

  insertMessage(match.id, message);

  return {
    ok: true,
    profileId: match.id,
    matchedBy: match.by,
    message,
    messages: listMessages(match.id),
  };
}

/** All messages logged against a profile, oldest first. */
export function listMessages(profileId) {
  return getAttributes(profileId)
    .filter((a) => a.type === "message")
    .map((a) => parseData(a.data));
}
