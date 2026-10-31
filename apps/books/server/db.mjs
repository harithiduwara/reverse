// Database setup. Uses Node's built-in SQLite (node:sqlite), no extra deps.

import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('asset','liability','equity','income','expense')),
  is_cash INTEGER NOT NULL DEFAULT 0,
  system_key TEXT UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  archived INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE IF NOT EXISTS taxes (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  rate_bp INTEGER NOT NULL CHECK (rate_bp >= 0 AND rate_bp <= 100000),
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  recoverable INTEGER NOT NULL DEFAULT 1,
  archived INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE IF NOT EXISTS parties (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('customer','vendor')),
  name TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  archived INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('invoice','bill')),
  number TEXT NOT NULL,
  party_id INTEGER NOT NULL REFERENCES parties(id),
  issue_date TEXT NOT NULL,
  due_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','posted','void')),
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS documents_invoice_number
  ON documents (number) WHERE kind = 'invoice';

CREATE TABLE IF NOT EXISTS document_lines (
  id INTEGER PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  description TEXT NOT NULL,
  quantity REAL NOT NULL,
  unit_price_cents INTEGER NOT NULL,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  tax_id INTEGER REFERENCES taxes(id)
) STRICT;

CREATE TABLE IF NOT EXISTS journal_entries (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL,
  memo TEXT NOT NULL DEFAULT '',
  source_type TEXT NOT NULL,
  source_id INTEGER
) STRICT;
CREATE INDEX IF NOT EXISTS journal_entries_source
  ON journal_entries (source_type, source_id);
CREATE INDEX IF NOT EXISTS journal_entries_date ON journal_entries (date);

CREATE TABLE IF NOT EXISTS journal_lines (
  id INTEGER PRIMARY KEY,
  entry_id INTEGER NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  debit_cents INTEGER NOT NULL DEFAULT 0 CHECK (debit_cents >= 0),
  credit_cents INTEGER NOT NULL DEFAULT 0 CHECK (credit_cents >= 0),
  memo TEXT NOT NULL DEFAULT ''
) STRICT;
CREATE INDEX IF NOT EXISTS journal_lines_account ON journal_lines (account_id);
CREATE INDEX IF NOT EXISTS journal_lines_entry ON journal_lines (entry_id);

CREATE TABLE IF NOT EXISTS bank_transactions (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  date TEXT NOT NULL,
  description TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('import','manual')),
  status TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new','categorized','matched','excluded')),
  category_account_id INTEGER REFERENCES accounts(id),
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (account_id, fingerprint)
) STRICT;

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES documents(id),
  date TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  method TEXT NOT NULL DEFAULT '',
  bank_transaction_id INTEGER UNIQUE REFERENCES bank_transactions(id)
) STRICT;

CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY,
  bank_transaction_id INTEGER NOT NULL
    REFERENCES bank_transactions(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  data BLOB NOT NULL
) STRICT;
`;

const DEFAULT_ACCOUNTS = [
  ["1000", "Cash on Hand", "asset", 1, null],
  ["1010", "Business Checking", "asset", 1, null],
  ["1200", "Accounts Receivable", "asset", 0, "ar"],
  ["1500", "Equipment", "asset", 0, null],
  ["2000", "Accounts Payable", "liability", 0, "ap"],
  ["2500", "Loans Payable", "liability", 0, null],
  ["3000", "Owner Investment", "equity", 0, null],
  ["3100", "Owner Drawings", "equity", 0, null],
  ["3900", "Opening Balance Equity", "equity", 0, "opening"],
  ["4000", "Sales", "income", 0, "sales"],
  ["4100", "Services", "income", 0, null],
  ["4900", "Uncategorized Income", "income", 0, "uncat_income"],
  ["5000", "Cost of Goods Sold", "expense", 0, null],
  ["6000", "Advertising", "expense", 0, null],
  ["6100", "Bank Fees", "expense", 0, null],
  ["6200", "Meals", "expense", 0, null],
  ["6300", "Office Supplies", "expense", 0, null],
  ["6400", "Rent", "expense", 0, null],
  ["6500", "Software & Subscriptions", "expense", 0, null],
  ["6600", "Travel", "expense", 0, null],
  ["6700", "Utilities", "expense", 0, null],
  ["6800", "Professional Fees", "expense", 0, null],
  ["6900", "Uncategorized Expense", "expense", 0, "uncat_expense"],
];

export const DEFAULT_SETTINGS = {
  business_name: "My Business",
  business_address: "",
  business_email: "",
  business_phone: "",
  currency: "USD",
  invoice_prefix: "INV-",
  next_invoice_number: "1001",
  payment_terms_days: "30",
  invoice_footer: "Thank you for your business.",
};

export function openDatabase(path) {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  seed(db);
  return db;
}

function seed(db) {
  const hasAccounts = db.prepare("SELECT 1 FROM accounts LIMIT 1").get();
  if (!hasAccounts) {
    const insert = db.prepare(
      "INSERT INTO accounts (code, name, type, is_cash, system_key) VALUES (?, ?, ?, ?, ?)",
    );
    transaction(db, () => {
      for (const row of DEFAULT_ACCOUNTS) insert.run(...row);
    });
  }
  const insertSetting = db.prepare(
    "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)",
  );
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    insertSetting.run(key, value);
  }
}

/** Run fn inside a transaction; nested calls join the outer transaction. */
export function transaction(db, fn) {
  if (db.isTransaction) return fn();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function getSetting(db, key) {
  return db.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value;
}

export function setSetting(db, key, value) {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

export function systemAccountId(db, key) {
  const row = db
    .prepare("SELECT id FROM accounts WHERE system_key = ?")
    .get(key);
  if (!row) throw new Error(`Missing system account: ${key}`);
  return row.id;
}
