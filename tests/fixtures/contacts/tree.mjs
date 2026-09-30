// contacts tree — regenerated from app/contacts/tree.md, the source of truth
// for this tree's behavior. Change the spec first, then this file, keeping the
// notation lines as comments beside each translated chunk.
//
// Symbols on top of the canonical spec (examples/notation/README.md):
//
//   !! NAME   = "requires"  -> Needs(NAME). The slot must be seeded by the
//               caller (runtime.memory) — the tree refuses to run without it.
//   ( )       = "loop"      -> a named branch whose trailing Until() rewinds
//               to the branch top. The `|| << emit` inside the loop fires once
//               per model turn (after each round of tool calls), not once at
//               the end.
//   -> NAME: TOOL = "direct call" -> .call(NAME, TOOL, argsFn): runs the tool
//               with computed arguments, no model involved.
//   @@ NAME: ARRAY = "map"  -> .map(NAME, m => m.ARRAY, SUBTREE): runs the
//               subtree once per item; the current item is m.item.
//
// USAGE (the tree is a pattern: a default function over the builder API, same
// contract as patterns/*.mjs):
//
//   import buildContactsTree from "<workspace>/app/contacts/tree.mjs";
//   const tree = buildContactsTree({ Tree, when, max });
//   await grandma.knit(tree, {
//     memory: { input: "I met Victoria, she does admin work" },
//     tools:  { upsert_contact: { name, description, parameters, execute } },
//     models: { strong: { ... } },
//   });
//
// The `input` slot is the user's message; contact and CSV tools are provided by
// the app's tool export (see src/tools.js). Emitting goes to onEmit.
//
// The contact schema (aliases, scalars vs lists, keyed primaries) lives ONLY in
// src/fields.js; this tree introspects it via describeField() and derives its
// prompt vocabulary from it, so a new attribute needs no tree change.

import { describeField, LISTS, SCALARS, parseLocationString } from "./src/fields.js";
import { transformImportValue } from "./src/import-values.js";
import { Tree, when, max, update, calls, parameters, disableAuto, name, Model, Tools, Needs, Human, Prompt, Memory, Register, Branch, Each, Call, Check, Emit, Return, Until } from "../../../src/index.mjs";

// What a mapped column may become, straight from the schema. Locations are
// excluded from the keyed vocabulary: city/region/country columns combine
// into one location instead of one item per column.
const FIELD_NAMES = [...SCALARS.map((s) => s.attr), ...LISTS.map((l) => l.out)];
const KEYED_FIELDS = LISTS
  .filter((l) => l.primary && l.attr !== "location")
  .map((l) => `${l.out} (keyed by ${l.primary}, label optional)`);

function parseDecision(value) {
  try {
    const parsed = JSON.parse(String(value ?? "").replace(/^```json\s*|```$/g, "").trim());
    if (["people", "csv_import", "none"].includes(parsed?.mode)) return parsed;
  } catch {
    // Older/mock models may return the extraction directly.
  }
  return String(value ?? "").trim() === "NONE"
    ? { mode: "none" }
    : { mode: "people" };
}

/**
 * Skip entries should arrive as "<column>: <reason>" strings, but models
 * sometimes return objects ({"column": ..., "reason": ...}). Render any shape
 * as a readable label so nothing ever reaches the review as "[object Object]".
 */
function skipLabel(entry) {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object") {
    const column = entry.column ?? entry.csv_column ?? entry.name ?? entry.field;
    const reason = entry.reason ?? entry.why ?? entry.note;
    if (column != null && reason != null) return `${column}: ${reason}`;
    if (column != null) return String(column);
    if (reason != null) return String(reason);
    return JSON.stringify(entry);
  }
  return String(entry ?? "");
}

const skipList = (value) => (Array.isArray(value) ? value.map(skipLabel) : []);

/**
 * Parse the mapping step's JSON. Contact data is the default verdict; a
 * `"contacts": false` result means the profile did not look like contacts and
 * carries an explanation in `message`. Falls back to an empty map so the plan
 * review still has something to discuss.
 */
function parseFieldMap(value) {
  const empty = { contacts: true, message: "", row_count: null, field_map: {}, skip: [] };
  try {
    const parsed = JSON.parse(String(value ?? "").replace(/^```json\s*|```$/g, "").trim());
    const message = typeof parsed?.message === "string" ? parsed.message : "";
    if (parsed?.contacts === false) {
      return { ...empty, contacts: false, message };
    }
    const map = parsed?.field_map;
    if (map && typeof map === "object" && !Array.isArray(map)) {
      const rows = Number(parsed?.row_count);
      return {
        contacts: true,
        message,
        row_count: Number.isFinite(rows) ? rows : null,
        field_map: map,
        skip: skipList(parsed?.skip),
      };
    }
  } catch {
    // Older/mock models may not return the field map.
  }
  return empty;
}

/**
 * Parse the plan prompt's JSON. Accepts the wrapper shape
 * `{"plan": {...}, "confirmed": bool, "message": "..."}` or a bare plan
 * object. Unparseable output stays unconfirmed, so the review loop asks again
 * (bounded by the loop cap) instead of importing blind.
 */
