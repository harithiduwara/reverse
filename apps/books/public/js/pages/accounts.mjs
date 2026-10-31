import {
  api,
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
import {
  accountOptions,
  accountTypeLabel,
  refreshReferenceData,
  state,
} from "../state.mjs";

const TYPES = ["asset", "liability", "equity", "income", "expense"];

function editAccount(existing) {
  return modal(existing ? "Edit account" : "New account", (close) =>
    h(
      "form",
      {
        class: "form",
        onsubmit: onSubmit(async (values) => {
          const body = {
            ...values,
            is_cash: values.is_cash === true,
            archived: values.archived === true,
          };
          if (existing) await api("PUT", `/api/accounts/${existing.id}`, body);
          else await api("POST", "/api/accounts", body);
          await refreshReferenceData();
          toast("Saved");
          close(true);
        }),
      },
      h(
        "div",
        { class: "grid-2" },
        field(
          "Code",
          input("code", existing?.code, {
            required: true,
            maxlength: 20,
            placeholder: "e.g. 6450",
          }),
        ),
        field(
          "Type",
          select(
            "type",
            TYPES.map((t) => ({ value: t, label: accountTypeLabel(t) })),
            existing?.type ?? "expense",
          ),
        ),
      ),
      field(
        "Name",
        input("name", existing?.name, { required: true, maxlength: 120 }),
      ),
      field(
        "Description",
        input("description", existing?.description, { maxlength: 500 }),
      ),
      h(
        "label",
        { class: "check" },
        h("input", {
          type: "checkbox",
          name: "is_cash",
          checked: Boolean(existing?.is_cash),
        }),
        " This is a bank, cash or credit card account (asset type; for credit cards use a negative balance)",
      ),
      existing
        ? h(
            "label",
            { class: "check" },
            h("input", {
              type: "checkbox",
              name: "archived",
              checked: Boolean(existing.archived),
            }),
            " Archived",
          )
        : null,
      h(
        "div",
        { class: "form-actions" },
        h(
          "button",
          { class: "btn", type: "button", onclick: () => close(false) },
          "Cancel",
        ),
        h("button", { class: "btn btn-primary", type: "submit" }, "Save"),
      ),
    ),
  );
}

export async function accountsPage() {
  await refreshReferenceData();
  return h(
    "div",
    null,
    pageHeader(
      "Chart of accounts",
      h(
        "button",
        {
          class: "btn btn-primary",
          type: "button",
          onclick: async () => {
            if (await editAccount()) reload();
          },
        },
        "Add account",
      ),
    ),
    TYPES.map((type) => {
      const accounts = state.accounts.filter((a) => a.type === type);
      return h(
        "section",
        { class: "card" },
        h("h2", null, accountTypeLabel(type)),
        table(
          [
            { label: "Code", render: (a) => a.code },
            {
              label: "Name",
              render: (a) => [
                a.name,
                a.is_cash ? h("span", { class: "tag" }, "bank/cash") : null,
                a.system_key ? h("span", { class: "tag" }, "built-in") : null,
                a.archived
                  ? h("span", { class: "muted" }, " (archived)")
                  : null,
              ],
            },
            {
              label: "Balance",
              align: "right",
              render: (a) => money(a.balance_cents),
            },
            {
              label: "",
              render: (a) =>
                h(
                  "button",
                  {
                    class: "btn btn-small",
                    type: "button",
                    onclick: async (e) => {
                      e.stopPropagation();
                      if (await editAccount(a)) reload();
                    },
                  },
                  "Edit",
                ),
            },
          ],
          accounts,
          { onRowClick: (a) => navigate(`/accounts/${a.id}`) },
        ),
      );
    }),
  );
}

function sourceLink(row) {
  if (row.source_type === "document" || row.source_type === "payment")
    return null;
  return row.source_type === "manual"
    ? h("a", { href: "#/journal" }, "journal")
    : null;
}

export async function ledgerPage(id, query) {
  const params = new URLSearchParams({
    from: query.from ?? `${today().slice(0, 4)}-01-01`,
    to: query.to ?? today(),
  });
  const data = await api(
    "GET",
    `/api/accounts/${encodeURIComponent(id)}/ledger?${params}`,
  );
  return h(
    "div",
    null,
    h("a", { class: "back", href: "#/accounts" }, "← Chart of accounts"),
    pageHeader(`${data.account.code} · ${data.account.name}`),
    dateRangeForm(`/accounts/${id}`, data.from, data.to),
    h(
      "p",
      null,
      `Opening balance ${money(data.opening_cents)} · Closing balance `,
      h("strong", null, money(data.closing_cents)),
    ),
    table(
      [
        { label: "Date", render: (r) => formatDate(r.date) },
        {
          label: "Description",
          render: (r) => [
            r.memo,
            r.line_memo ? ` – ${r.line_memo}` : "",
            " ",
            sourceLink(r),
          ],
        },
        {
          label: "Debit",
          align: "right",
          render: (r) => (r.debit_cents ? money(r.debit_cents) : ""),
        },
        {
          label: "Credit",
          align: "right",
          render: (r) => (r.credit_cents ? money(r.credit_cents) : ""),
        },
        {
          label: "Balance",
          align: "right",
          render: (r) => money(r.balance_cents),
        },
      ],
      data.rows,
      { empty: "No activity in this period." },
    ),
  );
}

export function dateRangeForm(path, from, to, { single = false } = {}) {
  return h(
    "form",
    {
      class: "toolbar",
      onsubmit: (event) => {
        event.preventDefault();
        const f = event.target.elements;
        const next = new URLSearchParams({ to: f.to.value });
        if (!single) next.set("from", f.from.value);
        navigate(`${path}?${next}`);
      },
    },
    single
      ? null
      : field("From", input("from", from, { type: "date", required: true })),
    field(
      single ? "As of" : "To",
      input("to", to, { type: "date", required: true }),
    ),
    h("button", { class: "btn", type: "submit" }, "Update"),
  );
}

function journalLineRow(line = {}) {
  return h(
    "tr",
    { class: "line" },
    h(
      "td",
      null,
      select(
        "account_id",
        accountOptions(() => true, { blank: "Choose account…" }),
        line.account_id ?? "",
        { "aria-label": "Account" },
      ),
    ),
    h(
      "td",
      null,
      input("memo", line.memo ?? "", {
        maxlength: 300,
        "aria-label": "Line memo",
      }),
    ),
    h(
      "td",
      null,
      input("debit", line.debit_cents ? plainAmount(line.debit_cents) : "", {
        inputmode: "decimal",
        class: "narrow",
        "aria-label": "Debit",
      }),
    ),
    h(
      "td",
      null,
      input("credit", line.credit_cents ? plainAmount(line.credit_cents) : "", {
        inputmode: "decimal",
        class: "narrow",
        "aria-label": "Credit",
      }),
    ),
    h(
      "td",
      null,
      h(
        "button",
        {
          class: "icon-btn",
          type: "button",
          "aria-label": "Remove line",
          onclick: (e) => e.target.closest("tr").remove(),
        },
        "×",
      ),
    ),
  );
}

function editJournalEntry(existing) {
  return modal(
    existing ? "Edit journal entry" : "New journal entry",
    (close) => {
      const body = h("tbody");
      const status = h("p", { class: "hint" });
      const lines = existing?.lines ?? [{}, {}];
      lines.forEach((l) => body.append(journalLineRow(l)));
      const toCents = (v) =>
        Math.round(Number(String(v).replace(/[,$\s]/g, "")) * 100) || 0;
      const update = () => {
        let debit = 0;
        let credit = 0;
        for (const row of body.children) {
          debit += toCents(row.querySelector('[name="debit"]').value);
          credit += toCents(row.querySelector('[name="credit"]').value);
        }
        status.textContent = `Debits ${money(debit)} · Credits ${money(credit)}${debit === credit ? " ✓ balanced" : ` · off by ${money(debit - credit)}`}`;
      };
      body.addEventListener("input", update);
      update();
      return h(
        "form",
        {
          class: "form",
          onsubmit: onSubmit(async (values) => {
            const payload = {
              date: values.date,
              memo: values.memo,
              lines: [...body.children]
                .map((row) => ({
                  account_id: row.querySelector('[name="account_id"]').value,
                  memo: row.querySelector('[name="memo"]').value,
                  debit: row.querySelector('[name="debit"]').value,
                  credit: row.querySelector('[name="credit"]').value,
                }))
                .filter((l) => l.account_id || l.debit || l.credit),
            };
            if (existing)
              await api("PUT", `/api/journal/${existing.id}`, payload);
            else await api("POST", "/api/journal", payload);
            toast("Journal entry saved");
            close(true);
          }),
        },
        h(
          "div",
          { class: "grid-2" },
          field(
            "Date",
            input("date", existing?.date ?? today(), {
              type: "date",
              required: true,
            }),
          ),
          field(
            "Description",
            input("memo", existing?.memo ?? "", {
              maxlength: 500,
              placeholder: "e.g. Opening balances",
            }),
          ),
        ),
        h(
          "table",
          { class: "table lines" },
          h(
            "thead",
            null,
            h(
              "tr",
              null,
              h("th", null, "Account"),
              h("th", null, "Memo"),
              h("th", null, "Debit"),
              h("th", null, "Credit"),
              h("th"),
            ),
          ),
          body,
        ),
        h(
          "button",
          {
            class: "btn btn-small",
            type: "button",
            onclick: () => body.append(journalLineRow()),
          },
          "+ Add a line",
        ),
        status,
        h(
          "div",
          { class: "form-actions" },
          h(
            "button",
            { class: "btn", type: "button", onclick: () => close(false) },
            "Cancel",
          ),
          h("button", { class: "btn btn-primary", type: "submit" }, "Save"),
        ),
      );
    },
    { wide: true },
  );
}

export async function journalPage() {
  const entries = await api("GET", "/api/journal");
  return h(
    "div",
    null,
    pageHeader(
      "Journal entries",
      h(
        "button",
        {
          class: "btn btn-primary",
          type: "button",
          onclick: async () => {
            if (await editJournalEntry()) reload();
          },
        },
        "New journal entry",
      ),
    ),
    h(
      "p",
      { class: "muted" },
      "Use journal entries for opening balances, owner investments, loans, depreciation and other adjustments. Invoices, bills, payments and bank transactions create their entries automatically.",
    ),
    entries.length === 0
      ? h("p", { class: "empty" }, "No manual journal entries yet.")
      : entries.map((entry) =>
          h(
            "section",
            { class: "card journal-entry" },
            h(
              "div",
              { class: "journal-head" },
              h("strong", null, formatDate(entry.date)),
              h("span", null, entry.memo),
              h("span", { class: "spacer" }),
              h(
                "button",
                {
                  class: "btn btn-small",
                  type: "button",
                  onclick: async () => {
                    if (await editJournalEntry(entry)) reload();
                  },
                },
                "Edit",
              ),
              h(
                "button",
                {
                  class: "btn btn-small btn-danger-outline",
                  type: "button",
                  onclick: async () => {
                    if (
                      !(await confirmDialog(
                        "Delete this journal entry?",
                        "Delete",
                        true,
                      ))
                    )
                      return;
                    await api("DELETE", `/api/journal/${entry.id}`);
                    toast("Deleted");
                    reload();
                  },
                },
                "Delete",
              ),
            ),
            table(
              [
                {
                  label: "Account",
                  render: (l) => `${l.account_code} · ${l.account_name}`,
                },
                { label: "Memo", render: (l) => l.memo },
                {
                  label: "Debit",
                  align: "right",
                  render: (l) => (l.debit_cents ? money(l.debit_cents) : ""),
                },
                {
                  label: "Credit",
                  align: "right",
                  render: (l) => (l.credit_cents ? money(l.credit_cents) : ""),
                },
              ],
              entry.lines,
            ),
          ),
        ),
  );
}
