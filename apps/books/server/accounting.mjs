// Chart of accounts, sales taxes, contacts and manual journal entries.

import { transaction } from "./db.mjs";
import {
  HttpError,
  optionalText,
  requireDate,
  requireId,
  requireOneOf,
  requireText,
} from "./http.mjs";
import { postEntry, requireAccount } from "./ledger.mjs";
import { parseAmount } from "./money.mjs";

export const ACCOUNT_TYPES = [
  "asset",
  "liability",
  "equity",
  "income",
  "expense",
];

export function listAccounts(db) {
  return db
    .prepare(
      `SELECT a.*,
         COALESCE((SELECT SUM(debit_cents - credit_cents) FROM journal_lines
                   WHERE account_id = a.id), 0) AS net_debit_cents
       FROM accounts a ORDER BY a.code`,
    )
    .all()
    .map((a) => ({
      ...a,
      balance_cents: ["asset", "expense"].includes(a.type)
        ? a.net_debit_cents
        : -a.net_debit_cents,
    }));
}

function accountFields(body) {
  const type = requireOneOf(body.type, "Type", ACCOUNT_TYPES);
  const isCash = Boolean(body.is_cash);
  if (isCash && type !== "asset") {
    throw new HttpError(400, "Bank and cash accounts must be assets");
  }
  return {
    code: requireText(body.code, "Code", 20),
    name: requireText(body.name, "Name", 120),
    type,
    is_cash: isCash ? 1 : 0,
    description: optionalText(body.description, "Description", 500),
    archived: body.archived ? 1 : 0,
  };
}

function assertCodeFree(db, code, ownId) {
  const clash = db
    .prepare("SELECT id FROM accounts WHERE code = ? AND id IS NOT ?")
    .get(code, ownId);
  if (clash) throw new HttpError(409, `Account code ${code} is in use`);
}

