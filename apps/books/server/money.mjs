// All amounts are stored as integer cents to avoid floating-point drift.

import { HttpError } from "./http.mjs";

const AMOUNT_PATTERN = /^(-)?(\d{1,13})(?:\.(\d{1,2}))?$/;

/** Parse a user-supplied amount ("12.5", "-3", 1250 cents is NOT accepted). */
export function parseAmount(value, field = "amount") {
  if (typeof value === "number") value = String(value);
  if (typeof value !== "string") {
    throw new HttpError(400, `${field} must be a decimal amount`);
  }
  const cleaned = value.trim().replace(/[,$\s]/g, "");
  const match = AMOUNT_PATTERN.exec(cleaned);
  if (!match) throw new HttpError(400, `${field} must be a decimal amount`);
  const [, sign, whole, fraction = ""] = match;
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return sign ? -cents : cents;
}

/** Parse an amount from a bank file, where parentheses mean negative. */
export function parseStatementAmount(raw) {
  let text = String(raw ?? "").trim();
  if (text === "") return null;
  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }
  if (text.endsWith("-")) {
    negative = !negative;
    text = text.slice(0, -1);
  }
  try {
    const cents = parseAmount(text);
    return negative ? -cents : cents;
  } catch {
    return null;
  }
}

export function formatCents(cents) {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** Line subtotal in cents. Quantity may be fractional (e.g. 1.5 hours). */
export function lineSubtotal(quantity, unitPriceCents) {
  return Math.round(quantity * unitPriceCents);
}

/** Tax in cents for a subtotal and a rate in basis points (1300 = 13%). */
export function taxOn(subtotalCents, rateBasisPoints) {
  return Math.round((subtotalCents * rateBasisPoints) / 10000);
}