function parsePlan(value) {
  const raw = String(value ?? "").replace(/^```json\s*|```$/g, "").trim();
  try {
    const parsed = JSON.parse(raw);
    const wrapped = parsed?.plan && typeof parsed.plan === "object" && !Array.isArray(parsed.plan);
    const plan = wrapped ? parsed.plan : parsed && typeof parsed === "object" ? parsed : {};
    return {
      plan: { ...plan, skip: skipList(plan.skip) },
      // null = the model did not say; the caller falls back to the mapping
      // verdict instead of silently assuming the file is contacts.
      contacts: typeof parsed?.contacts === "boolean" ? parsed.contacts : null,
      cancelled: parsed?.cancelled === true,
      confirmed: wrapped && parsed.confirmed === true,
      message: typeof parsed?.message === "string" ? parsed.message : "",
    };
  } catch {
    return { plan: {}, contacts: null, cancelled: false, confirmed: false, message: raw };
  }
}

/**
 * The confirmed import plan's field map, falling back to the explore step's
 * map while the plan is still being drafted (or when the plan is malformed).
 */
function planFieldMap(m) {
  const map = m.import_plan?.field_map;
  return map && typeof map === "object" && !Array.isArray(map)
    ? map
    : m.field_map?.field_map ?? {};
}

const planPath = (m) => m.import_plan?.path ?? m.document_path;

/** A trimmed label, or "" — empty strings never count as a group. */
const cleanLabel = (value) => (value == null ? "" : String(value).trim());

/**
 * The target group: the confirmed plan's label first, then whatever the
 * request named. Never falls back to an invisible default — when this returns
 * "", the plan review must ask the user for a label before the import runs.
 */
const planGroup = (m) => cleanLabel(m.import_plan?.group) || cleanLabel(m.group);

/** One capped line: "a, b, c, +N more". */
function shortList(items, max = 8) {
  const list = items.map((item) => String(item));
  const shown = list.slice(0, max).join(", ");
  return list.length > max ? `${shown}, +${list.length - max} more` : shown;
}

/** How every plan review ends: questions are welcome, decisions are named. */
const CONFIRM_HINT = 'Reply "confirm" to run the import, "cancel" to stop, or say what to change.';

/** Column -> { target, label } in plan order. */
function mapEntries(map) {
  const out = new Map();
  for (const [column, spec] of Object.entries(map ?? {})) {
    out.set(column, {
      target: typeof spec === "string" ? spec : spec?.field ?? "?",
      label: typeof spec === "string" || !spec?.label ? "" : String(spec.label),
    });
  }
  return out;
}

const renderTarget = ({ target, label }) => `${target}${label ? ` (${label})` : ""}`;

/**
 * What changed between the plan the user already saw and the current one.
 * Empty when nothing changed — the review then just relays the model's answer
 * instead of re-dumping the whole map.
 */
function changeLines(previous, current, m) {
  const lines = [];
  const prevGroup = cleanLabel(previous?.group) || cleanLabel(m.group);
  const curGroup = cleanLabel(current?.group) || cleanLabel(m.group);
  if (prevGroup !== curGroup) {
    lines.push(`group: ${prevGroup ? `"${prevGroup}"` : "(none)"} -> ${curGroup ? `"${curGroup}"` : "(none)"}`);
  }

  const before = mapEntries(previous?.field_map ?? {});
  const after = mapEntries(current?.field_map ?? planFieldMap(m));
  for (const [column, value] of after) {
    const old = before.get(column);
    if (!old) lines.push(`+ ${column} -> ${renderTarget(value)}`);
    else if (old.target !== value.target || old.label !== value.label) {
      lines.push(`~ ${column} -> ${renderTarget(value)} (was ${renderTarget(old)})`);
    }
  }
  for (const column of before.keys()) if (!after.has(column)) lines.push(`- ${column}`);

  const prevSkip = new Set((Array.isArray(previous?.skip) ? previous.skip : []).map(String));
  const curSkip = new Set((Array.isArray(current?.skip) ? current.skip : []).map(String));
  for (const item of curSkip) if (!prevSkip.has(item)) lines.push(`+ skipped: ${item}`);
  for (const item of prevSkip) if (!curSkip.has(item)) lines.push(`- skipped: ${item}`);
  return lines;
}

/**
 * The plan review message.
 *
 * First round: file + group, profile summary, the map GROUPED BY TARGET FIELD
 * (so a file with dozens of columns reads as a handful of lines and duplicate
 * source columns stand out), what is skipped, the model's question.
 * Later rounds: only what changed since the last review — or just the answer
 * when nothing changed — so follow-up questions don't re-dump the plan.
 * Every round ends with the same confirm/cancel hint.
 */
