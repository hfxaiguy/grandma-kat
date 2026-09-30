// caller-list tree — the one-at-a-time call walk, owned by the tree itself:
//
//   !! input
//   ++! conversation (every caller message and every emitted message)
//   ++ queue: null        (the cursor — { ids, index, phoneIndex })
//   ++ current: null      (the target at the cursor)
//   ++ done: true         (nothing to walk until start_call_list says otherwise)
//   #-> …  every tool the tree uses is declared inline in the register block
//          below; each one that touches a database declares the host tools it
//          calls with calls(...) — SQL via BOB, contacts via the contacts app
//   -- read the contacts schema and catalog (contacts_query, read-only)
//   ++ selection_sql, selection_notes, selection_confirmed, match_count
//   () selection review: draft or revise the SELECT -> sample + count ->
//      show the SQL, the rows, then the notes -> pause for confirm
//   () goto draft_sql until the selection is confirmed
//   -> start_call_list: run the confirmed SQL, seed queue / current / done
//   << present the first person (about, then their first number)
//   ++! conversation (the about and phone messages)
//   ()
//   || >> outcome: wait for the caller to report the outcome
//   || ++! conversation (the caller's words)
//   || -- advance: one outcome tool (plus any extras) whose memory patch moves
//   ||    the walk — register results are { value, memory } / { error }, the
//   ||    walk presents from the patched m.current / m.done
//   || ++! conversation (the receipt and whatever was presented)
//   () goto outcome until the list is done
//
// The tree's only import is the pure walk.js helper module; every database
// touch goes through a declared host tool, and every memory write uses the
// marker form Memory(update(), …).

import { findStoredPhone, openFollowups, splitPhones, targetFrom } from "./src/walk.js";
import { Tree, when, max, update, calls, parameters, disableAuto, name, Model, Tools, Needs, Human, Prompt, Memory, Register, Branch, Each, Call, Check, Emit, Return, Until } from "../../../src/index.mjs";

const CONTACTS_DB = "contacts.db";
const SAMPLE_LIMIT = 5;
const MAX_TARGETS = 500;
const REVIEW_ROUNDS = 8;
const FIX_ROUNDS = 6;
/** Long messages are flattened to this before they enter the conversation. */
const CONVO_CHARS = 400;
/** How many conversation messages a prompt replays (oldest first). */
export const CONVO_LIMIT = 10;

// ── the walk's own vocabulary ─────────────────────────────────────────────
// Outcome tables live here now: they feed the tool schemas and the bodies, so
// the tree is their single source.

const CALL_OUTCOMES = [
  "connected",
  "declined",
  "not-interested",
  "callback",
  "gatekeeper",
  "auto-gatekeeper",
  "dropped",
  "voicemail",
  "voicemail-left",
  "no-answer",
  "busy",
  "failed",
  "wrong-contact",
  "wrong-number",
  "disconnected",
  "invalid-number",
  "skipped",
];

/** The target was actually reached; everything else that happened is a draft. */
const SENT = new Set(["connected", "declined", "not-interested", "callback"]);
/** The call itself failed — bad or uncallable number. */
const FAILED = ["failed", "wrong-number", "disconnected", "invalid-number"];
/** Per-number failures: the contact stays on the table with their next number. */
const RETRYABLE = ["no-answer", "busy", "failed", "wrong-contact", "wrong-number", "disconnected", "invalid-number"];
/** The number itself failed, so it is marked status='invalid' on the contact. */
const BAD_NUMBER = ["wrong-number", "disconnected", "invalid-number"];

/** Older outcome names still accepted. */
const LEGACY_OUTCOMES = { sent: "connected", missed: "no-answer", not_interested: "not-interested" };

/** Default note text per outcome (used when the caller gives no note). */
const OUTCOME_TEXT = {
  connected: "called",
  gatekeeper: "reached a gatekeeper",
  "auto-gatekeeper": "reached an automated gatekeeper",
  declined: "declined the call",
  "not-interested": "not interested",
  dropped: "call dropped",
  callback: "asked for a callback",
  voicemail: "reached voicemail",
  "voicemail-left": "left a voicemail",
  "no-answer": "no answer",
  busy: "line busy",
  failed: "call failed",
  "wrong-contact": "spoke to someone else",
  "wrong-number": "wrong number",
  disconnected: "number disconnected",
  "invalid-number": "invalid number",
  skipped: "skipped",
};

const normalizeOutcome = (value) => {
  const key = String(value ?? "").trim().toLowerCase();
  const outcome = LEGACY_OUTCOMES[key] ?? key;
  return CALL_OUTCOMES.includes(outcome) ? outcome : null;
};
const statusForOutcome = (outcome) => (SENT.has(outcome) ? "sent" : FAILED.includes(outcome) ? "failed" : "draft");
const textForOutcome = (outcome) => OUTCOME_TEXT[outcome] ?? "called";

// ── contact access through the declared host tools ────────────────────────

/** Fetch one contact through the contacts tool; null when it is missing. */
async function contactFor(tools, id) {
  const got = await tools.contacts__get_contact({ id });
  return got && got.ok !== false ? (got.contact ?? null) : null;
}

/** Whether a tool result is an error (object with `error`, or an "error…" string). */
const errored = (result) =>
  Boolean(result && typeof result === "object" && "error" in result) ||
  (typeof result === "string" && result.toLowerCase().startsWith("error"));

/** Close a contact's open promises (a connected call settles them). */
async function closeOpenPromises(tools, id) {
  const contact = await contactFor(tools, id);
  const open = openFollowups(contact).filter((f) => f.kind === "promise");
  for (const followup of open) {
    await tools.contacts__upsert_contact({ id, followups: [{ ...followup, status: "done" }] });
  }
  return open.map((f) => f.note || f.at || "follow-up");
}

/** Mark a dialed number status='invalid' on the contact (bad-number outcomes). */
async function markPhoneInvalid(tools, id, number, outcome) {
  if (!number) return;
  const contact = await contactFor(tools, id);
  const stored = findStoredPhone(contact?.phones, number);
  await tools.contacts__upsert_contact({
    id,
    phones: [
      {
        number: stored?.number ?? number,
        label: stored?.label ?? "",
        status: "invalid",
        ...(stored?.note ? { note: stored.note } : {}),
        source: `caller-list: ${outcome}`,
      },
    ],
  });
}

/** Rebuild the target at a queue cursor through the contacts tool. */
async function targetFor(tools, queue) {
  if (!queue || queue.index >= (queue.ids?.length ?? 0)) return null;
  const contact = await contactFor(tools, queue.ids[queue.index]);
  return targetFrom(contact, queue);
}

/** The payload of a register result ({ value } / { error }); a failure reads as undefined. */
const payload = (result) => (result && typeof result === "object" && !("error" in result) ? result.value : undefined);

// ── selection helpers (unchanged shapes, read through the adapter envelope) ─

/** The rows of a contacts_query step, or [] when it failed. */
function rowsOf(m, name) {
  const rows = m.branch?.[name]?.value?.rows;
  return Array.isArray(rows) ? rows : [];
}

/** The error string a contacts_query step returned, or null. */
function toolError(m, name) {
  const result = m.branch?.[name];
  if (result && typeof result === "object") {
    if (typeof result.error === "string") return result.error;
    const r = result.value;
    if (r && typeof r === "object" && typeof r.error === "string") return r.error;
    if (typeof r === "string" && r.toLowerCase().startsWith("error")) return r;
  }
  if (typeof result === "string" && result.toLowerCase().startsWith("error")) return result;
  return null;
}

const trimmed = (sql) => String(sql ?? "").trim().replace(/;\s*$/, "");

/** Wrap a draft SELECT so sample/count can re-query it without editing it. */
const wrapped = (sql) => `SELECT * FROM (\n${trimmed(sql)}\n)`;

const sampleQuery = (sql) => `${wrapped(sql)} LIMIT ${SAMPLE_LIMIT}`;
const countQuery = (sql) => `SELECT COUNT(*) AS n FROM (\n${trimmed(sql)}\n)`;

const short = (value, n) => {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > n ? text.slice(0, n) + "\u2026" : text;
};

function schemaText(m) {
  return rowsOf(m, "schema").map((r) => String(r.sql ?? "")).join("\n");
}

function catalogText(m) {
  return rowsOf(m, "catalog")
    .map((r) => `${r.kind}: ${r.name}${r.n != null ? ` (${r.n})` : ""}`)
    .join("\n");
}

/** Parse the draft prompt's JSON into { sql, notes, confirmed }. */
function parseDraft(value) {
  try {
    const parsed = JSON.parse(String(value ?? "").replace(/^```json\s*|```$/g, "").trim());
    return {
      sql: typeof parsed?.sql === "string" ? parsed.sql.trim() : "",
      notes: typeof parsed?.notes === "string" ? parsed.notes.trim() : "",
      confirmed: parsed?.confirmed === true,
    };
  } catch {
    return { sql: "", notes: String(value ?? "").trim(), confirmed: false };
  }
}

