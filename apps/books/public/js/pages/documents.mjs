import {
  api,
  badge,
  confirmDialog,
  field,
  formatDate,
  h,
  input,
  modal,
  money,
  onSubmit,
  pageHeader,
  plainAmount,
  select,
  table,
  today,
  toast,
} from "../lib.mjs";
import { navigate, reload } from "../nav.mjs";
import { cashAccounts } from "../state.mjs";
import { KINDS } from "./documentKinds.mjs";
import { mailtoLink, paper } from "./documentPaper.mjs";

const FILTERS = [
  ["", "All"],
  ["draft", "Draft"],
  ["unpaid", "Unpaid"],
  ["partial", "Partial"],
  ["overdue", "Overdue"],
  ["paid", "Paid"],
  ["void", "Void"],
];

export async function documentListPage(kind, query) {
  const k = KINDS[kind];
  const status = query.status ?? "";
  const docs = await api(
    "GET",
    `${k.api}${status ? `?status=${encodeURIComponent(status)}` : ""}`,
  );
  const open = docs.filter((d) => d.balance_cents > 0);
  const overdue = docs.filter((d) => d.display_status === "overdue");
  return h(
    "div",
    null,
    pageHeader(
      k.title,
      h(
        "a",
        { class: "btn btn-primary", href: `#${k.page}/new` },
        `New ${k.one.toLowerCase()}`,
      ),
    ),
    status === ""
      ? h(
          "div",
          { class: "stats stats-small" },
          h(
            "div",
            { class: "card stat" },
            h("div", { class: "stat-label" }, "Outstanding"),
            h(
              "div",
              { class: "stat-value" },
              money(open.reduce((s, d) => s + d.balance_cents, 0)),
            ),
          ),
          h(
            "div",
            { class: "card stat" },
            h("div", { class: "stat-label" }, "Overdue"),
            h(
              "div",
              { class: "stat-value" },
              money(overdue.reduce((s, d) => s + d.balance_cents, 0)),
            ),
          ),
        )
      : null,
    h(
      "div",
      { class: "tabs" },
      FILTERS.map(([value, label]) =>
        h(
          "a",
          {
            href: `#${k.page}${value ? `?status=${value}` : ""}`,
            class: value === status ? "active" : null,
          },
          label,
        ),
      ),
    ),
    table(
      [
        { label: "Status", render: (d) => badge(d.display_status) },
        { label: "Date", render: (d) => formatDate(d.issue_date) },
        { label: "Number", render: (d) => d.number || "—" },
        { label: k.partyLabel, render: (d) => d.party_name },
        { label: "Due", render: (d) => formatDate(d.due_date) },
        { label: "Total", align: "right", render: (d) => money(d.total_cents) },
        {
          label: "Balance due",
          align: "right",
          render: (d) => money(d.balance_cents),
        },
      ],
      docs,
      {
        onRowClick: (d) => navigate(`${k.page}/${d.id}`),
        empty: `No ${k.title.toLowerCase()} here.`,
      },
    ),
  );
}

function recordPayment(kind, doc) {
  const k = KINDS[kind];
  const accounts = cashAccounts();
  return modal("Record a payment", (close) =>
    h(
      "form",
      {
        class: "form",
        onsubmit: onSubmit(async (values) => {
          await api("POST", `${k.api}/${doc.id}/payments`, values);
          toast("Payment recorded");
          close(true);
        }),
      },
      h(
        "div",
        { class: "grid-2" },
        field("Date", input("date", today(), { type: "date", required: true })),
        field(
          "Amount",
          input("amount", plainAmount(doc.balance_cents), {
            inputmode: "decimal",
            required: true,
          }),
        ),
      ),
      field(
        kind === "invoice" ? "Deposited to" : "Paid from",
        select(
          "account_id",
          accounts.map((a) => ({ value: a.id, label: a.name })),
          accounts[1]?.id ?? accounts[0]?.id,
        ),
      ),
      field(
        "Method",
        select(
          "method",
          ["Bank transfer", "Cash", "Cheque", "Credit card", "Other"].map(
            (m) => ({ value: m, label: m }),
          ),
          "Bank transfer",
        ),
      ),
      h(
        "p",
        { class: "hint" },
        "If this payment will also show up in a bank import, match the imported transaction instead to avoid counting it twice.",
      ),
      h(
        "div",
        { class: "form-actions" },
        h(
          "button",
          { class: "btn", type: "button", onclick: () => close(false) },
          "Cancel",
        ),
        h(
          "button",
          { class: "btn btn-primary", type: "submit" },
          "Record payment",
        ),
      ),
    ),
  );
}