function formatPlan(m) {
  const group = planGroup(m);
  const header = `Import plan for ${planPath(m)} into group ${group ? `"${group}"` : "(none yet — name one)"}`;
  const message = String(m.plan_message || "").trim();
  const previous = m.plan_shown ?? null;

  // First review: the whole plan.
  if (!previous) {
    const map = planFieldMap(m);
    const entries = Object.entries(map);
    const skipped = Array.isArray(m.import_plan?.skip)
      ? m.import_plan.skip
      : Array.isArray(m.field_map?.skip) ? m.field_map.skip : [];

    // target field -> ["Source Column", "Source Column (label)", ...]
    const byTarget = new Map();
    for (const [column, spec] of entries) {
      const { target, label } = mapEntries({ [column]: spec }).get(column);
      if (!byTarget.has(target)) byTarget.set(target, []);
      byTarget.get(target).push(`${column}${label ? ` (${label})` : ""}`);
    }

    const lines = [
      header,
      profileSummary(m),
      entries.length
        ? `Mapped ${entries.length} column${entries.length === 1 ? "" : "s"} to ${byTarget.size} field${byTarget.size === 1 ? "" : "s"}:`
        : "Mapped 0 columns.",
    ].filter(Boolean);
    for (const [target, sources] of byTarget) lines.push(`  ${target} <- ${sources.join(", ")}`);
    if (skipped.length) lines.push(`Skipped ${skipped.length}: ${shortList(skipped)}`);
    lines.push(message || "Reply to confirm or correct it.", CONFIRM_HINT);
    return lines.join("\n");
  }

  // Later reviews: the answer, plus only the plan changes.
  const changes = changeLines(previous, m.import_plan ?? {}, m);
  if (!changes.length) {
    return [message || "No changes to the import plan.", CONFIRM_HINT].join("\n");
  }
  const lines = [
    header,
    `Changed since the last review (${changes.length}):`,
    ...changes.slice(0, 24).map((line) => `  ${line}`),
  ];
  if (changes.length > 24) lines.push(`  +${changes.length - 24} more`);
  lines.push(message || "Reply to confirm or correct it.", CONFIRM_HINT);
  return lines.join("\n");
}

/**
 * The rows fetched by the current pass's direct duckdb_query call, or [] when
 * the batch is empty. Rows are objects keyed by CSV column name.
 */
function batchRows(m) {
  const result = toolResult(m, "query_batch");
  return Array.isArray(result?.rows) ? result.rows : [];
}

// Rows per import batch. The duckdb tool returns at most 100 rows per call, so
// this is the largest batch one query can deliver; imports of any size page
// through it and the cursor is what makes them finite.
const IMPORT_BATCH = 100;

/**
 * The fixed batch query: the confirmed map's columns at the cursor. Each plan
 * key is resolved to the CSV's real header (BOM/padding tolerant) and quoted
 * so duckdb's identifier parsing cannot misfire.
 */
function buildBatchQuery(map, cursor, m) {
  const columns = Object.keys(map).map(
    (column) => `"${String(resolveColumn(column, m)).replaceAll('"', '""')}"`,
  );
  return `SELECT ${columns.join(", ") || "*"} FROM csv LIMIT ${IMPORT_BATCH} OFFSET ${Math.max(0, Number(cursor) || 0)}`;
}

/** Spreadsheet sentinels and blanks mean "no value" — never import them. */
const EMPTY_CELLS = new Set([
  "", "--", "#ERROR!", "#N/A", "#REF!", "#VALUE!", "#DIV/0!", "#NAME?", "#NULL!", "#NUM!",
]);

function cleanCell(value) {
  const text = value == null ? "" : String(value).trim();
  return EMPTY_CELLS.has(text.toUpperCase()) ? "" : text;
}

// Page size for profiling: matches the duckdb tool's 100-row result cap, so
// files with more columns than that are profiled over several calls.
const PROFILE_PAGE = 100;

/** SQL string literal, single quotes doubled. */
const sqlLiteral = (value) => `'${String(value).replaceAll("'", "''")}'`;

const pageOffset = (cursor) => Math.max(0, Number(cursor) || 0);

/**
 * Deterministic profiling — the file's actual contents, fetched before any
 * mapping decision:
 *  - columnsQuery: every column with its type, in file order.
 *  - profileQuery: for every column with at least one non-empty value, its
 *    count and one sample. CAST(COLUMNS(*) AS VARCHAR) sidesteps mixed CSV
 *    column types; paging keeps every column beyond the tool's row cap.
 */
function columnsQuery(cursor) {
  return "SELECT column_name, data_type FROM duckdb_columns() WHERE table_name = 'csv' " +
    `ORDER BY column_index LIMIT ${PROFILE_PAGE} OFFSET ${pageOffset(cursor)}`;
}

function profileQuery(cursor) {
  const sentinels = [...EMPTY_CELLS].filter(Boolean).map(sqlLiteral).join(", ");
  return "WITH text AS (SELECT CAST(COLUMNS(*) AS VARCHAR) FROM csv), " +
    "long AS (UNPIVOT (SELECT * FROM text) ON COLUMNS(*) INTO NAME col VALUE val) " +
    "SELECT col AS column_name, count(*) AS non_empty, any_value(val) AS sample " +
    `FROM long WHERE val IS NOT NULL AND upper(trim(val)) NOT IN (${sentinels}) ` +
    `GROUP BY col ORDER BY column_name LIMIT ${PROFILE_PAGE} OFFSET ${pageOffset(cursor)}`;
}

