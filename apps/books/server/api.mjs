// JSON API routes. Every route except /api/auth/* requires a session.

import * as accounting from "./accounting.mjs";
import * as auth from "./auth.mjs";
import * as banking from "./banking.mjs";
import { DEFAULT_SETTINGS, setSetting, transaction } from "./db.mjs";
import * as documents from "./documents.mjs";
import { HttpError, Router, optionalText, requireId } from "./http.mjs";
import { previewCsv } from "./importers.mjs";
import * as reports from "./reports.mjs";

const NUMERIC_SETTINGS = new Set(["next_invoice_number", "payment_terms_days"]);

export function buildRouter() {
  const r = new Router();
  const id = (params, name = "id") => requireId(params[name], name);

  // Settings
  r.add("GET", "/api/settings", ({ db }) => readSettings(db));
  r.add("PUT", "/api/settings", ({ db, body }) => {
    transaction(db, () => {
      for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (!(key in body)) continue;
        const value = optionalText(body[key], key, 2000);
        if (NUMERIC_SETTINGS.has(key) && !/^\d{1,9}$/.test(value)) {
          throw new HttpError(
            400,
            `${key.replace(/_/g, " ")} must be a whole number`,
          );
        }
        setSetting(db, key, value);
      }
    });
    return readSettings(db);
  });
  r.add("POST", "/api/settings/password", ({ db, body }) => {
    auth.changePassword(db, body.current, body.next);
    return { ok: true, relogin: true };
  });

  // Chart of accounts & taxes
  r.add("GET", "/api/accounts", ({ db }) => accounting.listAccounts(db));
  r.add("POST", "/api/accounts", ({ db, body }) =>
    accounting.createAccount(db, body),
  );
  r.add("PUT", "/api/accounts/:id", ({ db, params, body }) =>
    accounting.updateAccount(db, id(params), body),
  );
  r.add("GET", "/api/accounts/:id/ledger", ({ db, params, query }) =>
    reports.accountLedger(db, id(params), query),
  );
  r.add("GET", "/api/taxes", ({ db }) => accounting.listTaxes(db));
  r.add("POST", "/api/taxes", ({ db, body }) => accounting.createTax(db, body));
  r.add("PUT", "/api/taxes/:id", ({ db, params, body }) =>
    accounting.updateTax(db, id(params), body),
  );

  // Customers/vendors and invoices/bills share handlers.
  for (const [kind, partyPath, docPath] of [
    ["invoice", "customers", "invoices"],
    ["bill", "vendors", "bills"],
  ]) {
    addDocumentRoutes(r, kind, partyPath, docPath, id);
  }

  // Bank transactions
  r.add("GET", "/api/transactions", ({ db, query }) =>
    banking.listTransactions(db, {
      accountId: query.account_id
        ? requireId(query.account_id, "account")
        : null,
      status: query.status || null,
      from: query.from || null,
      to: query.to || null,
      search: query.search || null,
    }),
  );
  r.add("POST", "/api/transactions", ({ db, body }) =>
    banking.createManualTransaction(db, body),
  );
  r.add("POST", "/api/transactions/import/preview", ({ body }) =>
    previewCsv(String(body.content ?? "")),
  );
  r.add("POST", "/api/transactions/import", ({ db, body }) =>
    banking.importStatement(db, body),
  );
  r.add("POST", "/api/transactions/:id/categorize", ({ db, params, body }) =>
    banking.categorize(db, id(params), body),
  );
  r.add("POST", "/api/transactions/:id/match", ({ db, params, body }) =>
    banking.matchToDocument(db, id(params), body),
  );
  r.add("POST", "/api/transactions/:id/exclude", ({ db, params, body }) =>
    banking.setExcluded(db, id(params), body.excluded !== false),
  );
  r.add("PUT", "/api/transactions/:id/notes", ({ db, params, body }) =>
    banking.updateNotes(db, id(params), body),
  );
  r.add("DELETE", "/api/transactions/:id", ({ db, params }) => {
    banking.deleteTransaction(db, id(params));
    return { ok: true };
  });
  r.add("GET", "/api/transactions/:id/attachments", ({ db, params }) =>
    banking.listAttachments(db, id(params)),
  );
  r.add("POST", "/api/transactions/:id/attachments", ({ db, params, body }) =>
    banking.addAttachment(db, id(params), body),
  );
  r.add("GET", "/api/attachments/:id", ({ db, params }) => {
    const file = db
      .prepare("SELECT filename, mime, data FROM attachments WHERE id = ?")
      .get(id(params));
    if (!file) throw new HttpError(404, "Attachment not found");
    return { raw: true, ...file };
  });
  r.add("DELETE", "/api/attachments/:id", ({ db, params }) => {
    db.prepare("DELETE FROM attachments WHERE id = ?").run(id(params));
    return { ok: true };
  });

  // Manual journal entries
  r.add("GET", "/api/journal", ({ db }) => accounting.listJournalEntries(db));
  r.add("POST", "/api/journal", ({ db, body }) => ({
    id: accounting.saveJournalEntry(db, null, body),
  }));
  r.add("PUT", "/api/journal/:id", ({ db, params, body }) => ({
    id: accounting.saveJournalEntry(db, id(params), body),
  }));
  r.add("DELETE", "/api/journal/:id", ({ db, params }) => {
    accounting.deleteManualEntry(db, id(params));
    return { ok: true };
  });

  // Reports
  r.add("GET", "/api/dashboard", ({ db }) => reports.dashboard(db));
  r.add("GET", "/api/reports/profit-and-loss", ({ db, query }) =>
    reports.profitAndLoss(db, query),
  );
  r.add("GET", "/api/reports/balance-sheet", ({ db, query }) =>
    reports.balanceSheet(db, query),
  );
  r.add("GET", "/api/reports/cash-flow", ({ db, query }) =>
    reports.cashFlow(db, query),
  );
  r.add("GET", "/api/reports/trial-balance", ({ db, query }) =>
    reports.trialBalance(db, query),
  );
  r.add("GET", "/api/reports/aged-receivables", ({ db }) =>
    reports.aging(db, "invoice"),
  );
  r.add("GET", "/api/reports/aged-payables", ({ db }) =>
    reports.aging(db, "bill"),
  );

  return r;
}

