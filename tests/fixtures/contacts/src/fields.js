// Field spec for a contact: which input keys map onto which comms attribute
// types, how a value is normalized, and how attributes are read back into a
// contact object. Everything here is pure data shaping — SQL lives in db.js,
// the add/update rules live in upsert.js.

import { createHash } from "node:crypto";

export const text = (v) => (v == null ? "" : String(v).trim());

/**
 * Deterministic short id for a list item — a read-only reference handle, not
 * an update key. The same identity always yields the same id, so an address
 * keeps its id across re-saves (and across a rebuild of the same value).
 */
export function itemId(prefix, key) {
  const digest = createHash("sha1").update(`${prefix}:${key}`).digest("hex").slice(0, 8);
  return `${prefix}_${digest}`;
}

/** First non-empty of `keys` on an object; "" for anything else. */
function field(v, keys) {
  if (v == null || typeof v !== "object") return "";
  for (const k of keys) {
    const found = text(v[k]);
    if (found) return found;
  }
  return "";
}

/**
 * A value that may arrive as a shorthand string ("ann@x.com", "Halifax") or as
 * an object. Strings are the value itself; objects are probed by key.
 */
function pick(v, keys) {
  return typeof v === "string" || typeof v === "number" ? text(v) : field(v, keys);
}

/** Single-valued attributes: one row per type, replaced on update. */
export const SCALARS = [
  { attr: "first_name", in: ["first_name", "firstname", "first", "given_name"] },
  { attr: "last_name", in: ["last_name", "lastname", "last", "surname", "family_name"] },
  { attr: "connection_level", in: ["connection_level", "connectionlevel", "connection"] },
  { attr: "met", in: ["met", "met_at", "where_met", "met_where"] },
  { attr: "date_added", in: ["date_added", "dateadded", "added"] },
];

