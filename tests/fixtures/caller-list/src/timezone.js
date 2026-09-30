// Time zone from a contact's location text.
//
// Node ships full ICU, so the *offset* is easy and DST-correct:
//   new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
// gives "GMT-04:00" for a given instant. What Node does NOT ship is a
// city/state -> IANA zone database, and this app is offline and dependency
// free — so the zone is resolved from the location the contact stores
// (US state / Canadian province / country), with a few city overrides for
// states that span zones. Unknown locations simply get no line.

import { config } from "../config.js";

// Dominant zone per US state. Split states use their population centre
// (TX/FL/TN/KY/IN/KS/NE/ND/SD/OR/ID); the overrides below fix the common
// outliers.
const US_STATES = {
  AL: "America/Chicago", AK: "America/Anchorage", AZ: "America/Phoenix",
  AR: "America/Chicago", CA: "America/Los_Angeles", CO: "America/Denver",
  CT: "America/New_York", DE: "America/New_York", DC: "America/New_York",
  FL: "America/New_York", GA: "America/New_York", HI: "Pacific/Honolulu",
  ID: "America/Boise", IL: "America/Chicago", IN: "America/Indiana/Indianapolis",
  IA: "America/Chicago", KS: "America/Chicago", KY: "America/New_York",
  LA: "America/Chicago", ME: "America/New_York", MD: "America/New_York",
  MA: "America/New_York", MI: "America/Detroit", MN: "America/Chicago",
  MS: "America/Chicago", MO: "America/Chicago", MT: "America/Denver",
  NE: "America/Chicago", NV: "America/Los_Angeles", NH: "America/New_York",
  NJ: "America/New_York", NM: "America/Denver", NY: "America/New_York",
  NC: "America/New_York", ND: "America/Chicago", OH: "America/New_York",
  OK: "America/Chicago", OR: "America/Los_Angeles", PA: "America/New_York",
  RI: "America/New_York", SC: "America/New_York", SD: "America/Chicago",
  TN: "America/Chicago", TX: "America/Chicago", UT: "America/Denver",
  VT: "America/New_York", VA: "America/New_York", WA: "America/Los_Angeles",
  WV: "America/New_York", WI: "America/Chicago", WY: "America/Denver",
};

const US_STATE_NAMES = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", "district of columbia": "DC",
  florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL",
  indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA",
  maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI",
  minnesota: "MN", mississippi: "MS", missouri: "MO", montana: "MT",
  nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ",
  "new mexico": "NM", "new york": "NY", "north carolina": "NC",
  "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR",
  pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT",
  vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV",
  wisconsin: "WI", wyoming: "WY",
};

const CA_PROVINCES = {
  AB: "America/Edmonton", BC: "America/Vancouver", MB: "America/Winnipeg",
  NB: "America/Moncton", NL: "America/St_Johns", NS: "America/Halifax",
  NT: "America/Yellowknife", NU: "America/Iqaluit", ON: "America/Toronto",
  PE: "America/Halifax", QC: "America/Toronto", SK: "America/Regina",
  YT: "America/Whitehorse",
};

// A few cities whose zone differs from their state's dominant zone, plus
// cities that show up in the region field (exports often put the city there).
const CITY_ZONES = {
  "el paso": "America/Denver", pensacola: "America/Chicago",
  chattanooga: "America/New_York", evansville: "America/Chicago",
  "bowling green": "America/Chicago", "rapid city": "America/Denver",
  "coeur d'alene": "America/Los_Angeles", tempe: "America/Phoenix",
  phoenix: "America/Phoenix", tucson: "America/Phoenix",
  "las vegas": "America/Los_Angeles", "st. louis": "America/Chicago",
  "kansas city": "America/Chicago", "new york": "America/New_York",
  "los angeles": "America/Los_Angeles", chicago: "America/Chicago",
  houston: "America/Chicago", dallas: "America/Chicago",
  miami: "America/New_York", atlanta: "America/New_York",
  denver: "America/Denver", seattle: "America/Los_Angeles",
  boston: "America/New_York", detroit: "America/Detroit",
  toronto: "America/Toronto", vancouver: "America/Vancouver",
  montreal: "America/Toronto", calgary: "America/Edmonton",
};

