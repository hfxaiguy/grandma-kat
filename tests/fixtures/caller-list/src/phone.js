// Phone selection + normalization. Contacts store free-form numbers; the
// caller wants a dialable number (Telnyx wants E.164, Telegram dials raw).

// B2B leads answer at the office, so work numbers rank first; mobiles are
// the fallback. Keep the pattern order here in sync with `phoneRank`.
const LABEL_RANK = [
  /work|office|direct|desk|business/i,
  /mobile|cell|wireless/i,
];

/** Preference of a label: 0 = work, 1 = mobile, 2 = anything else. */
export function phoneRank(label) {
  const l = String(label ?? "");
  for (let i = 0; i < LABEL_RANK.length; i++) if (LABEL_RANK[i].test(l)) return i;
  return LABEL_RANK.length;
}

/**
 * Dialing preference: valid numbers before invalid ones (a number marked
 * invalid was tried and rejected), then work before mobile, else stored order.
 */
export function phoneOrder(phone) {
  return (phone?.status === "invalid" ? 100 : 0) + phoneRank(phone?.label);
}

/** Pick the number to call: work first, then mobile, else the first stored. */
export function choosePhone(contact) {
  const phones = Array.isArray(contact?.phones) ? contact.phones : [];
  let best = null;
  let bestRank = Infinity;
  for (const p of phones) {
    const number = String(p?.number ?? "").trim();
    if (!number) continue;
    const rank = phoneOrder(p);
    if (rank < bestRank) {
      bestRank = rank;
      best = { number, label: String(p?.label ?? "").trim() };
    }
  }
  return best;
}

/**
 * Best-effort E.164 normalization (North-America biased): 10 digits -> +1…,
 * 11 digits starting with 1 -> +…, anything else -> +digits. Returns null when
 * there are no digits. The raw number is still returned alongside by callers.
 */
export function toE164(number) {
  if (!number) return null;
  const raw = String(number).trim();
  const digits = raw.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) {
    const plusDigits = digits.replace(/\D/g, "");
    return plusDigits ? "+" + plusDigits : null;
  }
  const cleaned = digits.replace(/\D/g, "");
  if (cleaned.length === 10) return "+1" + cleaned;
  if (cleaned.length === 11 && cleaned.startsWith("1")) return "+" + cleaned;
  return cleaned ? "+" + cleaned : null;
}
