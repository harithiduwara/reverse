// Double-entry journal. Every financial event becomes a balanced entry.

import { transaction } from "./db.mjs";
import { HttpError } from "./http.mjs";

/**
 * Post a balanced journal entry.
 * lines: [{ accountId, debit, credit, memo }] with non-negative cents.
 * Lines with zero on both sides are dropped.
 */
export function postEntry(
  db,
  { date, memo = "", sourceType, sourceId = null, lines },
) {
  const kept = lines.filter((line) => line.debit > 0 || line.credit > 0);
  let debits = 0;
  let credits = 0;
  for (const line of kept) {
    if (line.debit < 0 || line.credit < 0) {
      throw new HttpError(400, "Journal amounts cannot be negative");
    }
    debits += line.debit;
    credits += line.credit;
  }
  if (debits !== credits) {
    throw new HttpError(400, "Journal entry is not balanced");
  }
  if (kept.length === 0) return null;
  return transaction(db, () => {
    const { lastInsertRowid } = db
      .prepare(
        "INSERT INTO journal_entries (date, memo, source_type, source_id) VALUES (?, ?, ?, ?)",
      )
      .run(date, memo, sourceType, sourceId);
    const entryId = Number(lastInsertRowid);
    const insertLine = db.prepare(
      "INSERT INTO journal_lines (entry_id, account_id, debit_cents, credit_cents, memo) VALUES (?, ?, ?, ?, ?)",
    );
    for (const line of mergeLines(kept)) {
      insertLine.run(
        entryId,
        line.accountId,
        line.debit,
        line.credit,
        line.memo ?? "",
      );
    }
    return entryId;
  });
}

/** Collapse lines on the same account and memo so entries stay readable. */
function mergeLines(lines) {
  const merged = new Map();
  for (const line of lines) {
    const key = `${line.accountId}\u0000${line.memo ?? ""}`;
    const existing = merged.get(key);
    if (existing) {
      existing.debit += line.debit;
      existing.credit += line.credit;
    } else {
      merged.set(key, { ...line });
    }
  }
  return [...merged.values()].map((line) => {
    const net = line.debit - line.credit;
    return { ...line, debit: Math.max(net, 0), credit: Math.max(-net, 0) };
  });
}

export function deleteEntriesFor(db, sourceType, sourceId) {
  db.prepare(
    "DELETE FROM journal_entries WHERE source_type = ? AND source_id = ?",
  ).run(sourceType, sourceId);
}

export function requireAccount(db, id, field = "account") {
  const account = db.prepare("SELECT * FROM accounts WHERE id = ?").get(id);
  if (!account) throw new HttpError(400, `${field} does not exist`);
  return account;
}

export function requireCashAccount(db, id, field = "account") {
  const account = requireAccount(db, id, field);
  if (!account.is_cash) {
    throw new HttpError(400, `${field} must be a bank or cash account`);
  }
  return account;
}

/** Signed cash movement into a cash account as journal lines. */
export function cashLines(cashAccountId, otherAccountId, amountCents, memo) {
  const abs = Math.abs(amountCents);
  const intoCash = amountCents > 0;
  return [
    {
      accountId: cashAccountId,
      debit: intoCash ? abs : 0,
      credit: intoCash ? 0 : abs,
      memo,
    },
    {
      accountId: otherAccountId,
      debit: intoCash ? 0 : abs,
      credit: intoCash ? abs : 0,
      memo,
    },
  ];
}