function platformFromUrl(url) {
  let host = "";
  try {
    host = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
  const known = {
    "linkedin.com": "LinkedIn",
    "x.com": "X",
    "twitter.com": "X",
    "instagram.com": "Instagram",
    "github.com": "GitHub",
    "facebook.com": "Facebook",
    "bsky.app": "Bluesky",
  };
  if (known[host]) return known[host];
  const label = host.split(".")[0] ?? "";
  return label ? label[0].toUpperCase() + label.slice(1) : "";
}

/** "Halifax, NS, Canada" -> { city, region, country } */
export function parseLocationString(raw) {
  const parts = raw.split(",").map(text).filter(Boolean);
  if (parts.length === 1) return { city: "", region: parts[0], country: "" };
  if (parts.length === 2) return { city: parts[0], region: parts[1], country: "" };
  return { city: parts[0], region: parts[1], country: parts.slice(2).join(", ") };
}

/** "source" of an item: a sources array joins, else the first alias found. */
function sourceOf(v) {
  if (Array.isArray(v?.sources)) return v.sources.map(text).filter(Boolean).join(", ");
  return field(v, ["source", "sources", "provenance"]);
}

/**
 * Multi-valued attributes: one row per item, appended on update. `primary`
 * names the field that identifies an item (an email address, a phone number,
 * a URL) — it is what "already stored" is decided on. Text types have no
 * primary: the string itself is the identity. `autoId` names the prefix of
 * the deterministic read-only reference id (locations `loc_`, phones `phn_`,
 * emails `eml_`).
 */
export const LISTS = [
  {
    attr: "group",
    out: "groups",
    in: ["groups", "group"],
    build: (v) => pick(v, ["name", "text", "value"]) || null,
  },
  {
    attr: "email",
    out: "emails",
    in: ["emails", "email", "email_address"],
    primary: "address",
    // Read-only reference handle: itemId("eml", dedupe) when not supplied.
    autoId: "eml",
    build: (v) => {
      const address = pick(v, ["address", "email", "value"]);
      if (!address) return null;
      const email = { address, label: field(v, ["label", "type"]) };
      const id = field(v, ["id"]);
      if (id) email.id = id;
      const source = sourceOf(v);
      if (source) email.source = source;
      return email;
    },
  },
  {
    attr: "phone",
    out: "phones",
    in: ["phones", "phone", "phone_number", "cell", "mobile"],
    primary: "number",
    // Read-only reference handle: itemId("phn", dedupe) when not supplied.
    autoId: "phn",
    build: (v) => {
      const number = pick(v, ["number", "phone", "value"]);
      if (!number) return null;
      const phone = { number, label: field(v, ["label", "type"]) };
      const id = field(v, ["id"]);
      if (id) phone.id = id;
      const source = sourceOf(v);
      if (source) phone.source = source;
      // status is "valid" or "invalid" (a dialed number that failed).
      const status = field(v, ["status"]).toLowerCase();
      if (status === "valid" || status === "invalid") phone.status = status;
      // note is a lasting observation about the line ("voicemail box not
      // set up"), not the call history.
      const note = field(v, ["note", "notes", "observation"]);
      if (note) phone.note = note;
      return phone;
    },
  },
  {
    attr: "website",
    out: "websites",
    in: ["websites", "website", "url", "urls"],
    primary: "url",
    build: (v) => {
      const url = pick(v, ["url", "website", "link", "value"]);
      return url ? { url, label: field(v, ["label", "type"]) } : null;
    },
  },
  {
    attr: "social",
    out: "socials",
    in: ["socials", "social", "social_links", "linkedin", "linkedin_url", "twitter"],
    primary: "url",
    build: (v) => {
      const url = pick(v, ["url", "social", "linkedin", "profile", "link", "value"]);
      return url ? { url, label: field(v, ["label", "type", "platform"]) || platformFromUrl(url) } : null;
    },
  },
  {
    attr: "location",
    out: "locations",
    in: ["locations", "location", "city", "address"],
    primary: "region",
    // A location with no region is still valid ("New Jersey, USA" arrives as
    // city + country); fall back to its other parts for identity so it is not
    // silently dropped. A street/postal (a full business address) only adds
    // detail — it never changes the identity of a known city.
    fallback: ["street", "city", "region", "country"],
    // The stable id is the item's reference handle: normalizeInput assigns
    // itemId("loc", dedupe) when the caller did not supply one.
    autoId: "loc",
    build: (v) => {
      if (typeof v === "string") {
        const parsed = parseLocationString(v);
        return parsed.city || parsed.region || parsed.country ? parsed : null;
      }
      const city = field(v, ["city"]),
        region = field(v, ["region", "province", "state"]),
        country = field(v, ["country"]),
        street = field(v, ["street", "street_address", "address1", "line1", "address"]),
        postal = field(v, ["postal", "postal_code", "zip", "zipcode"]);
      if (!city && !region && !country && !street) return null;
      const location = { city, region, country };
      if (street) location.street = street;
      if (postal) location.postal = postal;
      const id = field(v, ["id"]);
      if (id) location.id = id;
      const source = sourceOf(v);
      if (source) location.source = source;
      // confirmed is a real boolean: only a truthy marker writes it.
      if (/^(true|yes|1|confirmed)$/i.test(field(v, ["confirmed", "verified"]))) {
        location.confirmed = true;
      }
      return location;
    },
  },
  {
    attr: "company",
    out: "companies",
    in: ["companies", "company", "employer", "organizations"],
    build: (v) => pick(v, ["text", "name", "value"]) || null,
  },
  {
    attr: "profession",
    out: "professions",
    in: ["professions", "profession", "title", "role", "job_title"],
    build: (v) => pick(v, ["text", "name", "value"]) || null,
  },
  {
    attr: "interest",
    out: "interests",
    in: ["interests", "interest", "topics"],
    build: (v) => pick(v, ["text", "name", "value"]) || null,
  },
  {
    attr: "note",
    out: "notes",
    in: ["notes", "note", "comments"],
    build: (v) => pick(v, ["text", "value"]) || null,
  },
  {
    attr: "podcast",
    out: "podcasts",
    in: ["podcasts", "podcast"],
    build: (v) => pick(v, ["text", "name", "value"]) || null,
  },
  {
    attr: "promise",
    out: "promises",
    in: ["promises", "promise"],
    build: (v) => pick(v, ["text", "value"]) || null,
  },
  {
    attr: "proposal",
    out: "proposals",
    in: ["proposals", "proposal", "propose"],
    build: (v) => pick(v, ["text", "value"]) || null,
  },
  {
    attr: "followup",
    out: "followups",
    in: ["followups", "followup", "reminder", "reminders", "callbacks"],
    // Identity is what the follow-up is about (its note), so rescheduling the
    // same promise updates it in place; kind|at is the fallback for a bare
    // time with no note. `at`/`until` are ISO 8601 strings; status is open
    // (absent), done, or cancelled.
    primary: "note",
    fallback: ["kind", "at"],
    autoId: "fu",
    build: (v) => {
      const note = pick(v, ["note", "text", "value", "what"]);
      const kind = field(v, ["kind", "type"]).toLowerCase();
      const at = field(v, ["at", "due", "when", "date"]);
      const until = field(v, ["until", "by", "end"]);
      const status = field(v, ["status"]).toLowerCase();
      if (!note && !at && !until) return null;
      const followup = {};
      if (kind === "promise" || kind === "window") followup.kind = kind;
      if (note) followup.note = note;
      if (at) followup.at = at;
      if (until) followup.until = until;
      if (status === "open" || status === "done" || status === "cancelled") {
        followup.status = status;
      }
      const id = field(v, ["id"]);
      if (id) followup.id = id;
      const source = sourceOf(v);
      if (source) followup.source = source;
      return Object.keys(followup).length ? followup : null;
    },
  },
];

export const parseData = (raw) => {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
};

/** Identity of a list item, used to decide whether it is already stored. */
export function dedupeOf(spec, value) {
  if (typeof value === "string") return value.toLowerCase();
  const key = text(value[spec.primary]);
  if (key) return key.toLowerCase();
  // Some specs carry a fallback identity (a location without its region).
  const rest = (spec.fallback ?? []).map((k) => text(value[k])).filter(Boolean);
  return rest.join("|").toLowerCase();
}

/**
 * Introspect one field name (any alias `normalizeInput` accepts, singular or
 * plural) so callers know how to shape the value for `upsert_contact`:
 *
 *   { attr, param, kind: "scalar" }                      first_name, met, ...
 *   { attr, param, kind: "list" }                        groups, companies, ...
 *   { attr, param, kind: "keyed", primary }              phones (number), ...
 *
 * Returns null for names the schema does not know. Add an attribute to
 * SCALARS/LISTS and every consumer picks it up — no other list to maintain.
 */
export function describeField(name) {
  const key = text(name).toLowerCase();
  if (!key) return null;
  for (const spec of SCALARS) {
    if (spec.in.includes(key)) return { attr: spec.attr, param: spec.attr, kind: "scalar" };
  }
  for (const spec of LISTS) {
    if (!spec.in.includes(key)) continue;
    return spec.primary
      ? { attr: spec.attr, param: spec.out, kind: "keyed", primary: spec.primary }
      : { attr: spec.attr, param: spec.out, kind: "list" };
  }
  return null;
}

/**
 * Normalize arbitrary input (snake_case or camelCase, string shorthands,
 * single values or arrays) into the attributes to write.
 *
 * @returns {{ scalars: Array<{attr: string, value: string}>,
 *             lists: Array<{attr: string, items: Array<{value: unknown, dedupe: string, data: string}>}> }}
 */
export function normalizeInput(input) {
  const bag = {};
  for (const [k, v] of Object.entries(input)) bag[k.toLowerCase()] = v;
  const take = (keys) => {
    for (const k of keys) {
      const v = bag[k];
      if (v == null || v === "") continue;
      if (Array.isArray(v) && v.length === 0) continue;
      return v;
    }
    return null;
  };

  const scalars = [];
  for (const spec of SCALARS) {
    const value = text(take(spec.in));
    if (value) scalars.push({ attr: spec.attr, value });
  }

  const lists = [];
  for (const spec of LISTS) {
    const raw = take(spec.in);
    if (raw == null) continue;
    const items = [];
    const seen = new Set();
    for (const entry of Array.isArray(raw) ? raw : [raw]) {
      const value = spec.build(entry);
      if (value == null) continue;
      const dedupe = dedupeOf(spec, value);
      if (!dedupe || seen.has(dedupe)) continue;
      seen.add(dedupe);
      if (spec.autoId && !value.id) value.id = itemId(spec.autoId, dedupe);
      items.push({ value, dedupe, data: JSON.stringify(value) });
    }
    if (items.length) lists.push({ attr: spec.attr, items });
  }

  return { scalars, lists };
}

const ATTR_TO_OUT = Object.fromEntries(LISTS.map((s) => [s.attr, s.out]));

/**
 * Assemble attributes + relationships into a contact object (the JSON shape
 * comms' tools return), so a caller can see exactly what is now stored.
 */
export function toContact(profile, attrs, relationships = []) {
  const grouped = {};
  const messages = [];
  for (const a of attrs) {
    const value = parseData(a.data);
    if (a.type === "message") {
      messages.push(value);
      continue;
    }
    (grouped[a.type] ??= []).push(value);
  }
  const one = (type) => {
    const value = (grouped[type] ?? []).find((v) => typeof v === "string" && v.trim());
    return value ?? null;
  };
  const many = (type) => grouped[type] ?? [];
  const texts = (type) => many(type).filter((v) => typeof v === "string");

  const firstName = one("first_name");
  const lastName = one("last_name");

  const contact = {
    id: profile.id,
    name: [firstName, lastName].filter(Boolean).join(" ") || null,
    first_name: firstName,
    last_name: lastName,
    groups: texts("group"),
    date_added: one("date_added"),
    connection_level: one("connection_level"),
    met: one("met"),
    created_at: profile.created_at ?? null,
    relationships,
    messages,
  };
  for (const [attr, out] of Object.entries(ATTR_TO_OUT)) {
    contact[out] = LISTS.find((s) => s.attr === attr).primary ? many(attr) : texts(attr);
  }
  return contact;
}