/** The match count from the count query. */
function countFrom(m) {
  const n = Number(m.branch?.count?.value?.rows?.[0]?.n);
  return Number.isFinite(n) ? n : null;
}

/** Message 1 of the review: the SQL on its own, easy to copy. */
function formatSelectionSql(m) {
  return ["Selection SQL:", "", trimmed(m.selection_sql) || "(empty)"].join("\n");
}

/** Message 2 of the review: the count and the sample rows. */
function formatSelectionSummary(m) {
  const lines = [];
  const err = toolError(m, "sample") ?? toolError(m, "count");
  if (err) {
    lines.push(`That draft failed: ${short(err, 300)}`);
  } else {
    const count = countFrom(m);
    const capped = count != null && count > MAX_TARGETS ? ` (the call list caps at ${MAX_TARGETS})` : "";
    lines.push(`Matches ${count ?? "?"} contact${count === 1 ? "" : "s"}${capped}. Sample:`);
    const rows = rowsOf(m, "sample").slice(0, SAMPLE_LIMIT);
    if (!rows.length) lines.push("(no rows)");
    for (const row of rows) lines.push(short(JSON.stringify(row), 220));
  }
  return lines.join("\n");
}

/** Message 3 of the review: the model's notes, then the ask. */
function formatSelectionNotes(m) {
  const lines = [];
  if (m.selection_notes) lines.push(String(m.selection_notes), "");
  lines.push('Reply "yes" to build the call list, or tell me what to change.');
  return lines.join("\n");
}

/** Tools that ride alongside the outcome in the same reply. */
const EXTRA_TOOLS = ["add_call_phone", "note_call_phone", "schedule_followup", "add_call_contact"];

/** Shown when the caller's message was not an outcome for the current person. */
const HOLD_TEXT =
  "I need this person's outcome — tell me what happened, or say \"skip\" to move on. " +
  "(To run a different list, send /clear and describe it.)";

/** The only statement kinds a correction may run (no DDL, no SELECT). */
const FIX_KINDS = new Set(["INSERT", "UPDATE", "DELETE", "REPLACE"]);