/** Strip the BOM / stray whitespace that exported CSV headers sometimes keep. */
const normalizeColumn = (name) => String(name ?? "").replace(/^\uFEFF/, "").trim().toLowerCase();

/**
 * The actual CSV column for a plan key. Headers may carry a BOM or padding,
 * so match on the normalized name and quote the name the CSV really has.
 */
function resolveColumn(name, m) {
  const columns = Array.isArray(m.csv_columns) ? m.csv_columns : [];
  const wanted = normalizeColumn(name);
  const hit = columns.find((column) => normalizeColumn(column.column_name) === wanted);
  return hit ? String(hit.column_name) : String(name);
}

/**
 * A tool result, or a thrown Error when the tool returned an error as a value
 * (the duckdb tool answers with "error: ..." strings). Either way the tree
 * must fail loudly — an error must never read as "an empty batch".
 */
function toolResult(m, name) {
  const result = m.branch?.[name];
  if (typeof result === "string" && result.toLowerCase().startsWith("error")) {
    throw new Error(result);
  }
  if (result && typeof result === "object" && typeof result.error === "string") {
    throw new Error(result.error);
  }
  return result;
}

/** Rows recorded by the last page call in `m.branch[name]`. */
function pageRows(m, name) {
  const result = toolResult(m, name);
  return Array.isArray(result?.rows) ? result.rows : [];
}

/**
 * One line per column: type, non-empty count, and a sample value. This is what
 * the mapping prompt and the review see, so decisions are made on data rather
 * than header names.
 */
function profileLines(m) {
  const columns = Array.isArray(m.csv_columns) ? m.csv_columns : [];
  const byName = new Map(
    (Array.isArray(m.csv_profile) ? m.csv_profile : [])
      .map((r) => [normalizeColumn(r.column_name), r]),
  );
  return columns.map((column) => {
    const name = String(column.column_name).replace(/^\uFEFF/, "").trim();
    const type = column.data_type ? String(column.data_type) : "?";
    const hit = byName.get(normalizeColumn(column.column_name));
    const count = Number(hit?.non_empty ?? 0);
    return count > 0
      ? `${name} [${type}]: ${count} non-empty, e.g. ${JSON.stringify(String(hit.sample ?? "").slice(0, 80))}`
      : `${name} [${type}]: no values`;
  });
}

/** One bounded review line: column totals plus which columns have no values. */
function profileSummary(m) {
  const columns = Array.isArray(m.csv_columns) ? m.csv_columns : [];
  if (!columns.length) return "";
  const valued = new Set(
    (Array.isArray(m.csv_profile) ? m.csv_profile : [])
      .filter((r) => Number(r.non_empty) > 0)
      .map((r) => normalizeColumn(r.column_name)),
  );
  const empty = columns
    .map((c) => String(c.column_name).replace(/^\uFEFF/, "").trim())
    .filter((name) => !valued.has(normalizeColumn(name)));
  const shown = empty.slice(0, 8).map((name) => `"${name}"`).join(", ");
  const more = empty.length > 8 ? `, +${empty.length - 8} more` : "";
  return `Source: ${columns.length} column${columns.length === 1 ? "" : "s"}, ${valued.size} with values` +
    (empty.length ? `; no values: ${shown}${more}` : "");
}

/** City/state/country columns (by label or column name) fold into one location. */
function addLocation(location, hint, value) {
  const h = String(hint ?? "").toLowerCase();
  const raw = String(value ?? "");
  // A full-address column lands on the location's street line; the schema
  // keeps street/postal next to city/region/country (see src/fields.js).
  if (h.includes("street") || h.includes("address") || h.includes("line1")) {
    location.street = raw;
  } else if (h.includes("zip") || h.includes("postal")) {
    location.postal = raw;
  } else if (h.includes("city")) {
    // A location column can hold the whole "City, Region, Country" string;
    // split it instead of storing the sentence as one part. Later columns
    // (State, Country) still fill whatever the string did not carry.
    if (raw.includes(",")) {
      const parsed = parseLocationString(raw);
      if (parsed.city && !location.city) location.city = parsed.city;
      if (parsed.region && !location.region) location.region = parsed.region;
      if (parsed.country && !location.country) location.country = parsed.country;
      return;
    }
    location.city = raw;
  } else if (h.includes("state") || h.includes("province") || h.includes("region")) location.region = raw;
  else if (h.includes("country")) location.country = raw;
  else if (!location.city) location.city = raw;
}

/**
 * Build one upsert_contact argument object from a CSV row using the confirmed
 * map — the deterministic half of the import. Returns null when the row has
 * no name and no email, so the caller's gate skips it. Exported for tests.
 */
