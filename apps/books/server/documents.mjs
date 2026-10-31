// Invoices (sales) and bills (purchases) share one model.
// Posting rules:
//   invoice: Dr Accounts Receivable / Cr income lines, Cr sales tax
//   bill:    Dr expense lines, Dr recoverable tax / Cr Accounts Payable
//   payment: moves money between a cash account and AR or AP

import { getSetting, setSetting, systemAccountId, transaction } from "./db.mjs";
import {
  HttpError,
  optionalId,
  optionalText,
  requireDate,
  requireId,
  todayIso,
} from "./http.mjs";
import {
  cashLines,
  deleteEntriesFor,
  postEntry,
  requireAccount,
  requireCashAccount,
} from "./ledger.mjs";
import { lineSubtotal, parseAmount, taxOn } from "./money.mjs";

export const PARTY_KIND = { invoice: "customer", bill: "vendor" };
const LINE_ACCOUNT_TYPES = {
  invoice: ["income"],
  bill: ["expense", "asset"],
};

function loadTaxes(db) {
  return new Map(
    db
      .prepare("SELECT * FROM taxes")
      .all()
      .map((tax) => [tax.id, tax]),
  );
}

/** Compute line, tax and grand totals for a document's lines. */
export function computeTotals(lines, taxes) {
  let subtotal = 0;
  const taxTotals = new Map();
  const computed = lines.map((line) => {
    const amount = lineSubtotal(line.quantity, line.unit_price_cents);
    subtotal += amount;
    const tax = line.tax_id ? taxes.get(line.tax_id) : null;
    const taxAmount = tax ? taxOn(amount, tax.rate_bp) : 0;
    if (tax) {
      const current = taxTotals.get(tax.id) ?? { tax, amount: 0 };
      current.amount += taxAmount;
      taxTotals.set(tax.id, current);
    }
    return { ...line, amount_cents: amount, tax_cents: taxAmount };
  });
  const taxTotal = [...taxTotals.values()].reduce((s, t) => s + t.amount, 0);
  return {
    lines: computed,
    subtotal_cents: subtotal,
    tax_cents: taxTotal,
    total_cents: subtotal + taxTotal,
    taxes: [...taxTotals.values()].map(({ tax, amount }) => ({
      id: tax.id,
      name: tax.name,
      rate_bp: tax.rate_bp,
      amount_cents: amount,
    })),
  };
}

function displayStatus(doc, totals, paid) {
  if (doc.status !== "posted") return doc.status;
  const balance = totals.total_cents - paid;
  if (balance <= 0) return "paid";
  if (doc.due_date < todayIso()) return "overdue";
  return paid > 0 ? "partial" : "unpaid";
}

export function getDocument(db, kind, id) {
  const doc = db
    .prepare(
      `SELECT d.*, p.name AS party_name, p.email AS party_email, p.address AS party_address
       FROM documents d JOIN parties p ON p.id = d.party_id
       WHERE d.id = ? AND d.kind = ?`,
    )
    .get(id, kind);
  if (!doc) throw new HttpError(404, `${kind} not found`);
  const lines = db
    .prepare(
      "SELECT * FROM document_lines WHERE document_id = ? ORDER BY position",
    )
    .all(id);
  const payments = db
    .prepare(
      `SELECT pay.*, a.name AS account_name FROM payments pay
       JOIN accounts a ON a.id = pay.account_id
       WHERE pay.document_id = ? ORDER BY pay.date, pay.id`,
    )
    .all(id);
  const totals = computeTotals(lines, loadTaxes(db));
  const paid = payments.reduce((sum, p) => sum + p.amount_cents, 0);
  return {
    ...doc,
    ...totals,
    payments,
    paid_cents: paid,
    balance_cents: doc.status === "posted" ? totals.total_cents - paid : 0,
    display_status: displayStatus(doc, totals, paid),
  };
}

export function listDocuments(db, kind, filters = {}) {
  const ids = db
    .prepare(
      `SELECT id FROM documents WHERE kind = ?
       AND (? IS NULL OR party_id = ?)
       ORDER BY issue_date DESC, id DESC`,
    )
    .all(kind, filters.partyId ?? null, filters.partyId ?? null);
  const docs = ids.map(({ id }) => {
    const doc = getDocument(db, kind, id);
    delete doc.lines;
    delete doc.taxes;
    return doc;
  });
  return filters.status
    ? docs.filter((doc) => doc.display_status === filters.status)
    : docs;
}