/** One statement, no DDL, no semicolons: what the fix review will execute. */
function validFixSql(sql) {
  const statement = trimmed(sql);
  if (!statement) return { ok: false, error: "the draft has no statement" };
  if (statement.includes(";")) return { ok: false, error: "one statement only" };
  const kind = statement.split(/[\s(]/)[0].toUpperCase();
  if (!FIX_KINDS.has(kind)) {
    return { ok: false, error: `only INSERT / UPDATE / DELETE are allowed (got ${kind || "?"})` };
  }
  return { ok: true };
}

/** Parse the fix prompt's JSON into { sql, check, notes, confirmed }. */
function parseFix(value) {
  try {
    const parsed = JSON.parse(String(value ?? "").replace(/^```json\s*|```$/g, "").trim());
    return {
      sql: typeof parsed?.sql === "string" ? parsed.sql.trim() : "",
      check: typeof parsed?.check === "string" ? parsed.check.trim() : "",
      notes: typeof parsed?.notes === "string" ? parsed.notes.trim() : "",
      confirmed: parsed?.confirmed === true,
    };
  } catch {
    return { sql: "", check: "", notes: String(value ?? "").trim(), confirmed: false };
  }
}

/** The proposal the caller reviews: the statement, what it does, its rows. */
function formatFix(m) {
  const invalid = validFixSql(m.fix_sql);
  const lines = ["Proposed fix:", "", trimmed(m.fix_sql) || "(empty)", ""];
  if (m.fix_notes) lines.push(String(m.fix_notes), "");
  const err = toolError(m, "fix_check");
  if (err) {
    lines.push(`The preview failed: ${short(err, 300)}`);
  } else {
    const rows = rowsOf(m, "fix_check").slice(0, 5);
    lines.push(`Rows this will affect (${rows.length} shown):`);
    if (!rows.length) lines.push("(none)");
    for (const row of rows) lines.push(short(JSON.stringify(row), 220));
  }
  if (!invalid.ok) lines.push("", `That draft cannot run: ${invalid.error}`);
  lines.push("", 'Reply "yes" to apply it, or tell me what to change.');
  return lines.join("\n");
}

/** The receipt after the fix ran (or the error when it did not). */
function fixReceipt(m) {
  const result = m.fix_result;
  if (!result || typeof result !== "object" || errored(result) || payload(result) == null) {
    return `The fix did not run: ${result?.error ?? "unknown error"}`;
  }
  const changes = Number(payload(result)?.changes);
  return `Fixed: ${changes} row${changes === 1 ? "" : "s"} changed${m.fix_notes ? ` — ${m.fix_notes}` : ""}.`;
}

/** Every tool result from the advance prompt, in call order. */
function advanceResults(m) {
  return m.raw.branch.advance_prompt?.toolResults ?? [];
}

/**
 * One conversation entry, flattened and truncated: the slot keeps the whole
 * run, but long blobs (the selection SQL, a brief) would drown the exchange
 * that matters inside a prompt window.
 */
const convoEntry = (role, text) => ({ role, text: short(text, CONVO_CHARS) });

/**
 * Append entries to the conversation, oldest first. The slot is declared on
 * the root, so writes from nested branches land there and survive rewinds.
 */
function convoAppend(list, ...entries) {
  const next = Array.isArray(list) ? [...list] : [];
  for (const entry of entries) if (entry?.text) next.push(entry);
  return next;
}

/** The last CONVO_LIMIT conversation messages, oldest first, as prompt context. */
function conversationText(m) {
  const rows = Array.isArray(m.conversation) ? m.conversation.slice(-CONVO_LIMIT) : [];
  if (!rows.length) return "(none)";
  return rows.map((r) => `${r.role === "caller" ? "Caller" : "You"}: ${r.text}`).join("\n");
}

/** The number at the target's dial cursor (clamped to the list). */
function phoneAt(target) {
  const phones = Array.isArray(target?.phones) ? target.phones : [];
  if (!phones.length) return null;
  const i = Math.min(Math.max(Number(target.phoneIndex) || 0, 0), phones.length - 1);
  return phones[i];
}

/**
 * Message 1 of a target: who they are and the deep context, no numbers.
 * The numbers follow one per message (presentPhone) so each gets its own
 * turn, its own report, and its own tap-to-dial link in Telegram.
 */
function presentAbout(target) {
  if (!target) return "No contacts matched the selection.";
  const lines = [`${target.position}/${target.total} \u2014 ${target.name}`];
  if (!Array.isArray(target.phones) || !target.phones.length) lines.push("Phone: (no phone)");
  if (target.brief) lines.push(target.brief);
  return lines.join("\n");
}

/** "number 2 of 3" — tells the advance prompt a next number exists. */
function phoneLine(target) {
  if (!target) return "no phone";
  const total = Array.isArray(target.phones) ? target.phones.length : 0;
  if (!total) return "no phone";
  const index = Math.min(Math.max(Number(target.phoneIndex) || 0, 0), total - 1);
  const note = target.phones[index]?.note;
  return `${target.phone ?? "no phone"} — number ${index + 1} of ${total}${note ? `; note: ${note}` : ""}`;
}

/**
 * Message 2: the number on the table, e.g. "Phone 2/3: +1 ... (mobile)".
 * The number's own lasting note rides on the first line; the call notes
 * already logged against it follow, one indented line each.
 */
function presentPhone(target) {
  if (!target) return "";
  const phone = phoneAt(target);
  if (!phone) return "Phone: (no phone)";
  const total = target.phones.length;
  const index = Math.min(Math.max(Number(target.phoneIndex) || 0, 0), total - 1);
  const lines = [
    `Phone ${index + 1}/${total}: ${phone.number}${phone.label ? ` (${phone.label})` : ""}${phone.note ? ` — ${phone.note}` : ""}`,
  ];
  for (const h of Array.isArray(phone.history) ? phone.history : []) {
    const meta = [h.channel, h.outcome, h.status, h.dateSent].filter(Boolean).join(" ");
    lines.push(`  [${meta}] ${short(h.text, 160)}`);
  }
  return lines.join("\n");
}

/**
 * The receipt for one exchange: what was logged, closed, saved, and recorded —
 * deterministic, so the caller sees exactly what their words did.
 */
function ackText(m) {
  const result = m.advance_result ?? {};
  const lines = [];
  const note = String(m.outcome ?? "").replace(/\s+/g, " ").trim();
  if (result.outcome) {
    const id = result.completed ?? result.contactId ?? result.skipped ?? "?";
    const who = `${result.contactName ?? "contact"} (#${id})`;
    const where = result.attempted ? ` on ${result.attempted}` : "";
    lines.push(`Logged ${result.outcome} for ${who}${where}${note ? ` — "${short(note, 160)}"` : ""}.`);
  }
  if (result.closed?.length) lines.push(`Closed follow-up: ${result.closed.join("; ")}.`);
  for (const extra of result.extras ?? []) {
    if (extra?.needsConfirmation) {
      const list = (extra.candidates ?? [])
        .map((c) => `#${c.id} ${c.name}${c.company ? ` (${c.company})` : ""}`)
        .join(", ");
      lines.push(
        `A contact named ${extra.contactName} already exists — ${list}. Create a new ${extra.contactName}, or use one of those?`,
      );
      continue;
    }
    if (extra?.error) {
      lines.push(`Could not save that: ${extra.error}.`);
      continue;
    }
    if (extra?.added) {
      const list = extra.added
        .map((a) => `${a.number}${a.label ? ` (${a.label})` : ""}${a.note ? ` — "${a.note}"` : ""}`)
        .join(", ");
      lines.push(
        `Saved ${list} to ${extra.contactName ?? "the contact"}${extra.dialed ? ` — dialing ${extra.dialed} now` : ""}.`,
      );
    }
    if (extra?.noted) {
      lines.push(
        `Noted on ${extra.noted.number}${extra.noted.label ? ` (${extra.noted.label})` : ""}: "${extra.noted.note}".`,
      );
    }
    if (extra?.created !== undefined && extra.contactName) {
      const what = extra.created ? "Created" : "Updated";
      const at = extra.company ? ` — ${extra.company}` : "";
      const via = extra.linkedTo
        ? ` (from the call with ${extra.linkedTo.name} (#${extra.linkedTo.id}))`
        : "";
      lines.push(`${what} ${extra.contactName} (#${extra.id})${at}${via}.`);
    }
    if (extra?.followup) {
      const f = extra.followup;
      lines.push(
        `Recorded ${f.kind ?? "follow-up"}${f.at ? ` for ${f.at}` : ""}${f.note ? ` — "${f.note}"` : ""}.`,
      );
    }
  }
  if (result.referenced) {
    lines.push(`Still on ${m.current?.name ?? "the current contact"} (${phoneLine(m.current)}).`);
  }
  return lines.join("\n");
}

  //   () selection review loop — unnamed: nothing reads its exported value;
  //   the slots it updates are declared on the root so they survive rewinds.
  //
  //   || -- draft or revise the selection SQL from the request and feedback
  const selectionReview = Tree(Prompt("draft_sql", (m) => [
      {
        role: "system",
        content:
          `You select contacts for a call list by writing one SQLite SELECT against contacts.db.

The schema is EAV:
- profiles(id, created_at)
- attributes(profile_id, type, data, sort_order, created_at) — data is JSON
- relationships(from_profile_id, to_profile_id, type)

How the data is stored:
- names, emails and groups are attributes.type in ('first_name','last_name','email','group', ...) and their data is a JSON-encoded string, quotes included.
- phones are attributes.type='phone' with JSON {"number","label"}; the number is json_extract(data,'$.number').
- messages are attributes.type='message' with JSON {"text","channel","status","dateSent"}; channel 'Call' means the person was already contacted (calls are logged under this channel).
- follow-ups are attributes.type='followup' with JSON {"kind","note","at","until","status"}; kind is 'promise' (we owe a call) or 'window' (their best time), and open means status is missing or 'open'.

Comparing and selecting scalar strings — always go through json_extract:
  json_extract(a.data,'$') = 'Harbr Campaign 2'   -- correct
  a.data = 'Harbr Campaign 2'                     -- always false (data is '"Harbr Campaign 2"')
Select them extracted too: json_extract(a.data,'$') AS name.

Example for "call group X who have a phone and haven't been contacted":
  SELECT p.id AS id,
         (SELECT json_extract(a.data,'$') FROM attributes a WHERE a.profile_id = p.id AND a.type = 'first_name' LIMIT 1) AS first_name,
         (SELECT json_extract(a.data,'$.number') FROM attributes a WHERE a.profile_id = p.id AND a.type = 'phone' LIMIT 1) AS phone
  FROM profiles p
  WHERE EXISTS (SELECT 1 FROM attributes g WHERE g.profile_id = p.id AND g.type = 'group' AND json_extract(g.data,'$') IN ('Harbr Campaign 2'))
    AND EXISTS (SELECT 1 FROM attributes ph WHERE ph.profile_id = p.id AND ph.type = 'phone')
    AND NOT EXISTS (SELECT 1 FROM attributes m WHERE m.profile_id = p.id AND m.type = 'message' AND json_extract(m.data,'$.channel') = 'Call')
  ORDER BY p.id

Rules:
- One SELECT only; never write (no INSERT/UPDATE/DELETE/DDL).
- Select profiles.id AS id plus readable columns for the sample (name, phone, group, and anything the request implies).
- Give every output column a unique alias.
- Match the request's group against the exact group values in the catalog; pick the closest catalog value when the request names one loosely.
- When the request implies calling, require a phone:
  EXISTS (SELECT 1 FROM attributes a WHERE a.profile_id = p.id AND a.type = 'phone')
- "haven't been contacted" / "not contacted" means:
  NOT EXISTS (SELECT 1 FROM attributes a WHERE a.profile_id = p.id AND a.type = 'message' AND json_extract(a.data,'$.channel') = 'Call')
- "due for a callback" / "I promised to call" / "best time to reach" means:
  EXISTS (SELECT 1 FROM attributes f WHERE f.profile_id = p.id AND f.type = 'followup'
    AND json_extract(f.data,'$.kind') = 'promise'
    AND json_extract(f.data,'$.status') IS NOT 'done' AND json_extract(f.data,'$.status') IS NOT 'cancelled'
    AND date(json_extract(f.data,'$.at')) <= date('now'))
- Add a stable ORDER BY (e.g. p.id).
- Return JSON only: {"sql":"...","notes":"one short sentence on what it selects and why","confirmed":false}.
- Set confirmed true only when the caller's feedback clearly approves the SQL shown last round; return that SQL unchanged. Otherwise keep confirmed false and apply their corrections.
Do not add commentary outside the JSON.`,
      },
      {
        role: "user",
        content: [
          `Call request:\n${m.input}`,
          `Tables:\n${schemaText(m) || "(schema unavailable)"}`,
          `Catalog (attribute types, groups, phone samples):\n${catalogText(m) || "(catalog unavailable)"}`,
          `Previous SQL:\n${m.selection_sql ? trimmed(m.selection_sql) : "(none \u2014 first draft)"}`,
          `Previous sample rows:\n${
            rowsOf(m, "sample").slice(0, SAMPLE_LIMIT).map((r) => JSON.stringify(r)).join("\n") || "(none)"
          }`,
          `Previous match count: ${countFrom(m) ?? "?"}`,
          `Caller feedback:\n${m.selection_reply ?? "(none)"}`,
          "Return the JSON now.",
        ].join("\n\n"),
      },
    ])
    // ++ selection_sql, selection_notes, selection_confirmed — marker-form
    // updates write to the declaring scope (the root), so the values survive
    // each loop rewind and the start step reads them after the loop exits.
    , Memory(update(), "selection_sql", (m) => parseDraft(m.branch.draft_sql).sql)
    , Memory(update(), "selection_notes", (m) => parseDraft(m.branch.draft_sql).notes)
    // A confirmation only counts after a round actually paused for feedback.
    , Memory(update(), "selection_confirmed", (m) =>
      m.selection_reply != null && parseDraft(m.branch.draft_sql).confirmed === true)
    // -- sample + count the fresh draft (read-only; errors are shown, not fatal)
    , Call("sample", "contacts_query", (m) => ({ query: sampleQuery(m.selection_sql) }))
    , Call("count", "contacts_query", (m) => ({ query: countQuery(m.selection_sql) }))
    , Memory(update(), "match_count", (m) => countFrom(m))
    // << show the SQL, the count + sample rows, then the notes + ask
    // (unconfirmed only) — three messages, so the statement is one copyable
    // block and the notes stand alone on Telegram.
    , Emit(when((m) => m.selection_confirmed !== true), (m) => ({ text: formatSelectionSql(m) }))
    , Emit(when((m) => m.selection_confirmed !== true), (m) => ({ text: formatSelectionSummary(m) }))
    , Emit(when((m) => m.selection_confirmed !== true), (m) => ({ text: formatSelectionNotes(m) }))
    // ++ conversation — what the review showed (the same gate as the emits).
    , Memory(when((m) => m.selection_confirmed !== true), update(), "conversation", (m) =>
      convoAppend(
        m.conversation,
        convoEntry("bot", formatSelectionSql(m)),
        convoEntry("bot", formatSelectionSummary(m)),
        convoEntry("bot", formatSelectionNotes(m)),
      ))
    // >> wait for the caller to confirm or correct it (unconfirmed only, so
    // the confirming round runs straight through to the start call)
    , Branch(when((m) => m.selection_confirmed !== true), Tree(Human("selection_reply")))
    // ++ conversation — the caller's feedback, only when this round actually
    // paused for it (the reply slot survives the rewind, so an ungated append
    // would log it twice).
    , Memory(when((m) => m.selection_confirmed !== true), update(), "conversation", (m) =>
      m.selection_reply != null
        ? convoAppend(m.conversation, convoEntry("caller", m.selection_reply))
        : (m.conversation ?? []))
    , Until((m) => m.selection_confirmed === true, max(REVIEW_ROUNDS, (m) => `selection review limit: ${m.error ?? "stuck"}`)));

  //   || -- advance: complete or skip based on the caller's report, plus any
  //   numbers, follow-ups or new people the same words carry, on the current
  //   target or an earlier contact named in the conversation.
  const advance = Tree(name("advance")
    , Tools(
      "complete_call_target",
      "try_next_phone",
      "skip_call_target",
      "add_call_phone",
      "note_call_phone",
      "schedule_followup",
      "add_call_contact",
      "correct_record",
    )
    // disableAuto: the tree owns the walk. This prompt is one reporting
    // round — the model calls the outcome tool(s) for the caller's words,
    // the tree advances from the results (see the .return below). It must
    // not feed the results back and let the model keep calling tools.
    , Prompt(disableAuto(), "advance_prompt", (m) => [
      {
        role: "system",
        content:
          `You advance a caller list. You are given the current target, which of their numbers is on
the table, and what the caller said.

Call exactly one outcome tool:
- try_next_phone when this number did not reach the person (rang out, busy, failed to place, a
  dead/wrong number, or someone else answered): set outcome to that result ('no-answer', 'busy',
  'failed', 'wrong-contact', 'wrong-number', 'disconnected', 'invalid-number') and put the caller's
  words in note. The same person stays on the table with their next number. Use 'wrong-contact'
  when someone else answered — the target left, moved desks, or the number belongs to a different
  business — and when that call turned up a better number, save it in the same reply with
  add_call_phone and dialNow true so it is dialed now.
- complete_call_target when the call settled this contact: talked to the target, reached voicemail,
  left a message, a gatekeeper or automated screener answered, they declined or are not interested,
  the call dropped, they asked for a callback, or the caller says they are finished with this
  person. Set outcome to the closest match
  (connected, declined, not-interested, callback, gatekeeper, auto-gatekeeper, voicemail,
  voicemail-left, dropped, failed) and put the caller's words in note. Use auto-gatekeeper for
  automated screeners (Google call screening, IVR).
- skip_call_target when the caller says to skip this person (reason = their words).

When the words also carry details, call these in the same reply:
- add_call_phone when a phone number is given ("her cell is 555-0134", "the head office number is
  252-291-5521"): number is the number text as said, label when stated, dialNow true when that
  person is the one on the table and the new number should be dialed next (a better number learned
  on the call, or a corrected one), and note for a lasting fact about that line.
- note_call_phone when the caller says something lasting about the line itself ("voicemail box not
  set up", "this number is the boutique / a different company", "ask for the front desk", "press 0
  for operator", "dial extension 214"): note is the observation. This is not the call outcome — the
  outcome and its note still go to an outcome tool, and when one report carries both (e.g. "press 0
  for operator, left voicemail") call the outcome tool AND note_call_phone in the same reply; never
  bury the dialing fact in the outcome note alone. Pass phone explicitly (the number as shown in
  the conversation) whenever an outcome tool is in the same reply — the outcome advances the walk
  before the note runs — and pass phone together with contactId for an earlier contact.
- schedule_followup when a callback is promised or a good time is named ("call back tomorrow at 2",
  "try him after 6"): kind 'promise' (we owe a call) or 'window' (their best time), a short note,
  and at/until as ISO 8601 with the offset, resolved against the person's local time (their brief
  has a Local time line) and today's date.
- add_call_contact when the call turns up a new person worth keeping ("the new person in credit is
  TJ", "ask for Dana in purchasing", "he's been replaced by Kim"): first_name plus whatever is
  known (last_name, company, profession, email, phone, label) and a short note; they are linked to
  the person on the call. Use it even when only a first name is known. If it answers that a
  same-name contact already exists, relay the candidates and wait — when the caller answers, call
  it again with create true (new contact) or id (the one they chose).

Acting on an earlier contact: the conversation shows each person with their #id. If the report is
about someone from that list rather than the person on the table, pass that #id as contactId to the
tool — the update is saved on them and the list stays where it is. Omit contactId for the current
target, and never use an id that is not in the conversation.

The conversation is the last few caller and bot messages (each target's #id and the number as it
was presented, the caller's words, the receipts — including a save that failed and why — and what
was sent). Use it to interpret the latest report when it refers to an earlier call — e.g. "also
not in service" continues the number or person just reported, and when an earlier save failed for
a missing number ("which number?"), the caller's next message supplies it: retry that tool with
the phone from the conversation. Every note you store (the call note and the follow-up note) must
be a self-contained sentence about this contact: expand a reference into what actually happened
("left a voicemail; caller will call back tomorrow"), never store "same as last" or a fragment
like "said will call tomorrow".

If the message is not about a person on this list at all — a question, a new request (e.g. "let's
call today's import"), or a correction with no call details — call no tool and reply with one short
line about what you need. Never skip a person unless the caller asked to skip them.`,
      },
      {
        role: "user",
        content:
          `Conversation (last ${CONVO_LIMIT}, oldest first):\n${conversationText(m)}\n\n` +
          `Today (caller's date): ${new Date().toISOString().slice(0, 10)}\n` +
          `Current target:\n${m.current ? `#${m.current.id} ${m.current.name}` : "(none)"} (${phoneLine(m.current)})\n\n` +
          `The caller reported:\n${m.outcome ?? ""}`,
      },
    ])
    // The outcome tool's value drives the walk: it carries the receipt fields,
    // while the return's `memory` patch has already moved queue/current/done.
    // Extras (numbers, notes, follow-ups, new people) ride along.
    , Return((m) => {
      const results = advanceResults(m);
      // Unwrap { value } / { error } — a failed call keeps its error so the
      // receipt can report "Could not save that: …".
      const asValue = (result) =>
        result && typeof result === "object" && "error" in result ? { error: result.error } : payload(result);
      const values = results.map((r) => ({ name: r.name, value: asValue(r.result) }));
      const fix = values.find((r) => r.name === "correct_record")?.value;
      if (fix && !fix.error) return { fix: true, request: fix.request ?? "", advanced: false };
      const outcome = values.find((r) => !EXTRA_TOOLS.includes(r.name));
      const extras = values.filter((r) => EXTRA_TOOLS.includes(r.name)).map((r) => r.value);
      if (outcome && !outcome.value?.error) return { ...outcome.value, extras };
      if (outcome) extras.unshift(outcome.value);
      if (extras.length) {
        // Details without a settled outcome: keep the person, re-present the
        // number, and let the receipt report what failed.
        return { ok: true, advanced: false, extrasOnly: true, extras };
      }
      return { held: true, text: String(m.branch.advance_prompt ?? "").trim() };
    }));

  //   || -- fix: draft one corrective statement against contacts.db, show it
  //   with the rows it will affect, and apply it only after the caller
  //   confirms. The queue does not move — the walk re-presents the number.
  const fixFlow = Tree(name("fix")
    , Memory("fix_sql", () => "")
    , Memory("fix_check", () => "")
    , Memory("fix_notes", () => "")
    , Memory("fix_confirmed", () => false)
    , Prompt("fix_draft", (m) => [
      {
        role: "system",
        content:
          `You correct a wrong record in contacts.db after a call. Write ONE SQL statement — INSERT, UPDATE, or DELETE, never DDL and never more than one statement — plus a check SELECT that shows exactly the rows the statement will affect. The caller sees both and must confirm before anything runs.

The schema is EAV:
- profiles(id, created_at)
- attributes(id, profile_id, type, data, sort_order, created_at) — data is JSON
- relationships(from_profile_id, to_profile_id, type)

How the data is stored:
- names, emails and groups are attributes.type in ('first_name','last_name','email','group', ...) and their data is a JSON-encoded string, quotes included.
- messages are attributes.type='message' with JSON {"text","channel","status","dateSent","outcome","phone"}; call logs have channel 'Call'.
- phones are attributes.type='phone' with JSON {"number","label","status","source","id","note"}.
- follow-ups are attributes.type='followup' with JSON {"kind","note","at","until","status","source","id"}.

Rules:
- Fix only what the caller asked about, in contacts.db.
- Use the narrowest WHERE (an attribute id, a profile id, an exact JSON value).
- Write JSON with json_set/json_remove/json_quote; compare with json_extract.
- The check SELECT must return the rows that will change (id, profile_id, type, data).
- Return JSON only: {"sql":"...","check":"...","notes":"one short sentence on what changes","confirmed":false}.
- Set confirmed true only when the caller's reply clearly approves the statement shown last round; return that same sql and check unchanged. Otherwise apply their correction and keep confirmed false.
Do not add commentary outside the JSON.`,
      },
      {
        role: "user",
        content: [
          `The caller says this is wrong:\n${m.fix_request ?? ""}`,
          `Conversation (last ${CONVO_LIMIT}, oldest first):\n${conversationText(m)}`,
          `Tables:\n${schemaText(m) || "(schema unavailable)"}`,
          `Current target:\n${m.current ? `#${m.current.id} ${m.current.name}` : "(none)"}`,
          `Previous statement:\n${trimmed(m.fix_sql) || "(none — first draft)"}`,
          `Previous preview rows:\n${
            rowsOf(m, "fix_check").slice(0, 5).map((r) => JSON.stringify(r)).join("\n") || "(none)"
          }`,
          `Caller feedback:\n${m.fix_reply ?? "(none)"}`,
          "Return the JSON now.",
        ].join("\n\n"),
      },
    ])
    , Memory(update(), "fix_sql", (m) => parseFix(m.branch.fix_draft).sql)
    , Memory(update(), "fix_check", (m) => parseFix(m.branch.fix_draft).check)
    , Memory(update(), "fix_notes", (m) => parseFix(m.branch.fix_draft).notes)
    , Memory(update(), "fix_confirmed", (m) => {
      if (m.fix_reply == null) return false;
      const draft = parseFix(m.branch.fix_draft);
      return draft.confirmed === true && validFixSql(draft.sql).ok;
    })
    , Call("fix_check", "contacts_query", (m) => ({
      query: `${wrapped(m.fix_check || "SELECT 0 AS no_preview")} LIMIT 5`,
    }))
    , Emit(when((m) => m.fix_confirmed !== true && Boolean(m.fix_sql)), (m) => ({ text: formatFix(m) }))
    , Emit(when((m) => m.fix_confirmed !== true && !m.fix_sql), (m) => ({
      text: `Nothing to fix: ${m.fix_notes || "I could not tell what to change."}`,
    }))
    // ++ conversation — the proposal the caller is looking at (same gates).
    , Memory(
      when((m) => m.fix_confirmed !== true && Boolean(m.fix_sql)),
      update(),
      "conversation",
      (m) => convoAppend(m.conversation, convoEntry("bot", formatFix(m))),
    )
    , Memory(
      when((m) => m.fix_confirmed !== true && !m.fix_sql),
      update(),
      "conversation",
      (m) =>
        convoAppend(
          m.conversation,
          convoEntry("bot", `Nothing to fix: ${m.fix_notes || "I could not tell what to change."}`),
        ),
    )
    , Branch(when((m) => m.fix_confirmed !== true && Boolean(m.fix_sql)), Tree(Human("fix_reply")))
    // ++ conversation — the caller's correction reply, only when this round
    // actually paused for it (same gate as the pause).
    , Memory(when((m) => m.fix_confirmed !== true && Boolean(m.fix_sql)), update(), "conversation", (m) =>
      m.fix_reply != null
        ? convoAppend(m.conversation, convoEntry("caller", m.fix_reply))
        : (m.conversation ?? []))
    , Until(
      (m) => m.fix_confirmed === true || !m.fix_sql,
      max(FIX_ROUNDS, (m) => `fix review limit: ${m.error ?? "stuck"}`),
    )
    , Branch(
      when((m) => m.fix_confirmed === true && Boolean(m.fix_sql)),
      Tree(Call("fix_write", "contacts_write", (m) => ({ query: m.fix_sql }))
        , Memory("fix_result", (m) => m.branch.fix_write)
        , Emit((m) => ({ text: fixReceipt(m) }))
        , Memory(update(), "conversation", (m) => convoAppend(m.conversation, convoEntry("bot", fixReceipt(m))))),
    )
    , Return((m) => ({
      ok: !errored(m.fix_result) && payload(m.fix_result)?.changes != null,
      changes: Number(payload(m.fix_result)?.changes ?? 0),
      text: m.fix_result ? fixReceipt(m) : "",
    })));

export default (
  Tree(name("caller_list")
      , Model("strong")

      // ── registers ────────────────────────────────────────────────────────
      // Every tool this tree uses, declared inline. Each one declares the host
      // tools it calls; nothing here imports a database module.

      // #-> contacts_query: "Run one read-only SQL statement over contacts.db" calls(sql_query)
      , Register(
        "contacts_query",
        "Run one read-only SQL statement over contacts.db and return its rows.",
        async (_m, args, tools) => {
          try {
            const r = await tools.sql_query({ path: CONTACTS_DB, query: String(args?.query ?? "") });
            return errored(r) ? { error: r.error } : { value: r };
          } catch (err) {
            return { error: err.message };
          }
        },
        calls("sql_query"),
        parameters({ type: "object", properties: {
          query: { type: "string", description: "One SELECT/WITH statement to run over contacts.db." },
        }, required: ["query"] }),
      )

      // #-> contacts_write: "Run one writing SQL statement over contacts.db" calls(sql_write)
      , Register(
        "contacts_write",
        "Run one writing SQL statement (INSERT/UPDATE/DELETE) over contacts.db and return the rows changed.",
        async (_m, args, tools) => {
          try {
            const r = await tools.sql_write({ path: CONTACTS_DB, query: String(args?.query ?? "") });
            return errored(r) ? { error: r.error } : { value: r };
          } catch (err) {
            return { error: err.message };
          }
        },
        calls("sql_write"),
        parameters({ type: "object", properties: {
          query: { type: "string", description: "One writing statement to run over contacts.db." },
        }, required: ["query"] }),
      )

      // #-> start_call_list: "Start a caller list from a reviewed SELECT over contacts.db"
      , Register(
        "start_call_list",
        `Start a caller list from a read-only SQL query over contacts.db and hand out the first person. The query must be one SELECT/WITH exposing an \`id\` column; it is capped at ${MAX_TARGETS} ids and filtered to contacts that have a phone number. Returns { count } and seeds the walk.`,
        async (_m, args, tools) => {
          try {
            const query = trimmed(args?.query);
            if (!query) return { error: "a selection SQL query is required" };
            const phoneFilter = args?.hasPhone === false
              ? ""
              : " WHERE EXISTS (SELECT 1 FROM attributes a WHERE a.profile_id = t.id AND a.type = 'phone')";
            const r = await tools.sql_query({
              path: CONTACTS_DB,
              query: `SELECT t.id FROM (\n${query}\n) AS t${phoneFilter} LIMIT ${MAX_TARGETS}`,
            });
            if (errored(r)) return { error: r.error };
            const ids = (r?.rows ?? [])
              .map((row) => Number(row.id))
              .filter((n) => Number.isInteger(n) && n > 0);
            const queue = { ids, index: 0, phoneIndex: 0 };
            const current = ids.length ? await targetFor(tools, queue) : null;
            return { value: { count: ids.length }, memory: { queue, current, done: current == null } };
          } catch (err) {
            return { error: err.message };
          }
        },
        calls("sql_query", "contacts__get_contact"),
        parameters({ type: "object", properties: {
          query: { type: "string", description: "A single SELECT/WITH over contacts.db exposing `id` (profiles.id)." },
          hasPhone: { type: "boolean", description: "Drop contacts without a phone number (default true)." },
        }, required: ["query"] }),
      )

      // #-> complete_call_target: "Mark the current target as called…"
      , Register(
        "complete_call_target",
        "Mark the current target as called, log the call (channel Call, with a structured outcome) into their contact history, and advance to the next target. To log a call that was about an earlier contact in this list rather than the person on the table, pass that contact's contactId: the call is saved on them and the list does not move. A 'connected' outcome also closes any open promise on the contact.",
        async (m, args, tools) => {
          try {
            const queue = m.queue;
            const who = m.current;
            if (!who || !Array.isArray(queue?.ids)) return { error: "no active call list" };
            const outcome = normalizeOutcome(args?.outcome ?? "connected");
            if (!outcome) {
              return { error: `unknown call outcome '${args?.outcome}' — one of: ${CALL_OUTCOMES.join(", ")}` };
            }
            const referenced = args?.contactId != null && Number(args.contactId) !== who.id;
            if (referenced && !queue.ids.includes(Number(args.contactId))) {
              return { error: `contact #${args.contactId} is not in this call list` };
            }
            const id = referenced ? Number(args.contactId) : who.id;
            const dialed = referenced ? String(args?.phone ?? "").trim() : who.phone ?? "";
            const named = await contactFor(tools, id);
            const logged = await tools.contacts__log_message({
              id,
              text: String(args?.note ?? "").trim() || textForOutcome(outcome),
              channel: "Call",
              status: statusForOutcome(outcome),
              outcome,
              ...(dialed ? { phone: dialed } : {}),
            });
            if (logged && logged.ok === false) return { error: logged.error ?? "could not log the call" };
            const closed = outcome === "connected" ? await closeOpenPromises(tools, id) : [];
            const contactName = named?.name ?? `#${id}`;

            if (referenced) {
              // The update lands on them; the person on the table (and the
              // cursor) stay exactly where they are.
              return {
                value: { completed: id, contactId: id, contactName, outcome, referenced: true, advanced: false, closed },
                memory: { queue: { ...queue, lastId: id } },
              };
            }
            const next = { ...queue, index: (queue.index ?? 0) + 1, phoneIndex: 0, lastId: id };
            const done = next.index >= next.ids.length;
            return {
              value: { completed: id, contactId: id, contactName, outcome, advanced: true, closed },
              memory: { queue: next, current: done ? null : await targetFor(tools, next), done },
            };
          } catch (err) {
            return { error: err.message };
          }
        },
        calls("contacts__log_message", "contacts__get_contact", "contacts__upsert_contact"),
        parameters({ type: "object", properties: {
          outcome: { type: "string", enum: CALL_OUTCOMES, description: "Structured call outcome; defaults to 'connected'." },
          note: { type: "string", description: "Short, self-contained note about the call." },
          contactId: { type: "integer", description: "An earlier contact in this list to log against (their #id from the conversation). Omit for the person on the table." },
          phone: { type: "string", description: "The number the call was placed to (only needed when logging against an earlier contact)." },
        } }),
      )

      // #-> try_next_phone: "This number didn't reach them — hand out the next"
      , Register(
        "try_next_phone",
        "The current number did not reach the person (rang out, busy, failed to place, a dead/wrong number, or someone else answered): log this attempt into their contact history and hand out their next number, keeping the same person. 'wrong-contact' means someone else answered (the target left, moved desks, or the number belongs to another business) and the number stays valid; only bad numbers (wrong-number/disconnected/invalid-number) are marked status='invalid' on the contact. When no numbers are left the target is done and the queue advances.",
        async (m, args, tools) => {
          try {
            const queue = m.queue;
            const who = m.current;
            if (!who || !Array.isArray(queue?.ids)) return { error: "no active call list" };
            const outcome = normalizeOutcome(args?.outcome ?? "no-answer");
            if (!outcome || !RETRYABLE.includes(outcome)) {
              return { error: `'${args?.outcome}' is not a per-number failure — use one of: ${RETRYABLE.join(", ")}` };
            }
            const referenced = args?.contactId != null && Number(args.contactId) !== who.id;
            if (referenced && !queue.ids.includes(Number(args.contactId))) {
              return { error: `contact #${args.contactId} is not in this call list` };
            }
            const id = referenced ? Number(args.contactId) : who.id;
            const attempted = (referenced ? String(args?.phone ?? "").trim() : who.phone) ?? "";
            const named = await contactFor(tools, id);
            const logged = await tools.contacts__log_message({
              id,
              text: String(args?.note ?? "").trim() || textForOutcome(outcome),
              channel: "Call",
              status: statusForOutcome(outcome),
              outcome,
              ...(attempted ? { phone: attempted } : {}),
            });
            if (logged && logged.ok === false) return { error: logged.error ?? "could not log the attempt" };
            if (BAD_NUMBER.includes(outcome)) {
              try {
                await markPhoneInvalid(tools, id, attempted, outcome);
              } catch (err) {
                console.error("[caller-list] could not mark phone invalid:", err.message);
              }
            }
            const contactName = named?.name ?? `#${id}`;

            if (referenced) {
              return {
                value: { attempted: attempted || null, contactId: id, contactName, outcome, referenced: true, advanced: false },
                memory: { queue: { ...queue, lastId: id } },
              };
            }

            const phones = Array.isArray(who.phones) ? who.phones : [];
            const lastNumber = (who.phoneIndex ?? 0) + 1 >= phones.length;
            let next;
            if (lastNumber) {
              next = { ...queue, index: (queue.index ?? 0) + 1, phoneIndex: 0, lastId: id };
            } else {
              let phoneIndex = (who.phoneIndex ?? 0) + 1;
              if (BAD_NUMBER.includes(outcome)) {
                // The invalid mark re-sorts the numbers — re-find the dialed
                // slot's successor by number in the rebuilt target.
                const remaining = phones.filter((p) => p.number !== attempted);
                const want = remaining[who.phoneIndex ?? 0]?.number;
                const fresh = targetFrom(await contactFor(tools, id), { ...queue, phoneIndex: 0 });
                const found = (fresh?.phones ?? []).findIndex((p) => p.number === want);
                if (found >= 0) phoneIndex = found;
              }
              next = { ...queue, phoneIndex, lastId: id };
            }
            const done = next.index >= next.ids.length;
            return {
              value: { attempted: attempted || null, contactId: id, contactName, outcome, advanced: lastNumber },
              memory: { queue: next, current: done ? null : await targetFor(tools, next), done },
            };
          } catch (err) {
            return { error: err.message };
          }
        },
        calls("contacts__log_message", "contacts__get_contact", "contacts__upsert_contact"),
        parameters({ type: "object", properties: {
          outcome: { type: "string", enum: RETRYABLE, description: "Why this number failed; defaults to 'no-answer'." },
          note: { type: "string", description: "Short, self-contained note about the attempt." },
          contactId: { type: "integer", description: "An earlier contact in this list the failed number belongs to (their #id). Omit for the person on the table." },
          phone: { type: "string", description: "The failed number (only needed when logging against an earlier contact)." },
        } }),
      )

      // #-> skip_call_target: "Skip the person on the table"
      , Register(
        "skip_call_target",
        "Skip the current target (log it as a skipped call) and advance to the next target.",
        async (m, args, tools) => {
          try {
            const queue = m.queue;
            const who = m.current;
            if (!who || !Array.isArray(queue?.ids)) return { error: "no active call list" };
            const logged = await tools.contacts__log_message({
              id: who.id,
              text: String(args?.reason ?? "").trim() || "skipped",
              channel: "Call",
              status: "draft",
              outcome: "skipped",
              ...(who.phone ? { phone: who.phone } : {}),
            });
            if (logged && logged.ok === false) return { error: logged.error ?? "could not log the skip" };
            const next = { ...queue, index: (queue.index ?? 0) + 1, phoneIndex: 0, lastId: who.id };
            const done = next.index >= next.ids.length;
            return {
              value: { skipped: who.id, contactId: who.id, contactName: who.name, outcome: "skipped", advanced: true },
              memory: { queue: next, current: done ? null : await targetFor(tools, next), done },
            };
          } catch (err) {
            return { error: err.message };
          }
        },
        calls("contacts__log_message", "contacts__get_contact"),
        parameters({ type: "object", properties: {
          reason: { type: "string", description: "Why this person was skipped." },
        } }),
      )

      // #-> add_call_phone: "Save a caller-provided number onto a contact"
      , Register(
        "add_call_phone",
        "Save a caller-provided phone number onto a contact (default: the person the call was about; pass contactId for an earlier contact in this list). The number text is normalized so several numbers in one phrase each store dialable; a number that was marked invalid is re-activated and any label/note it already had is kept unless this call replaces it. With dialNow true and that contact on the table, the new number becomes the one to dial next.",
        async (m, args, tools) => {
          try {
            const queue = { ...(m.queue ?? {}) };
            const id = args?.contactId != null ? Number(args.contactId) : (queue.lastId ?? m.current?.id);
            if (id == null) return { error: "no active call list" };
            const numbers = splitPhones(args?.number);
            if (!numbers.length) return { error: `no dialable number in '${String(args?.number ?? "").trim()}'` };
            const contact = await contactFor(tools, id);
            if (!contact) return { error: `no contact with id ${id}` };
            const label = String(args?.label ?? "").trim();
            const observation = String(args?.note ?? "").trim();

            const added = [];
            for (const value of numbers) {
              const stored = findStoredPhone(contact.phones, value);
              const number = stored?.number ?? value;
              const storedLabel = label || stored?.label || "";
              const storedNote = observation || stored?.note || "";
              const saved = await tools.contacts__upsert_contact({
                id,
                phones: [{
                  number,
                  label: storedLabel,
                  status: "valid",
                  ...(storedNote ? { note: storedNote } : {}),
                  source: "caller-list: caller-provided",
                }],
              });
              if (saved && saved.ok === false) return { error: saved.error ?? "could not save the number" };
              added.push({ number, label: storedLabel, ...(storedNote ? { note: storedNote } : {}) });
            }

            let dialed = null;
            if (args?.dialNow === true && m.current && id === m.current.id && Array.isArray(queue.ids)) {
              const fresh = targetFrom(await contactFor(tools, id), { ...queue, phoneIndex: 0 });
              const index = (fresh?.phones ?? []).findIndex((p) => p.number === added[0].number);
              if (index >= 0) {
                queue.phoneIndex = index;
                dialed = added[0].number;
              }
            }
            const contactName = contact.name ?? `#${id}`;
            const next = { ...queue, lastId: id };
            const patch = { queue: next };
            if (m.current && id === m.current.id) patch.current = targetFrom(await contactFor(tools, id), next);
            return { value: { id, contactName, added, dialed, advanced: false }, memory: patch };
          } catch (err) {
            return { error: err.message };
          }
        },
        calls("contacts__get_contact", "contacts__upsert_contact"),
        parameters({ type: "object", properties: {
          number: { type: "string", description: "The number text as the caller gave it (one or more numbers)." },
          label: { type: "string", description: "Label to store, e.g. 'mobile', 'head office'." },
          note: { type: "string", description: "Lasting fact about the line to store with it." },
          contactId: { type: "integer", description: "An earlier contact in this list to save the number on (their #id)." },
          dialNow: { type: "boolean", description: "Hand the new number out as the next one to dial (only when its contact is on the table)." },
        }, required: ["number"] }),
      )

      // #-> note_call_phone: "Record a lasting fact about one of a contact's numbers"
      , Register(
        "note_call_phone",
        "Record a lasting fact about one of a contact's numbers ('voicemail box not set up', 'this number is another business', 'ask for the front desk'), replacing any previous note on that number. It does not change the number's status or dial order. Defaults to the line on the table; pass phone explicitly (the number as shown in the conversation) whenever an outcome tool is in the same reply, and pass phone together with contactId for an earlier contact.",
        async (m, args, tools) => {
          try {
            const queue = { ...(m.queue ?? {}) };
            const id = args?.contactId != null ? Number(args.contactId) : (queue.lastId ?? m.current?.id);
            if (id == null) return { error: "no active call list" };
            const phone = String(args?.phone ?? "").trim() || (m.current && id === m.current.id ? m.current.phone || "" : "");
            if (!phone) return { error: "which number? pass the phone from Previous messages" };
            const contact = await contactFor(tools, id);
            const stored = findStoredPhone(contact?.phones, phone);
            if (!stored) return { error: `contact #${id} has no stored number '${phone}'` };
            const note = String(args?.note ?? "").replace(/\s+/g, " ").trim();
            if (!note) return { error: "the note is empty" };
            const saved = await tools.contacts__upsert_contact({ id, phones: [{ ...stored, note }] });
            if (saved && saved.ok === false) return { error: saved.error ?? "could not note the number" };
            const noted = { number: stored.number, label: stored.label ?? "", note };
            const next = { ...queue, lastId: id };
            const patch = { queue: next };
            if (m.current && id === m.current.id) patch.current = targetFrom(await contactFor(tools, id), next);
            return { value: { id, contactName: contact?.name ?? `#${id}`, noted, advanced: false }, memory: patch };
          } catch (err) {
            return { error: err.message };
          }
        },
        calls("contacts__get_contact", "contacts__upsert_contact"),
        parameters({ type: "object", properties: {
          note: { type: "string", description: "The observation to store on the number." },
          phone: { type: "string", description: "The number to note (only needed when it is not the line on the table)." },
          contactId: { type: "integer", description: "An earlier contact in this list whose number it is (their #id)." },
        }, required: ["note"] }),
      )

      // #-> schedule_followup: "Record a promise or a best-time window"
      , Register(
        "schedule_followup",
        "Record a follow-up on a contact: kind 'promise' (we committed to reach back out) or 'window' (their best time to be reached), with an ISO 8601 at/until and a short note. The note is the follow-up's identity — the same note updates it in place. Defaults to the person the call was about; pass contactId for an earlier contact in this list. An open promise closes automatically when a call connects.",
        async (m, args, tools) => {
          try {
            const queue = { ...(m.queue ?? {}) };
            const id = args?.contactId != null ? Number(args.contactId) : (queue.lastId ?? m.current?.id);
            if (id == null) return { error: "no active call list" };
            const type = String(args?.kind ?? "").trim().toLowerCase() || "promise";
            if (type !== "promise" && type !== "window") {
              return { error: `unknown follow-up kind '${args?.kind}' — use 'promise' or 'window'` };
            }
            const at = String(args?.at ?? "").trim();
            const until = String(args?.until ?? "").trim();
            const note = String(args?.note ?? "").trim();
            if (!note && !at) return { error: "a follow-up needs a note or a time" };
            for (const [key, value] of [["at", at], ["until", until]]) {
              if (value && Number.isNaN(Date.parse(value))) {
                return { error: `'${value}' is not a valid ISO 8601 ${key}` };
              }
            }
            const followup = {
              kind: type,
              ...(note ? { note } : {}),
              ...(at ? { at } : {}),
              ...(until ? { until } : {}),
              source: type === "window" ? "caller-list: best-time" : "caller-list: caller-promised",
            };
            const saved = await tools.contacts__upsert_contact({ id, followups: [followup] });
            if (saved && saved.ok === false) return { error: saved.error ?? "could not record the follow-up" };
            const contact = await contactFor(tools, id);
            const stored = (contact?.followups ?? []).find((f) => f.kind === type && (f.note ?? "") === note) ?? followup;
            const next = { ...queue, lastId: id };
            const patch = { queue: next };
            if (m.current && id === m.current.id) patch.current = targetFrom(contact, next);
            return { value: { id, contactName: contact?.name ?? `#${id}`, followup: stored, advanced: false }, memory: patch };
          } catch (err) {
            return { error: err.message };
          }
        },
        calls("contacts__get_contact", "contacts__upsert_contact"),
        parameters({ type: "object", properties: {
          kind: { type: "string", enum: ["promise", "window"], description: "'promise' (we owe a call back) or 'window' (their best time); defaults to 'promise'." },
          note: { type: "string", description: "Short, self-contained description of the follow-up (who does what)." },
          at: { type: "string", description: "When, ISO 8601 with the offset when known." },
          until: { type: "string", description: "End of a window, ISO 8601 (optional)." },
          contactId: { type: "integer", description: "An earlier contact in this list (their #id)." },
        } }),
      )

      // #-> add_call_contact: "Create a contact for a new person the call turned up"
      , Register(
        "add_call_contact",
        "Add a new contact discovered on the call — a replacement, a referral, a new department contact — linked to the person on the call by a note ('Introduced on a call with …'). A first name alone is enough; a first-name-only person is always created new so they cannot silently match a namesake. If someone with the same name already exists (and no id or email was given), nothing is written and the result asks the caller: tell them who exists and wait; when they answer, call again with create true or id.",
        async (m, args, tools) => {
          try {
            const queue = { ...(m.queue ?? {}) };
            const linked = args?.contactId != null ? Number(args.contactId) : (queue.lastId ?? m.current?.id);
            if (linked == null) return { error: "no active call list" };
            const first = String(args?.first_name ?? "").trim();
            const last = String(args?.last_name ?? "").trim();
            const email = String(args?.email ?? "").trim();
            if (!first && !email) return { error: "a new contact needs a first name or an email" };

            const target = Number(args?.id) || null;
            if (target != null) {
              const existing = await contactFor(tools, target);
              if (!existing) return { error: `no contact with id ${target}` };
            }

            // Same-name candidates: ask before writing unless the caller
            // already chose an id, gave an email, or said to create a new one.
            if (target == null && !email && args?.create !== true) {
              const found = await tools.contacts__search_contacts({ query: [first, last].filter(Boolean).join(" ") });
              const candidates = (found?.contacts ?? [])
                .filter((c) => {
                  const name = String(c?.name ?? "").toLowerCase();
                  const want = [first, last].filter(Boolean).join(" ").toLowerCase();
                  return last ? name === want : name.split(/\s+/)[0] === want;
                })
                .map((c) => ({ id: c.id, name: c.name ?? `#${c.id}`, company: (c.companies ?? [])[0] ?? "" }));
              if (candidates.length) {
                return {
                  value: { ok: false, needsConfirmation: true, contactName: first, candidates },
                  memory: { queue: { ...queue, lastId: linked } },
                };
              }
            }

            const linkContact = await contactFor(tools, linked);
            const company = String(args?.company ?? "").trim();
            const profession = String(args?.profession ?? "").trim();
            const context = String(args?.note ?? "").replace(/\s+/g, " ").trim();
            const link = linkContact
              ? `Introduced on a call with ${linkContact.name ?? `#${linked}`} (#${linked}) on ${new Date().toISOString().slice(0, 10)}`
              : "";
            const notes = [context, link].filter(Boolean);
            const numbers = splitPhones(args?.phone);
            const label = String(args?.label ?? "").trim();
            // A first-name-only person must not silently match a namesake; a
            // chosen existing id updates that contact instead.
            const forced = target == null && (args?.create === true || (!email && !last));

            const saved = await tools.contacts__upsert_contact({
              ...(target != null ? { id: target } : {}),
              ...(first ? { first_name: first } : {}),
              ...(last ? { last_name: last } : {}),
              ...(email ? { emails: [email] } : {}),
              ...(company ? { companies: [company] } : {}),
              ...(profession ? { professions: [profession] } : {}),
              ...(notes.length ? { notes } : {}),
              ...(numbers.length
                ? { phones: numbers.map((number) => ({ number, label, status: "valid", source: "caller-list: met on call" })) }
                : {}),
              ...(forced ? { create: true } : {}),
            });
            if (saved && saved.ok === false) return { error: saved.error ?? "could not create the contact" };

            const contact = await contactFor(tools, saved?.profileId);
            return {
              value: {
                id: saved?.profileId,
                contactName: contact?.name ?? first,
                created: saved?.created === true,
                company,
                linkedTo: linkContact ? { id: linked, name: linkContact.name ?? `#${linked}` } : null,
                advanced: false,
              },
              memory: { queue: { ...queue, lastId: linked } },
            };
          } catch (err) {
            return { error: err.message };
          }
        },
        calls("contacts__get_contact", "contacts__upsert_contact", "contacts__search_contacts"),
        parameters({ type: "object", properties: {
          first_name: { type: "string", description: "First name of the new person." },
          last_name: { type: "string", description: "Last name, when known." },
          company: { type: "string", description: "Company / organization, when known." },
          profession: { type: "string", description: "Role or department, e.g. 'credit'." },
          email: { type: "string", description: "Email address, when known." },
          phone: { type: "string", description: "Phone number, when known." },
          label: { type: "string", description: "Label for the phone, e.g. 'main'." },
          note: { type: "string", description: "Context about the person." },
          id: { type: "integer", description: "An existing contact the caller chose to update instead of creating one." },
          create: { type: "boolean", description: "True after the caller chose to create a new contact despite the namesakes." },
          contactId: { type: "integer", description: "The earlier contact on whose call the new person came up (their #id)." },
        }, required: ["first_name"] }),
      )

      // #-> correct_record: "The caller says a record is wrong"
      , Register(
        "correct_record",
        "The caller says a record is wrong and wants it fixed (a call logged on the wrong contact, a wrong outcome/note/number, a duplicate contact). This starts a correction: the tree drafts one SQL statement against contacts.db, shows the statement and the rows it will affect, and applies it only after the caller confirms. Nothing changes until then.",
        (_m, args) => ({ value: { ok: true, request: String(args?.request ?? "").trim() } }),
        parameters({ type: "object", properties: {
          request: { type: "string", description: "What the caller says is wrong and how it should be, in the caller's words." },
        }, required: ["request"] }),
      )

      // !! input — the tree requires `input` (the user's request): a parent
      // branch seeds it, or bob seeds it from the first message when the tree
      // runs top-level. Capturing it into a logged slot lets resume rebuild
      // the request (runtime seeds are not part of the event log).
      , Needs("input")
      , Memory("input", (m) => String(m.input ?? ""))

      // ++! conversation — every caller message and every emitted message,
      // seeded with the request. The prompts replay only the last CONVO_LIMIT
      // entries; the slot itself keeps the whole run so a rewind (or a
      // resumed turn) never loses what was said.
      , Memory("conversation", (m) => [convoEntry("caller", String(m.input ?? ""))])

      // -- read the real schema and catalog before any drafting
      , Call("schema", "contacts_query", () => ({ query: "SELECT sql FROM sqlite_master WHERE type = 'table'" }))
      , Call("catalog", "contacts_query", () => ({
        query:
          "SELECT 'type' AS kind, type AS name, COUNT(*) AS n FROM attributes GROUP BY type " +
          "UNION ALL " +
          "SELECT 'group' AS kind, json_extract(data,'$') AS name, COUNT(*) AS n FROM attributes WHERE type = 'group' " +
          "GROUP BY json_extract(data,'$') " +
          "UNION ALL " +
          "SELECT 'phone' AS kind, data AS name, COUNT(*) AS n FROM (SELECT data FROM attributes WHERE type = 'phone' LIMIT 2) " +
          "ORDER BY kind, n DESC",
      }))

      // ++ selection review state, declared here so the loop's updates land in
      // this scope and the start step reads them after the loop exits.
      , Memory("selection_sql", () => "")
      , Memory("selection_notes", () => "")
      , Memory("selection_confirmed", () => false)
      , Memory("match_count", () => null)

      // ++ the walk's state — the cursor, the target at it, and the done flag.
      // The register patches write these; nothing else does.
      , Memory("queue", () => null)
      , Memory("current", () => null)
      , Memory("done", () => true)

      // () selection review loop
      , Branch(selectionReview)

      // -> run the confirmed SQL and seed the walk (queue / current / done
      // arrive through the register's memory patch)
      , Call("start_call_list", (m) => ({ query: m.selection_sql, hasPhone: true }))

      // << present the first person: about, then their first number as its own
      // message so each number gets a separate report and tel: link.
      , Emit((m) => ({ text: presentAbout(m.current) }))
      , Emit(when((m) => phoneAt(m.current) != null), (m) => ({ text: presentPhone(m.current) }))
      // ++! conversation — what was presented, in emit order.
      , Memory(update(), "conversation", (m) =>
        convoAppend(
          m.conversation,
          convoEntry("bot", presentAbout(m.current)),
          phoneAt(m.current) != null ? convoEntry("bot", presentPhone(m.current)) : null,
        ))

      // () the walk loop — pause, advance, present, repeat until done.
      // Unnamed subtree: nothing reads its value, so no .name() ceremony.
      , Branch(
        when((m) => !m.done),
        Tree(Human("outcome")
          // ++! conversation — the caller's words, logged before anything else
          // moves, so the next turn can resolve references like "same as last"
          // or a number that answers a failed save.
          , Memory(update(), "conversation", (m) =>
            m.outcome != null
              ? convoAppend(m.conversation, convoEntry("caller", m.outcome))
              : (m.conversation ?? []))
          , Branch(advance)
          // Only a tool result advances: a held answer keeps the current person
          // (and `done` false) so the next message can report them.
          , Memory("advance_result", (m) => m.branch.advance ?? null)
          // A correction opens the fix review (its own pause); the queue stays
          // where it is, and the fix's receipt lands in the conversation like
          // every other message.
          , Branch(when((m) => m.advance_result?.fix === true), fixFlow)
          // The receipt first: exactly what the words did (outcome logged,
          // number saved, follow-up recorded), and on whom.
          , Emit(
            when(
              (m) => m.advance_result && m.advance_result.held !== true && ackText(m).length > 0,
            ),
            (m) => ({ text: ackText(m) }),
          )
          // A settled contact shows the next person (about + first number); a
          // failed number or an edit about someone else just hands the current
          // number back out for the same person.
          , Emit(
            when((m) => m.advance_result?.advanced === true && m.done !== true),
            (m) => ({ text: presentAbout(m.current) }),
          )
          , Emit((m) =>
            m.advance_result?.held
              ? { text: m.advance_result.text || HOLD_TEXT }
              : { text: m.done ? "Call list complete." : presentPhone(m.current) },
          )
          // ++! conversation — the receipt and whatever was presented, in emit
          // order (the same gates as the emits above).
          , Memory(update(), "conversation", (m) => {
            const out = [];
            if (m.advance_result && m.advance_result.held !== true && ackText(m).length > 0) {
              out.push(convoEntry("bot", ackText(m)));
            }
            if (m.advance_result?.advanced === true && m.done !== true) {
              out.push(convoEntry("bot", presentAbout(m.current)));
            }
            out.push(
              convoEntry(
                "bot",
                m.advance_result?.held
                  ? m.advance_result.text || HOLD_TEXT
                  : m.done
                    ? "Call list complete."
                    : presentPhone(m.current),
              ),
            );
            return convoAppend(m.conversation, ...out);
          })
          , Until((m) => m.done === true, max(500, (m) => `call-list iteration limit: ${m.error ?? "stuck"}`))),
      )

      , Return((m) => ({ handled: true, text: m.done ? "Call list complete." : "Call list ended." })))
  );