export function rowToContact(row, m) {
  if (!row || typeof row !== "object") return null;
  const input = {};
  const groups = new Set();
  const target = planGroup(m);
  if (target) groups.add(String(target));
  const location = {};

  for (const [column, spec] of Object.entries(planFieldMap(m))) {
    const name = typeof spec === "string" ? spec : spec?.field;
    const label = typeof spec === "string" ? "" : String(spec?.label ?? "");
    // Rows are keyed by the CSV's real header; the plan key may be cleaned.
    const raw = cleanCell(row[resolveColumn(column, m)]);
    if (!raw || !name) continue;
    // Resolve the plan's name (any schema alias, singular or plural) and shape
    // the value from the schema's metadata — no field list lives here. Every
    // cell goes through the required import transform first: a phone cell can
    // hold several numbers and yield one value per number.
    const field = describeField(name);
    if (!field) continue;
    const transformed = transformImportValue(field, raw);
    const values = Array.isArray(transformed) ? transformed : [transformed];
    for (const value of values) {
      if (!value) continue;
      if (field.attr === "group") groups.add(String(value));
      else if (field.attr === "location") addLocation(location, label || column, value);
      else if (field.kind === "scalar") input[field.param] = value;
      else if (field.kind === "keyed") {
        const item = { [field.primary]: value };
        if (label) item.label = label;
        (input[field.param] ??= []).push(item);
      } else (input[field.param] ??= []).push(value);
    }
  }

  if (groups.size) input.groups = [...groups];
  if (Object.keys(location).length) (input.locations ??= []).push(location);

  const hasName = Boolean(input.first_name || input.last_name);
  const hasEmail = (input.emails ?? []).some((email) => email.address);
  return hasName || hasEmail ? input : null;
}

/** Deterministic import report, emitted and returned after the loop. */
function importSummary(m) {
  const total = m.field_map?.row_count;
  const totalText = Number.isFinite(Number(total)) ? ` of ${total}` : "";
  return `Imported ${m.import_cursor ?? 0}${totalText} rows from ${planPath(m)} into "${planGroup(m)}".`;
}

/** The import runs only for a confirmed contact-data plan with a group. */
const planImportable = (m) =>
  m.plan_cancelled !== true && m.plan_confirmed === true &&
  m.plan_contacts === true && Boolean(planGroup(m));

/** What to show when nothing is imported: the latest plan/verdict message. */
function planOutcome(m) {
  return String(m.plan_message || "").trim() ||
    String(m.branch?.explore?.message || "").trim() ||
    "Nothing was imported.";
}

/**
 * Turn an upsert_contact result into one readable line for onEmit:
 *   "created Victoria Kovalenko (#12)"
 *   "updated Ed Zwicker (#3): +note"
 */