async function act(fn, message) {
  try {
    await fn();
    if (message) toast(message);
    reload();
  } catch (error) {
    toast(error.message, "error");
  }
}

export async function documentViewPage(kind, id) {
  const k = KINDS[kind];
  const doc = await api("GET", `${k.api}/${id}`);
  const actions = [];
  if (doc.status !== "void")
    actions.push(
      h("a", { class: "btn", href: `#${k.page}/${doc.id}/edit` }, "Edit"),
    );
  if (doc.status === "draft") {
    actions.push(
      h(
        "button",
        {
          class: "btn btn-primary",
          type: "button",
          onclick: () =>
            act(() => api("POST", `${k.api}/${doc.id}/post`, {}), "Approved"),
        },
        k.postLabel,
      ),
    );
  }
  if (doc.status === "posted" && doc.balance_cents > 0) {
    actions.push(
      h(
        "button",
        {
          class: "btn btn-primary",
          type: "button",
          onclick: async () => {
            if (await recordPayment(kind, doc)) reload();
          },
        },
        "Record payment",
      ),
    );
  }
  actions.push(
    h(
      "button",
      { class: "btn", type: "button", onclick: () => window.print() },
      "Print / PDF",
    ),
  );
  if (kind === "invoice" && doc.party_email && doc.status === "posted") {
    actions.push(h("a", { class: "btn", href: mailtoLink(doc) }, "Email"));
  }
  if (doc.status === "posted") {
    actions.push(
      h(
        "button",
        {
          class: "btn btn-danger-outline",
          type: "button",
          onclick: async () => {
            if (
              await confirmDialog(
                `Void ${k.one.toLowerCase()} ${doc.number}? Its accounting entries will be removed.`,
                "Void",
                true,
              )
            ) {
              act(() => api("POST", `${k.api}/${doc.id}/void`, {}), "Voided");
            }
          },
        },
        "Void",
      ),
    );
  } else {
    actions.push(
      h(
        "button",
        {
          class: "btn btn-danger-outline",
          type: "button",
          onclick: async () => {
            if (
              !(await confirmDialog(
                `Delete this ${k.one.toLowerCase()}?`,
                "Delete",
                true,
              ))
            )
              return;
            try {
              await api("DELETE", `${k.api}/${doc.id}`);
              toast("Deleted");
              navigate(k.page);
            } catch (error) {
              toast(error.message, "error");
            }
          },
        },
        "Delete",
      ),
    );
  }
  return h(
    "div",
    null,
    h(
      "div",
      { class: "no-print" },
      h("a", { class: "back", href: `#${k.page}` }, `← ${k.title}`),
      pageHeader(`${k.one} ${doc.number}`.trim(), ...actions),
      h(
        "div",
        { class: "status-line" },
        badge(doc.display_status),
        h(
          "span",
          null,
          `${k.partyLabel}: `,
          h(
            "a",
            {
              href: `#/${k.partyKind === "customer" ? "customers" : "vendors"}/${doc.party_id}`,
            },
            doc.party_name,
          ),
        ),
        h("span", null, `Total ${money(doc.total_cents)}`),
        doc.status === "posted"
          ? h("span", null, `Due ${money(doc.balance_cents)}`)
          : null,
      ),
    ),
    paper(kind, doc),
    doc.payments.length
      ? h(
          "section",
          { class: "card no-print" },
          h("h2", null, "Payments"),
          table(
            [
              { label: "Date", render: (p) => formatDate(p.date) },
              { label: "Account", render: (p) => p.account_name },
              {
                label: "Method",
                render: (p) =>
                  p.method || (p.bank_transaction_id ? "Bank match" : ""),
              },
              {
                label: "Amount",
                align: "right",
                render: (p) => money(p.amount_cents),
              },
              {
                label: "",
                render: (p) =>
                  h(
                    "button",
                    {
                      class: "btn btn-small",
                      type: "button",
                      onclick: async (event) => {
                        event.stopPropagation();
                        if (
                          await confirmDialog(
                            "Remove this payment?",
                            "Remove",
                            true,
                          )
                        ) {
                          act(
                            () =>
                              api(
                                "DELETE",
                                `${k.api}/${doc.id}/payments/${p.id}`,
                              ),
                            "Payment removed",
                          );
                        }
                      },
                    },
                    "Remove",
                  ),
              },
            ],
            doc.payments,
          ),
        )
      : null,
  );
}
