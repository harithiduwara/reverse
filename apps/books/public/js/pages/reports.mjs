import {
  api,
  downloadCsv,
  formatDate,
  h,
  money,
  pageHeader,
  plainAmount,
  today,
} from "../lib.mjs";
import { dateRangeForm } from "./accounts.mjs";

const REPORTS = {
  "profit-and-loss": {
    title: "Profit & Loss",
    text: "Income minus expenses for a period: are you making money?",
  },
  "balance-sheet": {
    title: "Balance Sheet",
    text: "What you own, what you owe, and your equity on a date.",
    single: true,
  },
  "cash-flow": {
    title: "Cash Flow",
    text: "Where cash came from and where it went.",
  },
  "aged-receivables": {
    title: "Aged Receivables",
    text: "Unpaid invoices by how overdue they are.",
    noDates: true,
  },
  "aged-payables": {
    title: "Aged Payables",
    text: "Unpaid bills by how overdue they are.",
    noDates: true,
  },
  "trial-balance": {
    title: "Trial Balance",
    text: "Debit and credit totals for every account.",
    single: true,
  },
};

export function reportsIndexPage() {
  return h(
    "div",
    null,
    pageHeader("Reports"),
    h(
      "div",
      { class: "report-grid" },
      Object.entries(REPORTS).map(([name, r]) =>
        h(
          "a",
          { class: "card report-card", href: `#/reports/${name}` },
          h("h2", null, r.title),
          h("p", { class: "muted" }, r.text),
        ),
      ),
    ),
  );
}

/** A report is a list of rows: [label, amount, style]. */
function rowsTable(rows) {
  return h(
    "table",
    { class: "table report" },
    h(
      "tbody",
      null,
      rows.map(([label, cents, style, href]) =>
        h(
          "tr",
          { class: style ?? null },
          h("td", null, href ? h("a", { href }, label) : label),
          h("td", { class: "num" }, cents === null ? "" : money(cents)),
        ),
      ),
    ),
  );
}

const accountRows = (accounts) =>
  accounts.map((a) => [
    `${a.code ? `${a.code} · ` : ""}${a.name}`,
    a.balance_cents,
    "indent",
    a.id ? `#/accounts/${a.id}` : null,
  ]);

function profitAndLossRows(d) {
  return [
    ["Income", null, "heading"],
    ...accountRows(d.income.accounts),
    ["Total income", d.income.total_cents, "subtotal"],
    ["Expenses", null, "heading"],
    ...accountRows(d.expenses.accounts),
    ["Total expenses", d.expenses.total_cents, "subtotal"],
    ["Net income", d.net_income_cents, "total"],
  ];
}

function balanceSheetRows(d) {
  return [
    ["Assets", null, "heading"],
    ...accountRows(d.assets.accounts),
    ["Total assets", d.assets.total_cents, "total"],
    ["Liabilities", null, "heading"],
    ...accountRows(d.liabilities.accounts),
    ["Total liabilities", d.liabilities.total_cents, "subtotal"],
    ["Equity", null, "heading"],
    ...accountRows(d.equity.accounts),
    ["Total equity", d.equity.total_cents, "subtotal"],
    ["Total liabilities & equity", d.liabilities_and_equity_cents, "total"],
  ];
}

function cashFlowRows(d) {
  const section = (title, s) => [
    [title, null, "heading"],
    ...s.items.map((i) => [
      i.name,
      i.amount_cents,
      "indent",
      `#/accounts/${i.id}`,
    ]),
    [`Net cash from ${title.toLowerCase()}`, s.total_cents, "subtotal"],
  ];
  return [
    ["Cash at start", d.opening_cash_cents, "subtotal"],
    ...section("Operating activities", d.operating),
    ...section("Investing activities", d.investing),
    ...section("Financing activities", d.financing),
    ["Net change in cash", d.net_change_cents, "subtotal"],
    ["Cash at end", d.closing_cash_cents, "total"],
  ];
}