export function createAccount(db, body) {
  const f = accountFields(body);
  assertCodeFree(db, f.code, null);
  const { lastInsertRowid } = db
    .prepare(
      "INSERT INTO accounts (code, name, type, is_cash, description, archived) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(f.code, f.name, f.type, f.is_cash, f.description, f.archived);
  return requireAccount(db, Number(lastInsertRowid));
}

export function updateAccount(db, id, body) {
  const existing = requireAccount(db, id);
  const f = accountFields(body);
  const used = db
    .prepare("SELECT 1 FROM journal_lines WHERE account_id = ? LIMIT 1")
    .get(id);
  if ((existing.system_key || used) && f.type !== existing.type) {
    throw new HttpError(409, "Type cannot change once an account is in use");
  }
  if (existing.system_key && f.archived) {
    throw new HttpError(409, "Built-in accounts cannot be archived");
  }
  assertCodeFree(db, f.code, id);
  db.prepare(
    "UPDATE accounts SET code = ?, name = ?, type = ?, is_cash = ?, description = ?, archived = ? WHERE id = ?",
  ).run(f.code, f.name, f.type, f.is_cash, f.description, f.archived, id);
  return requireAccount(db, id);
}

export function listTaxes(db) {
  return db.prepare("SELECT * FROM taxes ORDER BY name").all();
}

function parseRate(value) {
  const rate = Number(value);
  if (!Number.isFinite(rate) || rate < 0 || rate > 1000) {
    throw new HttpError(400, "Rate must be a percentage between 0 and 1000");
  }
  return Math.round(rate * 100);
}

export function createTax(db, body) {
  return transaction(db, () => {
    const name = requireText(body.name, "Name", 60);
    const rate = parseRate(body.rate);
    const code = nextFreeCode(db, 2100);
    const { lastInsertRowid: accountId } = db
      .prepare(
        "INSERT INTO accounts (code, name, type, description) VALUES (?, ?, 'liability', ?)",
      )
      .run(code, `${name} Payable`, `Sales tax collected/paid for ${name}`);
    const { lastInsertRowid } = db
      .prepare(
        "INSERT INTO taxes (name, rate_bp, account_id, recoverable) VALUES (?, ?, ?, ?)",
      )
      .run(name, rate, Number(accountId), body.recoverable === false ? 0 : 1);
    return db
      .prepare("SELECT * FROM taxes WHERE id = ?")
      .get(Number(lastInsertRowid));
  });
}

export function updateTax(db, id, body) {
  const tax = db.prepare("SELECT * FROM taxes WHERE id = ?").get(id);
  if (!tax) throw new HttpError(404, "Tax not found");
  const rate = parseRate(body.rate);
  const recoverable = body.recoverable === false ? 0 : 1;
  const used = db
    .prepare("SELECT 1 FROM document_lines WHERE tax_id = ? LIMIT 1")
    .get(id);
  // Posted documents keep their journal entries; changing the math under
  // them would make totals and the ledger disagree.
  if (used && (rate !== tax.rate_bp || recoverable !== tax.recoverable)) {
    throw new HttpError(
      409,
      "This tax is used on documents. Archive it and create a new tax for the new rate.",
    );
  }
  db.prepare(
    "UPDATE taxes SET name = ?, rate_bp = ?, recoverable = ?, archived = ? WHERE id = ?",
  ).run(
    requireText(body.name, "Name", 60),
    rate,
    recoverable,
    body.archived ? 1 : 0,
    id,
  );
  return db.prepare("SELECT * FROM taxes WHERE id = ?").get(id);
}

function nextFreeCode(db, start) {
  const exists = db.prepare("SELECT 1 FROM accounts WHERE code = ?");
  let code = start;
  while (exists.get(String(code))) code += 1;
  return String(code);
}

// Contacts (customers and vendors)

export function listParties(db, kind) {
  return db
    .prepare("SELECT * FROM parties WHERE kind = ? ORDER BY archived, name")
    .all(kind);
}

function partyFields(body) {
  return {
    name: requireText(body.name, "Name", 200),
    email: optionalText(body.email, "Email", 200),
    phone: optionalText(body.phone, "Phone", 60),
    address: optionalText(body.address, "Address", 1000),
    notes: optionalText(body.notes, "Notes", 5000),
    archived: body.archived ? 1 : 0,
  };
}

export function getParty(db, kind, id) {
  const party = db
    .prepare("SELECT * FROM parties WHERE id = ? AND kind = ?")
    .get(id, kind);
  if (!party) throw new HttpError(404, `${kind} not found`);
  return party;
}

export function createParty(db, kind, body) {
  const f = partyFields(body);
  const { lastInsertRowid } = db
    .prepare(
      "INSERT INTO parties (kind, name, email, phone, address, notes, archived) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(kind, f.name, f.email, f.phone, f.address, f.notes, f.archived);
  return getParty(db, kind, Number(lastInsertRowid));
}

export function updateParty(db, kind, id, body) {
  getParty(db, kind, id);
  const f = partyFields(body);
  db.prepare(
    "UPDATE parties SET name = ?, email = ?, phone = ?, address = ?, notes = ?, archived = ? WHERE id = ?",
  ).run(f.name, f.email, f.phone, f.address, f.notes, f.archived, id);
  return getParty(db, kind, id);
}

export function deleteParty(db, kind, id) {
  getParty(db, kind, id);
  const used = db.prepare("SELECT 1 FROM documents WHERE party_id = ?").get(id);
  if (used) {
    throw new HttpError(409, "This contact has documents; archive it instead");
  }
  db.prepare("DELETE FROM parties WHERE id = ?").run(id);
}

// Manual journal entries (opening balances, adjustments, transfers)

export function listJournalEntries(db) {
  const entries = db
    .prepare(
      "SELECT * FROM journal_entries WHERE source_type = 'manual' ORDER BY date DESC, id DESC",
    )
    .all();
  const lines = db.prepare(
    `SELECT l.*, a.name AS account_name, a.code AS account_code
     FROM journal_lines l JOIN accounts a ON a.id = l.account_id
     WHERE l.entry_id = ? ORDER BY l.id`,
  );
  return entries.map((entry) => ({ ...entry, lines: lines.all(entry.id) }));
}

export function saveJournalEntry(db, id, body) {
  const date = requireDate(body.date, "Date");
  const memo = optionalText(body.memo, "Memo", 500);
  if (!Array.isArray(body.lines) || body.lines.length < 2) {
    throw new HttpError(400, "A journal entry needs at least two lines");
  }
  const lines = body.lines.map((raw, i) => {
    const accountId = requireId(raw.account_id, `Line ${i + 1} account`);
    requireAccount(db, accountId, `Line ${i + 1} account`);
    const debit = raw.debit ? parseAmount(raw.debit, `Line ${i + 1} debit`) : 0;
    const credit = raw.credit
      ? parseAmount(raw.credit, `Line ${i + 1} credit`)
      : 0;
    if (debit < 0 || credit < 0) {
      throw new HttpError(400, `Line ${i + 1}: amounts cannot be negative`);
    }
    return {
      accountId,
      debit,
      credit,
      memo: optionalText(raw.memo, "Memo", 300),
    };
  });
  return transaction(db, () => {
    if (id) deleteManualEntry(db, id);
    const entryId = postEntry(db, { date, memo, sourceType: "manual", lines });
    if (!entryId) throw new HttpError(400, "Enter at least one amount");
    return entryId;
  });
}

export function deleteManualEntry(db, id) {
  const entry = db
    .prepare(
      "SELECT * FROM journal_entries WHERE id = ? AND source_type = 'manual'",
    )
    .get(id);
  if (!entry) throw new HttpError(404, "Journal entry not found");
  db.prepare("DELETE FROM journal_entries WHERE id = ?").run(id);
}
