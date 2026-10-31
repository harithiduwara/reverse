// End-to-end API tests: run a real server on a temp database.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { createApp } from "../server/main.mjs";

let server;
let base;
let cookie = "";
let dir;

async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  const type = res.headers.get("content-type") ?? "";
  const data = type.includes("json")
    ? await res.json()
    : await res.arrayBuffer();
  return { status: res.status, data };
}

async function ok(method, path, body) {
  const { status, data } = await call(method, path, body);
  assert.ok(
    status < 300,
    `${method} ${path} -> ${status} ${JSON.stringify(data)}`,
  );
  return data;
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "books-test-"));
  ({ server } = createApp({ databasePath: join(dir, "test.sqlite") }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

const accountId = (accounts, code) => accounts.find((a) => a.code === code).id;

describe("books", () => {
  let accounts;
  let customer;
  let vendor;
  let invoice;
  let bill;
  let tax;

  test("requires login and sets up a password once", async () => {
    assert.equal((await call("GET", "/api/accounts")).status, 401);
    const status = await ok("GET", "/api/auth/status");
    assert.equal(status.set_up, false);
    assert.equal(
      (await call("POST", "/api/auth/setup", { password: "short" })).status,
      400,
    );
    await ok("POST", "/api/auth/setup", { password: "correct horse battery" });
    assert.equal(
      (await call("POST", "/api/auth/setup", { password: "another password" }))
        .status,
      409,
    );
    await ok("POST", "/api/auth/logout", {});
    assert.equal((await call("GET", "/api/accounts")).status, 401);
    assert.equal(
      (await call("POST", "/api/auth/login", { password: "wrong password!" }))
        .status,
      401,
    );
    await ok("POST", "/api/auth/login", { password: "correct horse battery" });
    accounts = await ok("GET", "/api/accounts");
    assert.ok(accounts.length > 10);
  });

  test("rejects non-JSON writes", async () => {
    const res = await fetch(`${base}/api/customers`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "name=x",
    });
    assert.equal(res.status, 415);
  });

  test("creates contacts and a sales tax", async () => {
    customer = await ok("POST", "/api/customers", {
      name: "Acme Co",
      email: "ap@acme.test",
    });
    vendor = await ok("POST", "/api/vendors", { name: "Office Depot" });
    tax = await ok("POST", "/api/taxes", { name: "HST", rate: "13" });
    assert.equal(tax.rate_bp, 1300);
    accounts = await ok("GET", "/api/accounts");
  });

  test("posts an invoice with tax to AR, income and tax payable", async () => {
    invoice = await ok("POST", "/api/invoices", {
      party_id: customer.id,
      issue_date: "2026-01-10",
      due_date: "2026-02-09",
      post: true,
      lines: [
        {
          description: "Consulting",
          quantity: 10,
          unit_price: "150",
          account_id: accountId(accounts, "4100"),
          tax_id: tax.id,
        },
        {
          description: "Discount",
          quantity: 1,
          unit_price: "-100",
          account_id: accountId(accounts, "4100"),
        },
      ],
    });
    assert.equal(invoice.number, "INV-1001");
    assert.equal(invoice.subtotal_cents, 140000);
    assert.equal(invoice.tax_cents, 19500);
    assert.equal(invoice.total_cents, 159500);
    assert.equal(invoice.display_status, "overdue");
    const tb = await ok("GET", "/api/reports/trial-balance?to=2026-12-31");
    assert.equal(tb.debit_total_cents, tb.credit_total_cents);
  });

  test("records a partial payment and rejects overpayment", async () => {
    const checking = accountId(accounts, "1010");
    invoice = await ok("POST", `/api/invoices/${invoice.id}/payments`, {
      date: "2026-01-20",
      amount: "500.00",
      account_id: checking,
    });
    assert.equal(invoice.balance_cents, 109500);
    assert.equal(invoice.display_status, "overdue");
    const over = await call("POST", `/api/invoices/${invoice.id}/payments`, {
      date: "2026-01-21",
      amount: "2000",
      account_id: checking,
    });
    assert.equal(over.status, 400);
  });

  test("posts a bill and pays it", async () => {
    bill = await ok("POST", "/api/bills", {
      party_id: vendor.id,
      number: "OD-77",
      issue_date: "2026-01-05",
      due_date: "2026-01-30",
      post: true,
      lines: [
        {
          description: "Paper",
          quantity: 2,
          unit_price: "25.50",
          account_id: accountId(accounts, "6300"),
        },
      ],
    });
    assert.equal(bill.total_cents, 5100);
    bill = await ok("POST", `/api/bills/${bill.id}/payments`, {
      date: "2026-01-06",
      amount: "51",
      account_id: accountId(accounts, "1000"),
    });
    assert.equal(bill.display_status, "paid");
  });

  test("imports CSV without duplicating, then categorizes and matches", async () => {
    const csv = [
      "Date,Description,Amount",
      '01/15/2026,"Coffee, Inc",-4.50',
      '01/15/2026,"Coffee, Inc",-4.50',
      "01/28/2026,Acme Co payment,1095.00",
    ].join("\n");
    const preview = await ok("POST", "/api/transactions/import/preview", {
      content: csv,
    });
    assert.deepEqual(preview.headers, ["Date", "Description", "Amount"]);
    assert.equal(preview.suggested.date_format, "MM/DD/YYYY");
    const checking = accountId(accounts, "1010");
    const mapping = {
      date: 0,
      description: 1,
      amount: 2,
      date_format: "MM/DD/YYYY",
    };
    const first = await ok("POST", "/api/transactions/import", {
      account_id: checking,
      content: csv,
      mapping,
    });
    assert.equal(first.imported, 3);
    const again = await ok("POST", "/api/transactions/import", {
      account_id: checking,
      content: csv,
      mapping,
    });
    assert.equal(again.imported, 0);
    assert.equal(again.duplicates, 3);

    const txns = await ok(
      "GET",
      `/api/transactions?account_id=${checking}&status=new`,
    );
    const coffee = txns.find((t) => t.amount_cents === -450);
    const deposit = txns.find((t) => t.amount_cents === 109500);
    await ok("POST", `/api/transactions/${coffee.id}/categorize`, {
      category_account_id: accountId(accounts, "6200"),
    });
    const matched = await ok("POST", `/api/transactions/${deposit.id}/match`, {
      kind: "invoice",
      document_id: invoice.id,
    });
    assert.equal(matched.status, "matched");
    invoice = await ok("GET", `/api/invoices/${invoice.id}`);
    assert.equal(invoice.display_status, "paid");

    // Undo the match: payment goes away, invoice is open again.
    await ok("POST", `/api/transactions/${deposit.id}/exclude`, {
      excluded: false,
    });
    invoice = await ok("GET", `/api/invoices/${invoice.id}`);
    assert.equal(invoice.balance_cents, 109500);
    await ok("POST", `/api/transactions/${deposit.id}/match`, {
      kind: "invoice",
      document_id: invoice.id,
    });
  });

  test("imports OFX", async () => {
    const ofx = `OFXHEADER:100
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260202120000<TRNAMT>-12.00<FITID>A1<NAME>Bank fee
</STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
    const checking = accountId(accounts, "1010");
    const result = await ok("POST", "/api/transactions/import", {
      account_id: checking,
      content: ofx,
    });
    assert.equal(result.imported, 1);
    const again = await ok("POST", "/api/transactions/import", {
      account_id: checking,
      content: ofx,
    });
    assert.equal(again.duplicates, 1);
  });

  test("reports agree with each other", async () => {
    const q = "from=2026-01-01&to=2026-12-31";
    const pl = await ok("GET", `/api/reports/profit-and-loss?${q}`);
    assert.equal(pl.income.total_cents, 140000);
    assert.equal(pl.expenses.total_cents, 5100 + 450);
    assert.equal(pl.net_income_cents, 140000 - 5550);

    const bs = await ok("GET", "/api/reports/balance-sheet?to=2026-12-31");
    assert.equal(bs.balanced, true);

    const cf = await ok("GET", `/api/reports/cash-flow?${q}`);
    assert.equal(
      cf.closing_cash_cents - cf.opening_cash_cents,
      cf.net_change_cents,
    );
    // 500 + 1095 received, 51 + 4.50 paid; the imported 12.00 fee is uncategorized.
    assert.equal(cf.net_change_cents, 50000 + 109500 - 5100 - 450);

    const ar = await ok("GET", "/api/reports/aged-receivables");
    assert.equal(ar.totals.total_cents, 0);
  });

  test("manual journal entries must balance", async () => {
    const bad = await call("POST", "/api/journal", {
      date: "2026-01-01",
      lines: [
        { account_id: accountId(accounts, "1010"), debit: "100" },
        { account_id: accountId(accounts, "3900"), credit: "99" },
      ],
    });
    assert.equal(bad.status, 400);
    const { id } = await ok("POST", "/api/journal", {
      date: "2026-01-01",
      memo: "Opening balance",
      lines: [
        { account_id: accountId(accounts, "1010"), debit: "100" },
        { account_id: accountId(accounts, "3900"), credit: "100" },
      ],
    });
    await ok("DELETE", `/api/journal/${id}`);
  });

  test("protects posted documents", async () => {
    assert.equal(
      (await call("DELETE", `/api/invoices/${invoice.id}`)).status,
      409,
    );
    assert.equal(
      (await call("POST", `/api/invoices/${invoice.id}/void`)).status,
      409,
    );
    assert.equal(
      (await call("DELETE", `/api/customers/${customer.id}`)).status,
      409,
    );
  });

  test("downloads a backup", async () => {
    const { status, data } = await call("GET", "/api/backup");
    assert.equal(status, 200);
    assert.equal(
      Buffer.from(data).subarray(0, 15).toString(),
      "SQLite format 3",
    );
  });
});
