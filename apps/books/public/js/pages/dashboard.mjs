import { api, h, money, pageHeader } from "../lib.mjs";

const SVG = "http://www.w3.org/2000/svg";

function svg(tag, attrs, ...children) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  el.append(...children);
  return el;
}

/** Grouped bars: income vs expenses for the last 12 months. */
function monthlyChart(months) {
  const width = 720;
  const height = 220;
  const pad = { top: 12, bottom: 28, left: 8, right: 8 };
  const max = Math.max(
    1,
    ...months.flatMap((m) => [m.income_cents, m.expense_cents]),
  );
  const slot = (width - pad.left - pad.right) / months.length;
  const barW = Math.max(4, slot / 2 - 4);
  const plotH = height - pad.top - pad.bottom;
  const bars = months.flatMap((m, i) => {
    const x = pad.left + i * slot + 2;
    const label = new Date(`${m.month}-01T00:00:00`).toLocaleDateString(
      undefined,
      { month: "short" },
    );
    const bar = (value, offset, cls, name) => {
      const barH = (Math.max(0, value) / max) * plotH;
      return svg(
        "rect",
        {
          x: x + offset,
          y: pad.top + plotH - barH,
          width: barW,
          height: Math.max(barH, 1),
          rx: 2,
          class: cls,
        },
        svg("title", {}, `${label} ${name}: ${money(value)}`),
      );
    };
    return [
      bar(m.income_cents, 0, "bar-income", "income"),
      bar(m.expense_cents, barW + 2, "bar-expense", "expenses"),
      svg(
        "text",
        {
          x: x + barW,
          y: height - 8,
          "text-anchor": "middle",
          class: "chart-label",
        },
        label,
      ),
    ];
  });
  return h(
    "div",
    { class: "chart" },
    svg(
      "svg",
      {
        viewBox: `0 0 ${width} ${height}`,
        role: "img",
        "aria-label": "Income and expenses by month",
      },
      svg("line", {
        x1: pad.left,
        x2: width - pad.right,
        y1: pad.top + plotH,
        y2: pad.top + plotH,
        class: "chart-axis",
      }),
      ...bars,
    ),
    h(
      "div",
      { class: "legend" },
      h("span", { class: "legend-income" }, "Income"),
      h("span", { class: "legend-expense" }, "Expenses"),
    ),
  );
}

function stat(label, value, sub, href) {
  const body = [
    h("div", { class: "stat-label" }, label),
    h("div", { class: "stat-value" }, value),
    sub ? h("div", { class: "stat-sub" }, sub) : null,
  ];
  return href
    ? h("a", { class: "card stat", href }, body)
    : h("div", { class: "card stat" }, body);
}

export async function dashboardPage() {
  const d = await api("GET", "/api/dashboard");
  const totalCash = d.cash_accounts.reduce((s, a) => s + a.balance_cents, 0);
  const ytd = d.year_to_date;
  return h(
    "div",
    null,
    pageHeader(
      "Dashboard",
      h(
        "a",
        { class: "btn btn-primary", href: "#/invoices/new" },
        "New invoice",
      ),
      h("a", { class: "btn", href: "#/bills/new" }, "New bill"),
      h(
        "a",
        { class: "btn", href: "#/transactions/import" },
        "Import bank file",
      ),
    ),
    d.uncategorized_count > 0
      ? h(
          "a",
          { class: "notice", href: "#/transactions?status=new" },
          `${d.uncategorized_count} bank transaction(s) need review →`,
        )
      : null,
    h(
      "div",
      { class: "stats" },
      stat(
        "Cash",
        money(totalCash),
        d.cash_accounts
          .map((a) => `${a.name}: ${money(a.balance_cents)}`)
          .join(" · "),
        "#/accounts",
      ),
      stat(
        "Owed to you",
        money(d.receivable_cents),
        d.overdue_receivable_cents
          ? `${money(d.overdue_receivable_cents)} overdue`
          : "Nothing overdue",
        "#/reports/aged-receivables",
      ),
      stat(
        "You owe",
        money(d.payable_cents),
        d.overdue_payable_cents
          ? `${money(d.overdue_payable_cents)} overdue`
          : "Nothing overdue",
        "#/reports/aged-payables",
      ),
      stat(
        "Net income (this year)",
        money(ytd.net_income_cents),
        `${money(ytd.income.total_cents)} income · ${money(ytd.expenses.total_cents)} expenses`,
        "#/reports/profit-and-loss",
      ),
    ),
    h(
      "section",
      { class: "card" },
      h("h2", null, "Last 12 months"),
      monthlyChart(d.months),
    ),
  );
}