function addDocumentRoutes(r, kind, partyPath, docPath, id) {
  const partyKind = documents.PARTY_KIND[kind];
  r.add("GET", `/api/${partyPath}`, ({ db }) =>
    accounting.listParties(db, partyKind),
  );
  r.add("POST", `/api/${partyPath}`, ({ db, body }) =>
    accounting.createParty(db, partyKind, body),
  );
  r.add("GET", `/api/${partyPath}/:id`, ({ db, params }) =>
    accounting.getParty(db, partyKind, id(params)),
  );
  r.add("PUT", `/api/${partyPath}/:id`, ({ db, params, body }) =>
    accounting.updateParty(db, partyKind, id(params), body),
  );
  r.add("DELETE", `/api/${partyPath}/:id`, ({ db, params }) => {
    accounting.deleteParty(db, partyKind, id(params));
    return { ok: true };
  });

  r.add("GET", `/api/${docPath}`, ({ db, query }) =>
    documents.listDocuments(db, kind, {
      partyId: query.party_id ? requireId(query.party_id, "party") : null,
      status: query.status || null,
    }),
  );
  r.add("POST", `/api/${docPath}`, ({ db, body }) =>
    documents.createDocument(db, kind, body),
  );
  r.add("GET", `/api/${docPath}/:id`, ({ db, params }) =>
    documents.getDocument(db, kind, id(params)),
  );
  r.add("PUT", `/api/${docPath}/:id`, ({ db, params, body }) =>
    documents.updateDocument(db, kind, id(params), body),
  );
  r.add("DELETE", `/api/${docPath}/:id`, ({ db, params }) => {
    documents.deleteDocument(db, kind, id(params));
    return { ok: true };
  });
  r.add("POST", `/api/${docPath}/:id/post`, ({ db, params }) =>
    documents.postDocument(db, kind, id(params)),
  );
  r.add("POST", `/api/${docPath}/:id/void`, ({ db, params }) =>
    documents.voidDocument(db, kind, id(params)),
  );
  r.add("POST", `/api/${docPath}/:id/payments`, ({ db, params, body }) =>
    documents.addPayment(db, kind, id(params), body),
  );
  r.add("DELETE", `/api/${docPath}/:id/payments/:paymentId`, ({ db, params }) =>
    documents.removePayment(db, kind, id(params), id(params, "paymentId")),
  );
}

function readSettings(db) {
  const rows = db.prepare("SELECT key, value FROM settings").all();
  const settings = {};
  for (const { key, value } of rows) {
    if (key in DEFAULT_SETTINGS) settings[key] = value;
  }
  return settings;
}