function parseLines(db, kind, rawLines) {
  if (!Array.isArray(rawLines) || rawLines.length === 0) {
    throw new HttpError(400, "Add at least one line item");
  }
  if (rawLines.length > 500) throw new HttpError(400, "Too many line items");
  const taxes = loadTaxes(db);
  return rawLines.map((raw, index) => {
    const label = `Line ${index + 1}`;
    const quantity = Number(raw.quantity ?? 1);
    if (!Number.isFinite(quantity) || Math.abs(quantity) > 1e9) {
      throw new HttpError(400, `${label}: quantity must be a number`);
    }
    const accountId = requireId(raw.account_id, `${label} account`);
    const account = requireAccount(db, accountId, `${label} account`);
    if (!LINE_ACCOUNT_TYPES[kind].includes(account.type) || account.is_cash) {
      throw new HttpError(
        400,
        `${label}: ${kind} lines must use a ${LINE_ACCOUNT_TYPES[kind].join(" or ")} account`,
      );
    }
    const taxId = optionalId(raw.tax_id, `${label} tax`);
    if (taxId && !taxes.has(taxId)) {
      throw new HttpError(400, `${label}: tax does not exist`);
    }
    return {
      position: index,
      description: optionalText(raw.description, `${label} description`, 1000),
      quantity,
      unit_price_cents: parseAmount(raw.unit_price, `${label} price`),
      account_id: accountId,
      tax_id: taxId,
    };
  });
}

function nextInvoiceNumber(db) {
  const prefix = getSetting(db, "invoice_prefix") ?? "";
  let next = Number(getSetting(db, "next_invoice_number") ?? "1");
  const exists = db.prepare(
    "SELECT 1 FROM documents WHERE kind = 'invoice' AND number = ?",
  );
  while (exists.get(`${prefix}${next}`)) next += 1;
  setSetting(db, "next_invoice_number", String(next + 1));
  return `${prefix}${next}`;
}

function parseHeader(db, kind, body) {
  const partyId = requireId(body.party_id, PARTY_KIND[kind]);
  const party = db
    .prepare("SELECT kind FROM parties WHERE id = ?")
    .get(partyId);
  if (party?.kind !== PARTY_KIND[kind]) {
    throw new HttpError(400, `Choose a ${PARTY_KIND[kind]}`);
  }
  const issueDate = requireDate(body.issue_date, "Issue date");
  const dueDate = requireDate(body.due_date, "Due date");
  if (dueDate < issueDate) {
    throw new HttpError(400, "Due date cannot be before the issue date");
  }
  return {
    party_id: partyId,
    issue_date: issueDate,
    due_date: dueDate,
    number: optionalText(body.number, "Number", 60),
    notes: optionalText(body.notes, "Notes", 5000),
  };
}

function writeLines(db, documentId, lines) {
  db.prepare("DELETE FROM document_lines WHERE document_id = ?").run(
    documentId,
  );
  const insert = db.prepare(
    `INSERT INTO document_lines
     (document_id, position, description, quantity, unit_price_cents, account_id, tax_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const line of lines) {
    insert.run(
      documentId,
      line.position,
      line.description,
      line.quantity,
      line.unit_price_cents,
      line.account_id,
      line.tax_id,
    );
  }
}

export function createDocument(db, kind, body) {
  return transaction(db, () => {
    const header = parseHeader(db, kind, body);
    const lines = parseLines(db, kind, body.lines);
    let number = header.number;
    if (!number) {
      number = kind === "invoice" ? nextInvoiceNumber(db) : "";
    }
    assertNumberFree(db, kind, number, null);
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO documents (kind, number, party_id, issue_date, due_date, status, notes)
         VALUES (?, ?, ?, ?, ?, 'draft', ?)`,
      )
      .run(
        kind,
        number,
        header.party_id,
        header.issue_date,
        header.due_date,
        header.notes,
      );
    const id = Number(lastInsertRowid);
    writeLines(db, id, lines);
    if (body.post) postDocument(db, kind, id);
    return getDocument(db, kind, id);
  });
}

function assertNumberFree(db, kind, number, ownId) {
  if (kind !== "invoice") return;
  const clash = db
    .prepare(
      "SELECT id FROM documents WHERE kind = 'invoice' AND number = ? AND id IS NOT ?",
    )
    .get(number, ownId);
  if (clash) throw new HttpError(409, `Invoice number ${number} is in use`);
}

export function updateDocument(db, kind, id, body) {
  return transaction(db, () => {
    const existing = getDocument(db, kind, id);
    if (existing.status === "void") {
      throw new HttpError(409, "Void documents cannot be edited");
    }
    const header = parseHeader(db, kind, body);
    const lines = parseLines(db, kind, body.lines);
    const number = header.number || existing.number;
    assertNumberFree(db, kind, number, id);
    db.prepare(
      `UPDATE documents SET number = ?, party_id = ?, issue_date = ?, due_date = ?, notes = ?
       WHERE id = ?`,
    ).run(
      number,
      header.party_id,
      header.issue_date,
      header.due_date,
      header.notes,
      id,
    );
    writeLines(db, id, lines);
    const updated = getDocument(db, kind, id);
    if (updated.total_cents < updated.paid_cents) {
      throw new HttpError(
        409,
        "Total cannot be less than the payments already recorded",
      );
    }
    if (existing.status === "posted" || body.post) postDocument(db, kind, id);
    return getDocument(db, kind, id);
  });
}

