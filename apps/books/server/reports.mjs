// Financial reports computed directly from the journal.

import { listDocuments } from "./documents.mjs";
import { HttpError, optionalDate, todayIso } from "./http.mjs";

const NORMAL_DEBIT = new Set(["asset", "expense"]);

/** Net balance per account for entries with from <= date <= to. */
function accountBalances(db, from, to) {
  const rows = db
    .prepare(
      `SELECT a.id, a.code, a.name, a.type, a.is_cash, a.system_key,
              COALESCE(SUM(l.debit_cents), 0) AS debits,
              COALESCE(SUM(l.credit_cents), 0) AS credits
       FROM accounts a
       LEFT JOIN journal_lines l ON l.account_id = a.id
         AND l.entry_id IN (SELECT id FROM journal_entries
                            WHERE (? IS NULL OR date >= ?) AND date <= ?)
       GROUP BY a.id ORDER BY a.code`,
    )
    .all(from, from, to);
  return rows.map((row) => ({
    ...row,
    balance_cents: NORMAL_DEBIT.has(row.type)
      ? row.debits - row.credits
      : row.credits - row.debits,
  }));
}

function section(rows, type) {
  const accounts = rows
    .filter((row) => row.type === type && row.balance_cents !== 0)
    .map(({ id, code, name, balance_cents }) => ({
      id,
      code,
      name,
      balance_cents,
    }));
  return {
    accounts,
    total_cents: accounts.reduce((sum, a) => sum + a.balance_cents, 0),
  };
}

function range(query) {
  const to = optionalDate(query.to, "to") ?? todayIso();
  const from = optionalDate(query.from, "from") ?? `${to.slice(0, 4)}-01-01`;
  if (from > to) throw new HttpError(400, "Start date is after end date");
  return { from, to };
}

export function profitAndLoss(db, query) {
  const { from, to } = range(query);
  const rows = accountBalances(db, from, to);
  const income = section(rows, "income");
  const expenses = section(rows, "expense");
  return {
    from,
    to,
    income,
    expenses,
    net_income_cents: income.total_cents - expenses.total_cents,
  };
}

export function balanceSheet(db, query) {
  const asOf = optionalDate(query.to, "to") ?? todayIso();
  const rows = accountBalances(db, null, asOf);
  const assets = section(rows, "asset");
  const liabilities = section(rows, "liability");
  const equity = section(rows, "equity");
  const earnings =
    section(rows, "income").total_cents - section(rows, "expense").total_cents;
  if (earnings !== 0) {
    equity.accounts.push({
      id: null,
      code: "",
      name: "Retained Earnings (net income to date)",
      balance_cents: earnings,
    });
    equity.total_cents += earnings;
  }
  return {
    to: asOf,
    assets,
    liabilities,
    equity,
    liabilities_and_equity_cents: liabilities.total_cents + equity.total_cents,
    balanced:
      assets.total_cents === liabilities.total_cents + equity.total_cents,
  };
}

function cashFlowCategory(account, taxAccountIds) {
  if (account.type === "income" || account.type === "expense")
    return "operating";
  if (["ar", "ap"].includes(account.system_key)) return "operating";
  if (taxAccountIds.has(account.id)) return "operating";
  if (account.type === "asset") return "investing";
  return "financing";
}

/**
 * Cash flow: for each entry touching a cash account, the non-cash lines
 * explain where the cash came from or went to.
 */
export function cashFlow(db, query) {
  const { from, to } = range(query);
  const accounts = new Map(
    db
      .prepare("SELECT * FROM accounts")
      .all()
      .map((a) => [a.id, a]),
  );
  const lines = db
    .prepare(
      `SELECT l.entry_id, l.account_id, l.debit_cents, l.credit_cents
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
       WHERE e.date >= ? AND e.date <= ? AND l.entry_id IN (
         SELECT l2.entry_id FROM journal_lines l2
         JOIN accounts a2 ON a2.id = l2.account_id WHERE a2.is_cash = 1)`,
    )
    .all(from, to);
  const taxAccountIds = new Set(
    db
      .prepare("SELECT account_id FROM taxes")
      .all()
      .map((t) => t.account_id),
  );
  const groups = {
    operating: new Map(),
    investing: new Map(),
    financing: new Map(),
  };
  for (const line of lines) {
    const account = accounts.get(line.account_id);
    if (account.is_cash) continue;
    const cash = line.credit_cents - line.debit_cents;
    const group = groups[cashFlowCategory(account, taxAccountIds)];
    group.set(account.id, (group.get(account.id) ?? 0) + cash);
  }
  const shape = (group) => {
    const items = [...group.entries()]
      .filter(([, amount]) => amount !== 0)
      .map(([id, amount]) => ({
        id,
        name: accounts.get(id).name,
        amount_cents: amount,
      }));
    return {
      items,
      total_cents: items.reduce((s, i) => s + i.amount_cents, 0),
    };
  };
  const cashBalance = (date, inclusive) =>
    db
      .prepare(
        `SELECT COALESCE(SUM(l.debit_cents - l.credit_cents), 0) AS v
         FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
         JOIN accounts a ON a.id = l.account_id
         WHERE a.is_cash = 1 AND ${inclusive ? "e.date <= ?" : "e.date < ?"}`,
      )
      .get(date).v;
  const result = {
    from,
    to,
    operating: shape(groups.operating),
    investing: shape(groups.investing),
    financing: shape(groups.financing),
    opening_cash_cents: cashBalance(from, false),
    closing_cash_cents: cashBalance(to, true),
  };
  result.net_change_cents =
    result.operating.total_cents +
    result.investing.total_cents +
    result.financing.total_cents;
  return result;
}

