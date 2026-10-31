// Bank and cash transactions: import, add manually, categorize, match.
// A categorized transaction posts: cash account <-> chosen category.
// A matched transaction becomes an invoice/bill payment instead.

import { randomUUID } from "node:crypto";
import { transaction } from "./db.mjs";
import { addPayment, getDocument, removePayment } from "./documents.mjs";
import {
  HttpError,
  optionalId,
  optionalText,
  requireDate,
  requireId,
  requireOneOf,
  requireText,
} from "./http.mjs";
import {
  transactionsFromCsv,
  transactionsFromOfx,
  looksLikeOfx,
} from "./importers.mjs";
import {
  cashLines,
  deleteEntriesFor,
  postEntry,
  requireAccount,
  requireCashAccount,
} from "./ledger.mjs";
import { formatCents, parseAmount } from "./money.mjs";

const BASE_QUERY = `
  SELECT t.*, a.name AS account_name, c.name AS category_name,
         pay.document_id AS matched_document_id, d.kind AS matched_kind,
         d.number AS matched_number,
         (SELECT COUNT(*) FROM attachments x WHERE x.bank_transaction_id = t.id)
           AS attachment_count
  FROM bank_transactions t
  JOIN accounts a ON a.id = t.account_id
  LEFT JOIN accounts c ON c.id = t.category_account_id
  LEFT JOIN payments pay ON pay.bank_transaction_id = t.id
  LEFT JOIN documents d ON d.id = pay.document_id`;

export function getTransaction(db, id) {
  const row = db.prepare(`${BASE_QUERY} WHERE t.id = ?`).get(id);
  if (!row) throw new HttpError(404, "Transaction not found");
  return row;
}