function agingView(d, kind) {
  const labels = {
    current: "Not yet due",
    "1-30": "1–30 days",
    "31-60": "31–60 days",
    "61-90": "61–90 days",
    "90+": "Over 90 days",
  };
  const path = kind === "invoice" ? "customers" : "vendors";
  const csv = [
    ["Name", ...d.buckets.map((b) => labels[b]), "Total"],
    ...d.rows.map((r) => [
      r.name,
      ...d.buckets.map((b) => plainAmount(r[b])),
      plainAmount(r.total_cents),
    ]),
    [
      "Total",
      ...d.buckets.map((b) => plainAmount(d.totals[b])),
      plainAmount(d.totals.total_cents),
    ],
  ];
  const view =
    d.rows.length === 0
      ? h("p", { class: "empty" }, "Nothing outstanding.")
      : h(
          "div",
          { class: "table-wrap" },
          h(
            "table",
            { class: "table" },
            h(
              "thead",
              null,
              h(
                "tr",
                null,
                h("th", null, kind === "invoice" ? "Customer" : "Vendor"),
                d.buckets.map((b) => h("th", { class: "num" }, labels[b])),
                h("th", { class: "num" }, "Total"),
              ),
            ),
            h(
              "tbody",
              null,
              d.rows.map((r) =>
                h(
                  "tr",
                  null,
                  h(
                    "td",
                    null,
                    h("a", { href: `#/${path}/${r.party_id}` }, r.name),
                  ),
                  d.buckets.map((b) =>
                    h("td", { class: "num" }, r[b] ? money(r[b]) : ""),
                  ),
                  h("td", { class: "num" }, money(r.total_cents)),
                ),
              ),
            ),
            h(
              "tfoot",
              null,
              h(
                "tr",
                null,
                h("td", null, "Total"),
                d.buckets.map((b) =>
                  h("td", { class: "num" }, money(d.totals[b])),
                ),
                h("td", { class: "num" }, money(d.totals.total_cents)),
              ),
            ),
          ),
        );
  return { view, csv, subtitle: `As of ${formatDate(d.as_of)}` };
}

function trialBalanceView(d) {
  const csv = [
    ["Code", "Account", "Debit", "Credit"],
    ...d.rows.map((r) => [
      r.code,
      r.name,
      plainAmount(r.debit_cents),
      plainAmount(r.credit_cents),
    ]),
    [
      "",
      "Total",
      plainAmount(d.debit_total_cents),
      plainAmount(d.credit_total_cents),
    ],
  ];
  const view = h(
    "table",
    { class: "table report" },
    h(
      "thead",
      null,
      h(
        "tr",
        null,
        h("th", null, "Account"),
        h("th", { class: "num" }, "Debit"),
        h("th", { class: "num" }, "Credit"),
      ),
    ),
    h(
      "tbody",
      null,
      d.rows.map((r) =>
        h(
          "tr",
          null,
          h(
            "td",
            null,
            h("a", { href: `#/accounts/${r.id}` }, `${r.code} · ${r.name}`),
          ),
          h("td", { class: "num" }, r.debit_cents ? money(r.debit_cents) : ""),
          h(
            "td",
            { class: "num" },
            r.credit_cents ? money(r.credit_cents) : "",
          ),
        ),
      ),
    ),
    h(
      "tfoot",
      null,
      h(
        "tr",
        { class: "total" },
        h("td", null, "Total"),
        h("td", { class: "num" }, money(d.debit_total_cents)),
        h("td", { class: "num" }, money(d.credit_total_cents)),
      ),
    ),
  );
  return { view, csv, subtitle: `As of ${formatDate(d.to)}` };
}

function fromRows(rows, subtitle) {
  return {
    view: rowsTable(rows),
    csv: rows.map(([label, cents]) => [
      label,
      cents === null ? "" : plainAmount(cents),
    ]),
    subtitle,
  };
}

export async function reportPage(name, query) {
  const meta = REPORTS[name];
  if (!meta) throw new Error("Unknown report");
  const to = query.to ?? today();
  const from = query.from ?? `${to.slice(0, 4)}-01-01`;
  const params = new URLSearchParams(meta.single ? { to } : { from, to });
  const d = await api(
    "GET",
    `/api/reports/${name}${meta.noDates ? "" : `?${params}`}`,
  );
  const period = `${formatDate(d.from)} – ${formatDate(d.to)}`;
  const built = {
    "profit-and-loss": () => fromRows(profitAndLossRows(d), period),
    "balance-sheet": () =>
      fromRows(balanceSheetRows(d), `As of ${formatDate(d.to)}`),
    "cash-flow": () => fromRows(cashFlowRows(d), period),
    "aged-receivables": () => agingView(d, "invoice"),
    "aged-payables": () => agingView(d, "bill"),
    "trial-balance": () => trialBalanceView(d),
  }[name]();
  return h(
    "div",
    null,
    h("a", { class: "back no-print", href: "#/reports" }, "← Reports"),
    pageHeader(
      meta.title,
      h(
        "button",
        {
          class: "btn",
          type: "button",
          onclick: () => downloadCsv(`${name}-${to}.csv`, built.csv),
        },
        "Export CSV",
      ),
      h(
        "button",
        { class: "btn", type: "button", onclick: () => window.print() },
        "Print / PDF",
      ),
    ),
    meta.noDates
      ? null
      : h(
          "div",
          { class: "no-print" },
          dateRangeForm(`/reports/${name}`, from, to, { single: meta.single }),
        ),
    h(
      "section",
      { class: "card report-body" },
      h("p", { class: "muted" }, built.subtitle),
      name === "balance-sheet" && !d.balanced
        ? h(
            "p",
            { class: "error-box" },
            "Assets do not equal liabilities plus equity. Please report this as a bug.",
          )
        : null,
      built.view,
    ),
  );
}