const BUCKETS = ["current", "1-30", "31-60", "61-90", "90+"];

function bucketFor(dueDate, asOf) {
  const days = Math.floor(
    (Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${dueDate}T00:00:00Z`)) /
      86400000,
  );
  if (days <= 0) return "current";
  if (days <= 30) return "1-30";
  if (days <= 60) return "31-60";
  if (days <= 90) return "61-90";
  return "90+";
}

/** Aged receivables (invoices) or payables (bills) as of today. */
export function aging(db, kind) {
  const asOf = todayIso();
  const parties = new Map();
  for (const doc of listDocuments(db, kind)) {
    if (doc.status !== "posted" || doc.balance_cents <= 0) continue;
    const party = parties.get(doc.party_id) ?? {
      party_id: doc.party_id,
      name: doc.party_name,
      total_cents: 0,
      ...Object.fromEntries(BUCKETS.map((b) => [b, 0])),
    };
    party[bucketFor(doc.due_date, asOf)] += doc.balance_cents;
    party.total_cents += doc.balance_cents;
    parties.set(doc.party_id, party);
  }
  const rows = [...parties.values()].sort(
    (a, b) => b.total_cents - a.total_cents,
  );
  const totals = Object.fromEntries(
    [...BUCKETS, "total_cents"].map((key) => [
      key,
      rows.reduce((sum, row) => sum + row[key], 0),
    ]),
  );
  return { as_of: asOf, buckets: BUCKETS, rows, totals };
}

export function trialBalance(db, query) {
  const asOf = optionalDate(query.to, "to") ?? todayIso();
  const rows = accountBalances(db, null, asOf)
    .map((row) => {
      const net = row.debits - row.credits;
      return {
        id: row.id,
        code: row.code,
        name: row.name,
        type: row.type,
        debit_cents: Math.max(net, 0),
        credit_cents: Math.max(-net, 0),
      };
    })
    .filter((row) => row.debit_cents || row.credit_cents);
  return {
    to: asOf,
    rows,
    debit_total_cents: rows.reduce((s, r) => s + r.debit_cents, 0),
    credit_total_cents: rows.reduce((s, r) => s + r.credit_cents, 0),
  };
}

/** General ledger for one account with a running balance. */
export function accountLedger(db, accountId, query) {
  const { from, to } = range(query);
  const account = db
    .prepare("SELECT * FROM accounts WHERE id = ?")
    .get(accountId);
  if (!account) throw new HttpError(404, "Account not found");
  const sign = NORMAL_DEBIT.has(account.type) ? 1 : -1;
  const opening =
    db
      .prepare(
        `SELECT COALESCE(SUM(l.debit_cents - l.credit_cents), 0) AS v
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
       WHERE l.account_id = ? AND e.date < ?`,
      )
      .get(accountId, from).v * sign;
  let running = opening;
  const rows = db
    .prepare(
      `SELECT e.id AS entry_id, e.date, e.memo, e.source_type, e.source_id,
              l.debit_cents, l.credit_cents, l.memo AS line_memo
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
       WHERE l.account_id = ? AND e.date >= ? AND e.date <= ?
       ORDER BY e.date, e.id`,
    )
    .all(accountId, from, to)
    .map((row) => {
      running += (row.debit_cents - row.credit_cents) * sign;
      return { ...row, balance_cents: running };
    });
  return {
    account,
    from,
    to,
    opening_cents: opening,
    closing_cents: running,
    rows,
  };
}

export function dashboard(db) {
  const today = todayIso();
  const cash = db
    .prepare(
      `SELECT a.id, a.name, COALESCE(SUM(l.debit_cents - l.credit_cents), 0) AS balance_cents
       FROM accounts a LEFT JOIN journal_lines l ON l.account_id = a.id
       WHERE a.is_cash = 1 AND a.archived = 0 GROUP BY a.id ORDER BY a.code`,
    )
    .all();
  const months = [];
  const start = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
  for (let i = 11; i >= 0; i -= 1) {
    const first = new Date(start);
    first.setUTCMonth(first.getUTCMonth() - i);
    const last = new Date(first);
    last.setUTCMonth(last.getUTCMonth() + 1);
    last.setUTCDate(0);
    const pl = profitAndLoss(db, {
      from: first.toISOString().slice(0, 10),
      to: last.toISOString().slice(0, 10),
    });
    months.push({
      month: first.toISOString().slice(0, 7),
      income_cents: pl.income.total_cents,
      expense_cents: pl.expenses.total_cents,
    });
  }
  const receivables = aging(db, "invoice");
  const payables = aging(db, "bill");
  return {
    cash_accounts: cash,
    receivable_cents: receivables.totals.total_cents,
    overdue_receivable_cents:
      receivables.totals.total_cents - receivables.totals.current,
    payable_cents: payables.totals.total_cents,
    overdue_payable_cents:
      payables.totals.total_cents - payables.totals.current,
    year_to_date: profitAndLoss(db, {
      from: `${today.slice(0, 4)}-01-01`,
      to: today,
    }),
    months,
    uncategorized_count: db
      .prepare(
        "SELECT COUNT(*) AS n FROM bank_transactions WHERE status = 'new'",
      )
      .get().n,
  };
}
