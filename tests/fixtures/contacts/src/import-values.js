// Required value transform for CSV/TSV imports.
//
// Raw cells from lead exports are messy: several numbers crammed into one
// cell ("12032210029 +1 860-284-4200"), digits with no country code, plus
// extensions glued on. The import tree passes every mapped cell through
// transformImportValue() before upsert_contact, so a stored phone is one
// dialable number in E.164. This is deterministic code, not a prompt: the
// same cell always yields the same values.
//
// "Required" is literal — rowToContact in tree.mjs imports this module and
// always runs the transform. Deleting it breaks the import.

/** 10 digits (assume +1) or 11 starting with 1 -> E.164. */
function toE164(digits) {
  if (digits.length === 11 && digits[0] === "1") return "+" + digits;
  if (digits.length === 10) return "+1" + digits;
  return "+" + digits;
}

/**
 * Split a phone cell into normalized numbers, deduped.
 *
 *   "12032210029 +1 860-284-4200"  -> ["+12032210029", "+18602844200"]
 *   "+1 203-222-0136 12032210029"  -> ["+12032220136", "+12032210029"]
 *   "12134975396"                  -> ["+12134975396"]
 *   "+44 20 7946 0958"             -> ["+442079460958"]
 *
 * A `+` starts a new number. Without one, a run of digits is taken 11 at a
 * time when it starts with 1 (US/CA), else 10 at a time. Extensions are not
 * dialable and are dropped.
 */
export function splitPhones(raw) {
  const cell = String(raw ?? "").trim();
  if (!cell) return [];
  const out = [];
  for (const chunk of cell.split(/(?=\+)/)) {
    const part = chunk.trim();
    if (!part) continue;
    const hasPlus = part.startsWith("+");
    // " ext. 230" / "x230" belongs to the number before it; drop it.
    const head = part.replace(/\b(?:ext|extension|x)\.?\s*\d+\s*$/i, "");
    let digits = head.replace(/\D/g, "");
    if (!digits) continue;
    if (hasPlus && digits.length <= 14) {
      out.push("+" + digits);
      continue;
    }
    while (digits.length >= 10) {
      const take = digits.length >= 11 && digits[0] === "1" ? 11 : 10;
      out.push(toE164(digits.slice(0, take)));
      digits = digits.slice(take);
    }
  }
  return [...new Set(out)];
}

/**
 * The transform hook: one mapped CSV cell in, one or more contact values out.
 * Only phones are rewritten today; other fields pass through untouched.
 */
export function transformImportValue(field, value) {
  if (field?.attr === "phone") return splitPhones(value);
  return value;
}