export function listTransactions(db, filters) {
  const where = [];
  const params = [];
  if (filters.accountId) {
    where.push("t.account_id = ?");
    params.push(filters.accountId);
  }
  if (filters.status) {
    where.push("t.status = ?");
    params.push(filters.status);
  }
  if (filters.from) {
    where.push("t.date >= ?");
    params.push(filters.from);
  }
  if (filters.to) {
    where.push("t.date <= ?");
    params.push(filters.to);
  }
  if (filters.search) {
    where.push("t.description LIKE ? ESCAPE '\\'");
    params.push(`%${filters.search.replace(/[%_\\]/g, "\\$&")}%`);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  return db
    .prepare(
      `${BASE_QUERY} ${clause} ORDER BY t.date DESC, t.id DESC LIMIT 2000`,
    )
    .all(...params);
}

function insertTransaction(db, accountId, txn, source) {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO bank_transactions
       (account_id, date, description, amount_cents, fingerprint, source, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      accountId,
      txn.date,
      txn.description,
      txn.amount_cents,
      txn.fingerprint,
      source,
      txn.notes ?? "",
    );
  return result.changes > 0 ? Number(result.lastInsertRowid) : null;
}

export function importStatement(db, body) {
  const accountId = requireId(body.account_id, "Bank account");
  requireCashAccount(db, accountId, "Bank account");
  if (typeof body.content !== "string" || body.content.length === 0) {
    throw new HttpError(400, "Upload a CSV or OFX file");
  }
  const parsed = looksLikeOfx(body.content)
    ? transactionsFromOfx(body.content)
    : transactionsFromCsv(body.content, body.mapping ?? {});
  return transaction(db, () => {
    let imported = 0;
    for (const txn of parsed.transactions) {
      if (insertTransaction(db, accountId, txn, "import")) imported += 1;
    }
    return {
      imported,
      duplicates: parsed.transactions.length - imported,
      skipped: parsed.skipped,
    };
  });
}

export function createManualTransaction(db, body) {
  const accountId = requireId(body.account_id, "Account");
  requireCashAccount(db, accountId, "Account");
  const amount = parseAmount(body.amount, "Amount");
  if (amount === 0) throw new HttpError(400, "Amount cannot be zero");
  const direction = requireOneOf(body.direction, "Direction", [
    "deposit",
    "withdrawal",
  ]);
  const signed = direction === "deposit" ? Math.abs(amount) : -Math.abs(amount);
  return transaction(db, () => {
    const id = insertTransaction(
      db,
      accountId,
      {
        date: requireDate(body.date, "Date"),
        description: requireText(body.description, "Description", 300),
        amount_cents: signed,
        fingerprint: `manual:${randomUUID()}`,
        notes: optionalText(body.notes, "Notes", 2000),
      },
      "manual",
    );
    const categoryId = optionalId(body.category_account_id, "Category");
    if (categoryId) categorize(db, id, { category_account_id: categoryId });
    return getTransaction(db, id);
  });
}

/** Undo whatever the transaction currently posts (category or match). */
function clearPosting(db, txn) {
  deleteEntriesFor(db, "bank", txn.id);
  if (txn.status === "matched") {
    const payment = db
      .prepare("SELECT * FROM payments WHERE bank_transaction_id = ?")
      .get(txn.id);
    if (payment) {
      const doc = db
        .prepare("SELECT kind FROM documents WHERE id = ?")
        .get(payment.document_id);
      removePayment(db, doc.kind, payment.document_id, payment.id);
    }
  }
  db.prepare(
    "UPDATE bank_transactions SET status = 'new', category_account_id = NULL WHERE id = ?",
  ).run(txn.id);
}

export function categorize(db, id, body) {
  return transaction(db, () => {
    const txn = getTransaction(db, id);
    const categoryId = requireId(body.category_account_id, "Category");
    const category = requireAccount(db, categoryId, "Category");
    if (category.id === txn.account_id) {
      throw new HttpError(
        400,
        "Choose a different account than the bank account",
      );
    }
    if (category.system_key === "ar" || category.system_key === "ap") {
      throw new HttpError(
        400,
        "Match the transaction to an invoice or bill instead",
      );
    }
    clearPosting(db, txn);
    postEntry(db, {
      date: txn.date,
      memo: txn.description,
      sourceType: "bank",
      sourceId: id,
      lines: cashLines(txn.account_id, categoryId, txn.amount_cents, ""),
    });
    db.prepare(
      "UPDATE bank_transactions SET status = 'categorized', category_account_id = ? WHERE id = ?",
    ).run(categoryId, id);
    return getTransaction(db, id);
  });
}

export function matchToDocument(db, id, body) {
  return transaction(db, () => {
    const txn = getTransaction(db, id);
    const kind = requireOneOf(body.kind, "Kind", ["invoice", "bill"]);
    const documentId = requireId(body.document_id, "Document");
    const expectedSign = kind === "invoice" ? 1 : -1;
    if (Math.sign(txn.amount_cents) !== expectedSign) {
      throw new HttpError(
        400,
        kind === "invoice"
          ? "Only deposits can pay an invoice"
          : "Only withdrawals can pay a bill",
      );
    }
    getDocument(db, kind, documentId);
    clearPosting(db, txn);
    addPayment(
      db,
      kind,
      documentId,
      {
        date: txn.date,
        amount: formatCents(Math.abs(txn.amount_cents)),
        account_id: txn.account_id,
        method: "Bank",
      },
      id,
    );
    db.prepare(
      "UPDATE bank_transactions SET status = 'matched' WHERE id = ?",
    ).run(id);
    return getTransaction(db, id);
  });
}

export function setExcluded(db, id, excluded) {
  return transaction(db, () => {
    const txn = getTransaction(db, id);
    clearPosting(db, txn);
    if (excluded) {
      db.prepare(
        "UPDATE bank_transactions SET status = 'excluded' WHERE id = ?",
      ).run(id);
    }
    return getTransaction(db, id);
  });
}

export function updateNotes(db, id, body) {
  getTransaction(db, id);
  db.prepare("UPDATE bank_transactions SET notes = ? WHERE id = ?").run(
    optionalText(body.notes, "Notes", 2000),
    id,
  );
  return getTransaction(db, id);
}

export function deleteTransaction(db, id) {
  transaction(db, () => {
    const txn = getTransaction(db, id);
    clearPosting(db, txn);
    db.prepare("DELETE FROM bank_transactions WHERE id = ?").run(id);
  });
}

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME = /^(image\/(png|jpeg|gif|webp|heic)|application\/pdf)$/;

export function addAttachment(db, id, body) {
  getTransaction(db, id);
  const filename = requireText(body.filename, "File name", 200);
  const mime = requireText(body.mime, "File type", 100);
  if (!ALLOWED_MIME.test(mime)) {
    throw new HttpError(400, "Receipts must be an image or PDF");
  }
  const data = Buffer.from(String(body.data_base64 ?? ""), "base64");
  if (data.length === 0 || data.length > MAX_ATTACHMENT_BYTES) {
    throw new HttpError(400, "Receipts must be between 1 byte and 10 MB");
  }
  const { lastInsertRowid } = db
    .prepare(
      "INSERT INTO attachments (bank_transaction_id, filename, mime, data) VALUES (?, ?, ?, ?)",
    )
    .run(id, filename, mime, data);
  return { id: Number(lastInsertRowid), filename, mime };
}

export function listAttachments(db, id) {
  return db
    .prepare(
      "SELECT id, filename, mime, length(data) AS size FROM attachments WHERE bank_transaction_id = ?",
    )
    .all(id);
}