/** (Re)write the journal entry for a document and mark it posted. */
export function postDocument(db, kind, id) {
  return transaction(db, () => {
    const doc = getDocument(db, kind, id);
    if (doc.status === "void") throw new HttpError(409, "Document is void");
    deleteEntriesFor(db, "document", id);
    const taxes = loadTaxes(db);
    const memo = `${kind === "invoice" ? "Invoice" : "Bill"} ${doc.number} – ${doc.party_name}`;
    const lines = [];
    for (const line of doc.lines) {
      const tax = line.tax_id ? taxes.get(line.tax_id) : null;
      if (kind === "invoice") {
        lines.push(
          { accountId: line.account_id, debit: 0, credit: line.amount_cents },
          { accountId: tax?.account_id, debit: 0, credit: line.tax_cents },
        );
      } else {
        const taxAccount = tax?.recoverable ? tax.account_id : line.account_id;
        lines.push(
          { accountId: line.account_id, debit: line.amount_cents, credit: 0 },
          { accountId: taxAccount, debit: line.tax_cents, credit: 0 },
        );
      }
    }
    const controlAccount = systemAccountId(
      db,
      kind === "invoice" ? "ar" : "ap",
    );
    lines.push(
      kind === "invoice"
        ? { accountId: controlAccount, debit: doc.total_cents, credit: 0 }
        : { accountId: controlAccount, debit: 0, credit: doc.total_cents },
    );
    postEntry(db, {
      date: doc.issue_date,
      memo,
      sourceType: "document",
      sourceId: id,
      lines: flipNegativeLines(lines),
    });
    db.prepare("UPDATE documents SET status = 'posted' WHERE id = ?").run(id);
    return getDocument(db, kind, id);
  });
}

/** Negative line amounts (discounts, credits) move to the opposite side. */
function flipNegativeLines(lines) {
  return lines.map((line) => {
    const net = line.debit - line.credit;
    return { ...line, debit: Math.max(net, 0), credit: Math.max(-net, 0) };
  });
}

export function voidDocument(db, kind, id) {
  return transaction(db, () => {
    const doc = getDocument(db, kind, id);
    if (doc.payments.length > 0) {
      throw new HttpError(409, "Remove payments before voiding");
    }
    deleteEntriesFor(db, "document", id);
    db.prepare("UPDATE documents SET status = 'void' WHERE id = ?").run(id);
    return getDocument(db, kind, id);
  });
}

export function deleteDocument(db, kind, id) {
  transaction(db, () => {
    const doc = getDocument(db, kind, id);
    if (doc.status === "posted") {
      throw new HttpError(409, "Void a posted document instead of deleting it");
    }
    if (doc.payments.length > 0) {
      throw new HttpError(409, "Remove payments before deleting");
    }
    deleteEntriesFor(db, "document", id);
    db.prepare("DELETE FROM documents WHERE id = ?").run(id);
  });
}

export function addPayment(db, kind, id, body, bankTransactionId = null) {
  return transaction(db, () => {
    const doc = getDocument(db, kind, id);
    if (doc.status !== "posted") {
      throw new HttpError(409, `Post the ${kind} before recording a payment`);
    }
    const amount = parseAmount(body.amount, "Amount");
    if (amount <= 0) throw new HttpError(400, "Amount must be positive");
    if (amount > doc.balance_cents) {
      throw new HttpError(400, "Payment is more than the balance due");
    }
    const date = requireDate(body.date, "Payment date");
    const accountId = requireId(body.account_id, "Payment account");
    requireCashAccount(db, accountId, "Payment account");
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO payments (document_id, date, amount_cents, account_id, method, bank_transaction_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        date,
        amount,
        accountId,
        optionalText(body.method, "Method", 60),
        bankTransactionId,
      );
    const paymentId = Number(lastInsertRowid);
    const control = systemAccountId(db, kind === "invoice" ? "ar" : "ap");
    const signed = kind === "invoice" ? amount : -amount;
    postEntry(db, {
      date,
      memo: `Payment – ${kind === "invoice" ? "Invoice" : "Bill"} ${doc.number} – ${doc.party_name}`,
      sourceType: "payment",
      sourceId: paymentId,
      lines: cashLines(accountId, control, signed, ""),
    });
    return getDocument(db, kind, id);
  });
}

export function removePayment(db, kind, id, paymentId) {
  return transaction(db, () => {
    const payment = db
      .prepare("SELECT * FROM payments WHERE id = ? AND document_id = ?")
      .get(paymentId, id);
    if (!payment) throw new HttpError(404, "Payment not found");
    deleteEntriesFor(db, "payment", paymentId);
    db.prepare("DELETE FROM payments WHERE id = ?").run(paymentId);
    if (payment.bank_transaction_id) {
      db.prepare(
        "UPDATE bank_transactions SET status = 'new' WHERE id = ?",
      ).run(payment.bank_transaction_id);
    }
    return getDocument(db, kind, id);
  });
}