function summarizeUpdate(result) {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return JSON.stringify(result);
  if (result.ok === false) return `error: ${result.error ?? "upsert failed"}`;
  const name = result.contact?.name ?? `#${result.profileId}`;
  const parts = [`${result.created ? "created" : "updated"} ${name} (#${result.profileId})`];
  if (result.added?.length) parts.push(`+${result.added.map((a) => a.type).join(", ")}`);
  if (result.replaced?.length) parts.push(`~${result.replaced.map((a) => a.type).join(", ")}`);
  return parts.join(" ");
}

  //   || -- inspect input for people or an attached CSV/TSV import
  const classify = Tree(name("classify"), Prompt("mode", (m) => [
    {
      role: "system",
      content: `You extract contact information and select the contact-work mode for the input.
Return JSON only: {"mode":"people"|"csv_import"|"none","path":"...","group":"..."}.
Use "people" when the user provides contact details in ordinary text.
Use "csv_import" when the user asks to import contacts from an attached CSV or TSV.
Copy the workspace-relative attachment path into path and extract the requested
group name when present. Use "none" for unrelated questions or requests.
Do not call tools and do not add commentary.`,
    },
    {
      role: "user",
      content: `Input:\n${m.input}\n\nSelect the mode now.`,
    },
  ]), Return((m) => parseDecision(m.branch.mode)));

  //   || || -- extract each person and every stated field
  //   || || << emit the extracted people
  const peopleWork = Tree(name("people_work")
    , Branch(
      Tree(name("extract_people"), Prompt((m) => [
        {
          role: "system",
          content: `You extract contact information from a message.
For each person mentioned, list them with every detail actually present, as fields:
${FIELD_NAMES.join(", ")}.
Only include information the message states — do not invent anything.
If the message mentions no person, reply with exactly: NONE`,
        },
        {
          role: "user",
          content: `Input:\n${m.input}\n\nDoes this mention information about a person or several people? If so, list each person and the information present.`,
        },
      ])),
    )
    , Emit((m) => ({ text: m.branch.extract_people ?? "" }))

    //   || || ()
    //   || || || -- use upsert_contact once per person
    //   || || || << emit the update output
    //   || || () prompt(max(12)) — the native auto tool loop saves each person
    , Branch(
      Tree(name("save_people")
        , Tools("upsert_contact")
        // Auto tool loop: one upsert_contact call per person, the results
        // feed back on the prompt's thread, and the model confirms in a
        // final round. Tools() is scoped to this subtree — no other prompt
        // in the app can call anything.
        , Prompt(
          max(12, (m) => `tool-iteration limit: ${m.error ?? "stuck"}`),
          "main_prompt",
          (m) => [
            {
              role: "system",
              content: `You save contacts.
Call upsert_contact exactly ONE TIME PER PERSON — never combine several people into a single call.
For each person in the list, issue one upsert_contact call carrying every field you know about that person.
After the tool calls, briefly confirm who was created or updated.
If the list is empty or says NONE, reply "nothing to save" and do not call the tool.`,
            },
            {
              role: "user",
              content: `People mentioned:\n${m.branch.extract_people ?? "(none)"}\n\nSave each person as a contact.`,
            },
          ],
        )
        , Emit(
          when((m) => (m.raw.branch.main_prompt?.toolResults ?? []).some((r) => r.name === "upsert_contact")),
          (m) => ({
            text: m.raw.branch.main_prompt.toolResults
              .filter((r) => r.name === "upsert_contact")
              .map((r) => summarizeUpdate(r.result))
              .join("\n"),
          }),
        ))
    )
    , Return((m) => m.branch.save_people ?? ""));

  //   || || -- map the profile to schema fields, or flag the file as not contact data
  //   || || ++ field_map, contacts, verdict_message
  //
  // No tools: the profile (every column with type, non-empty count, and one
  // sample) is deterministic, so a single prompt judges the file and maps it.
  const explore = Tree(name("explore")
    , Prompt("explore_prompt", (m) => [
      {
        role: "system",
        content: `You inspect the profile of a CSV or TSV file before importing records from it.
The profile lists every column with its type, its non-empty value count, and a
sample value, plus the deterministic row count. Use it to decide:
- contacts: false when the file clearly does not hold contact data (invoices,
  logs, measurements, ...). Say what it appears to be in message and stop.
- otherwise map every column that holds contact data to the best-fitting
  schema field (${FIELD_NAMES.join(", ")}). When several columns hold the same
  kind of value, map each one and label it, using
  {"field": "<schema field>", "label": "<column meaning>"}; label the parts of
  a compound value (an address: city, region, country) so they combine into one
  item. Columns with no values, ids, timestamps, tracking or verification
  flags, and anything no field fits go in skip with a reason.
Reply with JSON only:
{"contacts": true|false, "message": "<explanation when contacts is false>", "field_map": {"<csv column>": "<schema field>" or {"field": "<schema field>", "label": "<label>"}}, "skip": ["<csv column>: <reason>", ...]}
Do not call tools and do not add commentary.`,
      },
      {
        role: "user",
        content: `CSV/TSV path: ${m.document_path}\n` +
          `Target group: ${m.group || "(not set yet)"}\n` +
          `User request: ${m.input}\n` +
          `Rows in file: ${m.row_count ?? "unknown"}\n\n` +
          `Profile (${Array.isArray(m.csv_columns) ? m.csv_columns.length : 0} columns):\n` +
          `${profileLines(m).join("\n")}\n\n` +
          "Reply with the JSON now.",
      },
    ])
    , Return((m) => parseFieldMap(m.branch.explore_prompt)));

  //   || || || || @@ upsert_rows: batch_rows
  //   || || || || || -> save_row: upsert_contact one row through the field map and hygiene rules
  //   || || || || << emit batch progress
  //   || || || || ++ advance import_cursor
  //
  // The per-row subtree: ONE direct upsert_contact call, no model. The gate
  // drops rows that map to nothing (no name and no email); a skipped item
  // contributes undefined to the collected results.
  const saveRow = Tree(name("save_row")
    , Call(
      when((m) => rowToContact(m.item, m) !== null),
      "save_row",
      "upsert_contact",
      (m) => rowToContact(m.item, m),
    ));

  const upsertBatch = Tree(name("upsert_batch")
    , Each("upsert_rows", (m) => (Array.isArray(m.batch_rows) ? m.batch_rows : []), saveRow)
    , Emit(
      when((m) => (m.branch.upsert_rows ?? []).filter(Boolean).length > 0),
      (m) => ({
        text: m.branch.upsert_rows
          .filter(Boolean)
          .map((result) => summarizeUpdate(result))
          .join("\n"),
      }),
    )
    , Memory(update(), "import_cursor", (m, cur) =>
      Number(cur ?? 0) + (Array.isArray(m.batch_rows) ? m.batch_rows.length : 0)));

  //   || || ()
  //   || || || -> query_batch: duckdb_query the mapped columns at the cursor
  //   || || || ++ batch_rows
  //   || || || ** if the batch has rows
  //   || || || () until the batch is empty
  const importLoop = Tree(name("import_loop")
    , Call("query_batch", "duckdb_query", (m) => ({
      path: planPath(m),
      query: buildBatchQuery(planFieldMap(m), m.import_cursor, m),
    }))
    , Memory("batch_rows", (m) => batchRows(m))
    , Branch(when((m) => (m.batch_rows ?? []).length > 0), upsertBatch)
    // The loop is driven by the cursor: it exits when a batch comes back
    // empty. The cap is a runaway guard, not a size limit — 10k batches is
    // one million rows at 100 per batch, and real files run far below it.
    , Until(
      (m) => (m.batch_rows ?? []).length === 0,
      max(10000, (m) => `import iteration limit: ${m.error ?? "stuck"}`),
    ));

  //   || || || -- draft or revise the import plan from the field map and the latest reply
  //   || || || ++ import_plan, plan_confirmed
  const draftPlan = Tree(name("draft_plan")
    , Prompt("plan_prompt", (m) => [
      {
        role: "system",
        content: `You prepare a CSV or TSV contact import plan for the user to review.
You are given the deterministic file profile, the mapping result, and the
user's latest reply, if any. Build the plan the import will follow:
- contacts: whether the file really holds contact data (the mapping step said
  ${(m.branch.explore?.contacts ?? true) ? "true" : "false"}). Keep that unless
  the user clearly overrides it.
- cancelled: true only when the user clearly abandons the import.
- group: the target group label. It must never be empty: when neither the
  request nor the current plan names one, propose a short label from the file
  or request and ask the user to confirm it in message; only set confirmed
  true once a group is present.
- field_map: CSV column -> contact field (${FIELD_NAMES.join(", ")}), or
  {"field", "label"} for keyed lists (${KEYED_FIELDS.join("; ")}). Map every
  column that holds contact data to its best-fitting field; when you are
  unsure, keep your best guess in the map and ask about it in message.
- skip: only columns with no contact value, each with a reason.
Apply the user's corrections exactly. If the file does not look like contact
data, explain what it looks like in message and ask whether to import anyway
or cancel; never confirm such a plan. If the user has clearly confirmed the
plan, a group is present, and contacts is true, set confirmed true. Otherwise
ask the most important open question in message and set confirmed false. The
importer applies fixed source hygiene (sentinels are empty, rows with no name
and no email are skipped, keyed lists and locations are combined), so express
corrections in the map.
Reply with JSON only:
{"plan": {"path": "...", "group": "...", "field_map": {}, "skip": []}, "contacts": true|false, "cancelled": false, "confirmed": false, "message": "<what to show the user>"}`,
      },
      {
        role: "user",
        content: `CSV/TSV path: ${planPath(m)}\n` +
          `Target group: ${planGroup(m) || "(none yet)"}\n` +
          `Original user request:\n${m.input}\n\n` +
          `Mapping result: ${JSON.stringify(m.field_map ?? {})}\n\n` +
          `Profile:\n${profileLines(m).join("\n")}\n\n` +
          `Current plan: ${JSON.stringify(m.import_plan ?? null)}\n` +
          `User's reply: ${m.plan_reply ?? "(none yet)"}\n\n` +
          "Produce the import plan now.",
      },
    ])
    , Return((m) => parsePlan(m.branch.plan_prompt)));

  //   || || || ** if the plan is not confirmed
  //   || || || || << emit the plan and ask the user to confirm or correct it
  //   || || || || >> plan_reply
  const planReview = Tree(name("plan_review")
    // Emit first (the full plan, or just what changed since plan_shown), then
    // remember what the user has seen so the next round can diff against it.
    , Emit((m) => ({ text: formatPlan(m) }))
    , Memory(update(), "plan_shown", (m) => m.import_plan ?? {})
    , Human("plan_reply"));

  //   || || ()
  //   || || || -- draft or revise the import plan from the field map and the latest reply
  //   || || () until the plan is confirmed
  const planLoop = Tree(name("plan_loop")
    , Branch(draftPlan)
    // The plan slots are DECLARED in import_work (below) so the sibling
    // import loop can read them; memoryUpdate writes them in the declaring
    // scope even though this branch runs the write each pass.
    , Memory(update(), "import_plan", (m) => m.branch.draft_plan?.plan ?? {})
    , Memory(update(), "plan_confirmed", (m) => m.branch.draft_plan?.confirmed === true)
    // A missing contacts flag falls back to the mapping verdict; a missing
    // verdict means the file is treated as contact data.
    , Memory(update(), "plan_contacts", (m) =>
      m.branch.draft_plan?.contacts ?? (m.branch.explore?.contacts !== false))
    , Memory(update(), "plan_cancelled", (m) => m.branch.draft_plan?.cancelled === true)
    , Memory(update(), "plan_message", (m) =>
      m.branch.draft_plan?.message || m.branch.explore?.message || "")
    // The review keeps running — and keeps showing the group and profile —
    // until the plan is importable or the user cancels.
    , Branch(when((m) => !planImportable(m) && m.plan_cancelled !== true), planReview)
    // Twelve rounds: every one needs a human reply, and follow-up questions
    // are normal, so the cap only guards a model that never resolves.
    , Until(
      (m) => planImportable(m) || m.plan_cancelled === true,
      max(12, (m) => `plan review limit: ${m.error ?? "stuck"}`),
    ));

  //   || || -- profile the file: every column with type, non-empty count, sample, and the row count
  //   || || ++ csv_columns, csv_profile, row_count
  //
  // Both profile queries page at the duckdb tool's 100-row cap, so files with
  // more columns than that are still profiled end to end.
  const columnsLoop = Tree(name("csv_columns_loop")
    , Call("columns_page", "duckdb_query", (m) => ({
      path: planPath(m),
      query: columnsQuery(m.columns_cursor),
    }))
    , Memory(update(), "csv_columns", (m, cur) =>
      [...(Array.isArray(cur) ? cur : []), ...pageRows(m, "columns_page")])
    , Memory(update(), "columns_cursor", (m, cur) =>
      Number(cur ?? 0) + pageRows(m, "columns_page").length)
    , Until(
      (m) => pageRows(m, "columns_page").length < PROFILE_PAGE,
      max(20, (m) => `column profile limit: ${m.error ?? "stuck"}`),
    ));

  const profileLoop = Tree(name("csv_profile_loop")
    , Call("profile_page", "duckdb_query", (m) => ({
      path: planPath(m),
      query: profileQuery(m.profile_cursor),
    }))
    , Memory(update(), "csv_profile", (m, cur) =>
      [...(Array.isArray(cur) ? cur : []), ...pageRows(m, "profile_page")])
    , Memory(update(), "profile_cursor", (m, cur) =>
      Number(cur ?? 0) + pageRows(m, "profile_page").length)
    , Until(
      (m) => pageRows(m, "profile_page").length < PROFILE_PAGE,
      max(20, (m) => `value profile limit: ${m.error ?? "stuck"}`),
    ));

  //   || || -- determine document path and target group
  //   || || ++ document_path, group
  //   || || -- explore the profile: map it to schema fields, or flag the file as not contact data
  //   || || ++ field_map
  //   || || ++ import_cursor: 0
  const importWork = Tree(name("import_work")
    , Memory("document_path", (m) => m.branch.classify?.path ?? m.import_path ?? "(missing)")
    // No invisible default: when the request names no group, planGroup() is
    // empty and the review must get one from the user before importing.
    , Memory("group", (m) => m.branch.classify?.group ?? m.import_group ?? "")
    , Memory("columns_cursor", () => 0)
    , Memory("csv_columns", () => [])
    , Branch(columnsLoop)
    , Memory("profile_cursor", () => 0)
    , Memory("csv_profile", () => [])
    , Branch(profileLoop)
    , Call("count_csv", "duckdb_query", (m) => ({
      path: planPath(m),
      query: "SELECT count(*) AS row_count FROM csv",
    }))
    , Memory("row_count", (m) => {
      const rows = Number(m.branch.count_csv?.rows?.[0]?.row_count);
      return Number.isFinite(rows) ? rows : null;
    })
    , Branch(explore)
    // The mapping verdict and map; the deterministic row count wins.
    , Memory("field_map", (m) => ({
      ...(m.branch.explore ?? {}),
      row_count: m.row_count ?? m.branch.explore?.row_count ?? null,
    }))
    // Plan slots live here (import_work scope) so both the review loop and
    // the import loop see them; the loop below updates them per pass.
    , Memory("import_plan", () => ({}))
    , Memory("plan_confirmed", () => false)
    , Memory("plan_contacts", () => true)
    , Memory("plan_cancelled", () => false)
    , Memory("plan_message", () => "")
    // The last plan the user actually saw; later reviews diff against it.
    , Memory("plan_shown", () => null)
    , Branch(planLoop)
    , Memory("import_cursor", () => 0)
    // Import only a confirmed, contact-data plan with a group; otherwise
    // report why nothing was imported.
    , Branch(when(planImportable), importLoop)
    , Emit(when(planImportable), (m) => ({ text: importSummary(m) }))
    , Emit(when((m) => !planImportable(m)), (m) => ({ text: planOutcome(m) }))
    , Return((m) =>
      planImportable(m)
        ? { contacts: true, text: importSummary(m) }
        : { contacts: false, text: planOutcome(m) }));

