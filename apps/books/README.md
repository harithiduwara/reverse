# Books

A self-hosted, single-user replacement for Wave: invoicing, bills, bank
imports, double-entry bookkeeping and financial reports. It has no third-party
dependencies. It uses Node.js and its built-in SQLite database, and your data
lives in one file on your machine.

> This app is separate from REA. It has its own `package.json` and does not use
> or change any REA code.

## Features

- **Sales:** customers, invoices with line items and sales tax, draft/approve,
  automatic numbering, partial payments, overdue tracking, printable invoices
  (Print → Save as PDF), and an email draft link.
- **Purchases:** vendors, bills, bill payments, recoverable and
  non-recoverable tax.
- **Banking:** import CSV (with column mapping and date-format detection) or
  OFX/QFX statements. Re-imports skip duplicates. Categorize transactions,
  match deposits and withdrawals to invoices and bills, exclude transactions,
  add expenses by hand, and attach receipts (images/PDF).
- **Bookkeeping:** editable chart of accounts, manual journal entries (opening
  balances, loans, owner investment, adjustments) and a ledger for each account.
  Every invoice, bill, payment and categorized transaction posts a balanced
  double-entry journal entry.
- **Reports:** Profit & Loss, Balance Sheet, Cash Flow, Aged Receivables, Aged
  Payables and Trial Balance. Each can export to CSV or print to PDF.
- **Dashboard:** cash, receivables, payables, net income this year and a
  12-month income and expense chart.
- **Safety:** password login (scrypt), HttpOnly SameSite cookies, JSON-only
  writes, a strict Content Security Policy and one-click backups.

## Run it

You need Node.js 22.13 or newer.

```bash
cd apps/books
npm start
```

Open http://127.0.0.1:4300 and choose a password on first launch.

| Variable               | Default             | Meaning                                        |
| ---------------------- | ------------------- | ---------------------------------------------- |
| `BOOKS_PORT`           | `4300`              | HTTP port                                      |
| `BOOKS_HOST`           | `127.0.0.1`         | Interface to listen on (local only by default) |
| `BOOKS_DB`             | `data/books.sqlite` | Database file                                  |
| `BOOKS_SECURE_COOKIES` | unset               | Set to `1` when serving over HTTPS             |

To reach it from other devices, put it behind a reverse proxy with HTTPS
(for example Caddy or nginx), set `BOOKS_SECURE_COOKIES=1`, and keep
`BOOKS_HOST=127.0.0.1` so that only the proxy is exposed.

## Getting started checklist

1. **Settings:** set your business name, address, currency, invoice prefix and
   sales taxes.
2. **Chart of accounts:** rename "Business Checking" or add your real bank and
   credit-card accounts. Mark them as bank or cash accounts.
3. **Journal entries:** enter opening balances (debit the bank and credit
   Opening Balance Equity).
4. Create invoices and bills, then import bank statements and match or
   categorize them.

## Backups and moving from Wave

- **Settings → Download backup** saves a full copy of the database. To restore
  it, stop the app and replace the `BOOKS_DB` file.
- From Wave, export your customers, vendors and bank transactions as CSV. Import
  the bank CSVs here; customers and vendors are entered by hand for now.

## Tests

```bash
npm test
```

These tests start a real server on a temporary database. They cover login,
invoices with tax and discounts, payments, bills, CSV/OFX import and
de-duplication, matching and unmatching, manual journals, report consistency
(balance sheet balances, cash flow reconciles) and backups.

## Not included yet

- Automatic bank feeds (Plaid and similar services need paid API keys). Use
  file imports instead.
- Sending email from the server (the Email button opens your mail app instead),
  online card payments, recurring invoices, estimates, payroll, multiple
  currencies and multiple users.
- Importing customers and vendors from a CSV.