// Country fallback: only countries that are effectively one zone for our
// purposes. Multi-zone countries rely on their state/province mapping.
const COUNTRY_ZONES = {
  "united kingdom": "Europe/London", ireland: "Europe/Dublin",
  portugal: "Europe/Lisbon", france: "Europe/Paris", germany: "Europe/Berlin",
  netherlands: "Europe/Amsterdam", belgium: "Europe/Brussels",
  spain: "Europe/Madrid", italy: "Europe/Rome", poland: "Europe/Warsaw",
  greece: "Europe/Athens", turkey: "Europe/Istanbul",
  "south africa": "Africa/Johannesburg", israel: "Asia/Jerusalem",
  "united arab emirates": "Asia/Dubai", singapore: "Asia/Singapore",
  india: "Asia/Kolkata", china: "Asia/Shanghai", "hong kong": "Asia/Hong_Kong",
  japan: "Asia/Tokyo", "south korea": "Asia/Seoul",
  "new zealand": "Pacific/Auckland",
};

const norm = (value) => String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");

/** US/CA two-letter code or full state/province name -> IANA zone. */
function regionZone(region) {
  const key = norm(region);
  if (!key) return null;
  const us = US_STATES[region?.trim?.().toUpperCase()] ?? US_STATES[US_STATE_NAMES[key]];
  if (us) return us;
  const ca = CA_PROVINCES[region?.trim?.().toUpperCase()] ?? CA_PROVINCES[
    { alberta: "AB", "british columbia": "BC", manitoba: "MB", "new brunswick": "NB",
      "newfoundland and labrador": "NL", "nova scotia": "NS", "northwest territories": "NT",
      nunavut: "NU", ontario: "ON", "prince edward island": "PE", quebec: "QC",
      saskatchewan: "SK", yukon: "YT" }[key]
  ];
  return ca ?? null;
}

/**
 * The IANA zone for a location object `{ city, region, country }`, or null
 * when it cannot be resolved.
 */
export function resolveZone(location) {
  if (!location) return null;
  const city = norm(location.city);
  const region = norm(location.region);
  if (CITY_ZONES[city]) return CITY_ZONES[city];
  if (CITY_ZONES[region]) return CITY_ZONES[region];
  return regionZone(location.region) ?? regionZone(location.city) ?? COUNTRY_ZONES[norm(location.country)] ?? null;
}

/** Offset of a zone at `date`, in minutes east of UTC (DST-aware). */
function offsetMinutes(zone, date) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" })
      .formatToParts(date);
    const name = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT";
    const m = name.match(/^GMT([+-])(\d{1,2})(?::(\d{2}))?$/);
    if (!m) return 0; // plain "GMT" = UTC
    return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0));
  } catch {
    return null;
  }
}

/** "same time as you" | "3 hours behind you" | "5 hours 30 minutes ahead of you". */
export function timeDiffText(zone, { now = new Date(), homeZone = config.timeZone } = {}) {
  const there = offsetMinutes(zone, now);
  const home = offsetMinutes(homeZone, now);
  if (there == null || home == null) return null;
  const delta = there - home;
  if (delta === 0) return "same time as you";
  const abs = Math.abs(delta);
  const hours = Math.floor(abs / 60);
  const minutes = abs % 60;
  const amount = [
    hours ? `${hours} hour${hours === 1 ? "" : "s"}` : "",
    minutes ? `${minutes} minutes` : "",
  ].filter(Boolean).join(" ");
  return `${amount} ${delta > 0 ? "ahead of" : "behind"} you`;
}

/**
 * "09:42 (3 hours behind you)" for a location, or null when there is no
 * location or its zone cannot be resolved.
 */
export function localTimeNote(location, { now = new Date(), homeZone = config.timeZone } = {}) {
  const zone = resolveZone(location);
  if (!zone) return null;
  const diff = timeDiffText(zone, { now, homeZone });
  if (!diff) return null;
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone, hour: "2-digit", minute: "2-digit",
  }).format(now);
  return `${time} (${diff})`;
}