export default (
  Tree(name("contacts")
      , Model("strong")

      // !! input — the tree requires `input` (the user's message): a parent
      // branch seeds it, or bob seeds it from the first message when the tree
      // runs top-level. Capturing it into a logged slot lets resume rebuild
      // the request (runtime seeds are not part of the event log). The people
      // path is a pure input -> people -> upserts -> output function; the CSV
      // import path pauses at plan_reply while the user confirms the plan.
      , Needs("input")
      , Memory("input", (m) => String(m.input ?? ""))

      , Branch(classify)

      //   || ** if an attached CSV/TSV import is requested
      , Branch(when((m) => m.branch.classify?.mode === "csv_import"), importWork)

      //   || ** if people are described in ordinary text
      , Branch(when((m) => m.branch.classify?.mode === "people"), peopleWork)

      //   || ** if neither case applies
      , Return((m) => {
        const mode = m.branch.classify?.mode;
        if (mode === "csv_import") {
          // A cancelled / not-contact-data import is NOT handled: the parent
          // general branch takes the turn, with our explanation emitted.
          const work = m.branch.import_work;
          return { handled: work?.contacts !== false, text: String(work?.text ?? "") };
        }
        return { handled: mode !== "none", text: String(m.branch.people_work ?? "") };
      }))
  );
