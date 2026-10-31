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
  readFileAsBase64,
  select,
  today,
  toast,
} from "../lib.mjs";
import { navigate, reload } from "../nav.mjs";
import { accountOptions, cashAccounts } from "../state.mjs";

const STATUSES = [
  ["", "All"],
  ["new", "To review"],
  ["categorized", "Categorized"],
  ["matched", "Matched"],
  ["excluded", "Excluded"],
];

const categoryFilter = (bankId) => (a) =>
  a.id !== bankId && a.system_key !== "ar" && a.system_key !== "ap";

function categorySelect(txn) {
  const sel = select(
    "category",
    accountOptions(categoryFilter(txn.account_id), {
      blank: "Choose category…",
    }),
    txn.category_account_id ?? "",
    { class: "category-select", "aria-label": "Category" },
  );
  sel.addEventListener("click", (e) => e.stopPropagation());
  sel.addEventListener("change", async () => {
    if (!sel.value) return;
    try {
      await api("POST", `/api/transactions/${txn.id}/categorize`, {
        category_account_id: sel.value,
      });
      toast("Categorized");
      reload();
    } catch (error) {
      toast(error.message, "error");
    }
  });
  return sel;
}

async function matchDialog(txn) {
  const kind = txn.amount_cents > 0 ? "invoice" : "bill";
  const docs = (await api("GET", `/api/${kind}s`)).filter(
    (d) => d.status === "posted" && d.balance_cents > 0,
  );
  const amount = Math.abs(txn.amount_cents);
  docs.sort(
    (a, b) =>
      Number(b.balance_cents === amount) - Number(a.balance_cents === amount),
  );
  return modal(
    `Match to ${kind === "invoice" ? "an invoice" : "a bill"}`,
    (close) => [
      h(
        "p",
        null,
        `${formatDate(txn.date)} · ${txn.description} · ${money(txn.amount_cents)}`,
      ),
      docs.length === 0
        ? h("p", { class: "empty" }, `No open ${kind}s to match.`)
        : h(
            "div",
            { class: "match-list" },
            docs.map((d) =>
              h(
                "button",
                {
                  class: `match-item${d.balance_cents === amount ? " exact" : ""}`,
                  type: "button",
                  disabled: d.balance_cents < amount,
                  onclick: async () => {
                    try {
                      await api("POST", `/api/transactions/${txn.id}/match`, {
                        kind,
                        document_id: d.id,
                      });
                      toast("Matched");
                      close(true);
                    } catch (error) {
                      toast(error.message, "error");
                    }
                  },
                },
                h(
                  "span",
                  null,
                  h("strong", null, d.number || "(no number)"),
                  ` · ${d.party_name}`,
                ),
                h(
                  "span",
                  null,
                  `Due ${money(d.balance_cents)}`,
                  d.balance_cents === amount ? " ✓" : "",
                ),
              ),
            ),
          ),
      docs.some((d) => d.balance_cents < amount)
        ? h(
            "p",
            { class: "hint" },
            "Documents with a smaller balance than this transaction can’t be matched.",
          )
        : null,
    ],
  );
}

async function detailDialog(txn) {
  const attachments = await api(
    "GET",
    `/api/transactions/${txn.id}/attachments`,
  );
  return modal("Transaction", (close) => {
    const fileInput = h("input", {
      type: "file",
      accept: "image/*,application/pdf",
    });
    fileInput.addEventListener("change", async () => {
      const file = fileInput.files[0];
      if (!file) return;
      try {
        await api("POST", `/api/transactions/${txn.id}/attachments`, {
          filename: file.name,
          mime: file.type,
          data_base64: await readFileAsBase64(file),
        });
        toast("Receipt attached");
        close(true);
      } catch (error) {
        toast(error.message, "error");
      }
    });
    return h(
      "form",
      {
        class: "form",
        onsubmit: onSubmit(async (values) => {
          await api("PUT", `/api/transactions/${txn.id}/notes`, values);
          toast("Saved");
          close(true);
        }),
      },
      h(
        "dl",
        { class: "details" },
        h("dt", null, "Date"),
        h("dd", null, formatDate(txn.date)),
        h("dt", null, "Description"),
        h("dd", null, txn.description),
        h("dt", null, "Account"),
        h("dd", null, txn.account_name),
        h("dt", null, "Amount"),
        h("dd", null, money(txn.amount_cents)),
        h("dt", null, "Status"),
        h("dd", null, badge(txn.status)),
        h("dt", null, "Source"),
        h(
          "dd",
          null,
          txn.source === "import" ? "Bank import" : "Added manually",
        ),
      ),
      field(
        "Notes",
        h("textarea", { name: "notes", rows: 3, maxlength: 2000 }, txn.notes),
      ),
      h(
        "div",
        { class: "field" },
        h("span", { class: "field-label" }, "Receipts"),
        attachments.length
          ? h(
              "ul",
              { class: "attachments" },
              attachments.map((a) =>
                h(
                  "li",
                  null,
                  h(
                    "a",
                    {
                      href: `/api/attachments/${a.id}`,
                      target: "_blank",
                      rel: "noopener",
                    },
                    a.filename,
                  ),
                  ` (${Math.ceil(a.size / 1024)} KB) `,
                  h(
                    "button",
                    {
                      class: "btn btn-small",
                      type: "button",
                      onclick: async () => {
                        await api("DELETE", `/api/attachments/${a.id}`);
                        close(true);
                      },
                    },
                    "Remove",
                  ),
                ),
              ),
            )
          : h("p", { class: "muted" }, "No receipts yet."),
        fileInput,
      ),
      h(
        "div",
        { class: "form-actions" },
        h(
          "button",
          {
            class: "btn btn-danger-outline",
            type: "button",
            onclick: async () => {
              if (
                !(await confirmDialog(
                  "Delete this transaction and anything it posted?",
                  "Delete",
                  true,
                ))
              )
                return;
              await api("DELETE", `/api/transactions/${txn.id}`);
              toast("Deleted");
              close(true);
            },
          },
          "Delete",
        ),
        h("span", { class: "spacer" }),
        h(
          "button",
          { class: "btn", type: "button", onclick: () => close(false) },
          "Close",
        ),
        h("button", { class: "btn btn-primary", type: "submit" }, "Save notes"),
      ),
    );
  });
}

function addTransactionDialog() {
  const accounts = cashAccounts();
  return modal("Add a transaction", (close) => {
    const accountSel = select(
      "account_id",
      accounts.map((a) => ({ value: a.id, label: a.name })),
      accounts[0]?.id,
    );
    return h(
      "form",
      {
        class: "form",
        onsubmit: onSubmit(async (values) => {
          await api("POST", "/api/transactions", values);
          toast("Transaction added");
          close(true);
        }),
      },
      h(
        "div",
        { class: "grid-2" },
        field(
          "Type",
          select(
            "direction",
            [
              { value: "withdrawal", label: "Expense / money out" },
              { value: "deposit", label: "Income / money in" },
            ],
            "withdrawal",
          ),
        ),
        field("Date", input("date", today(), { type: "date", required: true })),
      ),
      field(
        "Description",
        input("description", "", {
          required: true,
          maxlength: 300,
          placeholder: "e.g. Staples – printer paper",
        }),
      ),
      h(
        "div",
        { class: "grid-2" },
        field(
          "Amount",
          input("amount", "", {
            inputmode: "decimal",
            required: true,
            placeholder: "0.00",
          }),
        ),
        field("Paid from / deposited to", accountSel),
      ),
      field(
        "Category",
        select(
          "category_account_id",
          accountOptions(
            (a) => !a.is_cash && a.system_key !== "ar" && a.system_key !== "ap",
            { blank: "Leave uncategorized" },
          ),
          "",
        ),
      ),
      field(
        "Notes",
        h("textarea", { name: "notes", rows: 2, maxlength: 2000 }),
      ),
      h(
        "p",
        { class: "hint" },
        "You can attach a receipt after saving by clicking the transaction.",
      ),
      h(
        "div",
        { class: "form-actions" },
        h(
          "button",
          { class: "btn", type: "button", onclick: () => close(false) },
          "Cancel",
        ),
        h("button", { class: "btn btn-primary", type: "submit" }, "Add"),
      ),
    );
  });
}

function rowActions(txn) {
  const stop = (fn) => async (event) => {
    event.stopPropagation();
    try {
      if (await fn()) reload();
    } catch (error) {
      toast(error.message, "error");
    }
  };
  if (txn.status === "matched") {
    const path = txn.matched_kind === "invoice" ? "invoices" : "bills";
    return h(
      "div",
      { class: "row-actions" },
      h(
        "a",
        {
          href: `#/${path}/${txn.matched_document_id}`,
          onclick: (e) => e.stopPropagation(),
        },
        `View ${txn.matched_kind}${txn.matched_number ? ` ${txn.matched_number}` : ""}`,
      ),
      h(
        "button",
        {
          class: "btn btn-small",
          type: "button",
          onclick: stop(() =>
            api("POST", `/api/transactions/${txn.id}/exclude`, {
              excluded: false,
            }),
          ),
        },
        "Unmatch",
      ),
    );
  }
  if (txn.status === "excluded") {
    return h(
      "div",
      { class: "row-actions" },
      h(
        "button",
        {
          class: "btn btn-small",
          type: "button",
          onclick: stop(() =>
            api("POST", `/api/transactions/${txn.id}/exclude`, {
              excluded: false,
            }),
          ),
        },
        "Restore",
      ),
    );
  }
  return h(
    "div",
    { class: "row-actions" },
    categorySelect(txn),
    h(
      "button",
      {
        class: "btn btn-small",
        type: "button",
        onclick: stop(() => matchDialog(txn)),
      },
      "Match",
    ),
    h(
      "button",
      {
        class: "btn btn-small btn-ghost",
        type: "button",
        title: "Exclude (e.g. a duplicate or personal transaction)",
        onclick: stop(() =>
          api("POST", `/api/transactions/${txn.id}/exclude`, {
            excluded: true,
          }),
        ),
      },
      "Exclude",
    ),
  );
}

export async function transactionsPage(query) {
  const params = new URLSearchParams();
  for (const key of ["account_id", "status", "from", "to", "search"]) {
    if (query[key]) params.set(key, query[key]);
  }
  const txns = await api("GET", `/api/transactions?${params}`);
  const filters = h(
    "form",
    {
      class: "toolbar",
      onsubmit: (event) => {
        event.preventDefault();
        const next = new URLSearchParams();
        for (const el of event.target.elements)
          if (el.name && el.value) next.set(el.name, el.value);
        navigate(`/transactions?${next}`);
      },
    },
    select(
      "account_id",
      [
        { value: "", label: "All accounts" },
        ...cashAccounts().map((a) => ({ value: a.id, label: a.name })),
      ],
      query.account_id ?? "",
    ),
    select(
      "status",
      STATUSES.map(([value, label]) => ({ value, label })),
      query.status ?? "",
    ),
    input("from", query.from, { type: "date", "aria-label": "From" }),
    input("to", query.to, { type: "date", "aria-label": "To" }),
    input("search", query.search, {
      type: "search",
      placeholder: "Search descriptions…",
      class: "search",
    }),
    h("button", { class: "btn", type: "submit" }, "Filter"),
  );
  const total = txns
    .filter((t) => t.status !== "excluded")
    .reduce((s, t) => s + t.amount_cents, 0);
  return h(
    "div",
    null,
    pageHeader(
      "Transactions",
      h(
        "button",
        {
          class: "btn btn-primary",
          type: "button",
          onclick: async () => {
            if (await addTransactionDialog()) reload();
          },
        },
        "Add transaction",
      ),
      h(
        "a",
        { class: "btn", href: "#/transactions/import" },
        "Import bank file",
      ),
    ),
    filters,
    txns.length === 0
      ? h(
          "p",
          { class: "empty" },
          "No transactions. Import a bank statement or add one manually.",
        )
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
                h("th", null, "Date"),
                h("th", null, "Description"),
                h("th", null, "Account"),
                h("th", { class: "num" }, "Amount"),
                h("th", null, "Status"),
                h("th", null, "Category / action"),
              ),
            ),
            h(
              "tbody",
              null,
              txns.map((t) =>
                h(
                  "tr",
                  {
                    class: "clickable",
                    onclick: async () => {
                      if (await detailDialog(t)) reload();
                    },
                  },
                  h("td", { class: "nowrap" }, formatDate(t.date)),
                  h(
                    "td",
                    null,
                    t.description,
                    t.attachment_count
                      ? h(
                          "span",
                          { class: "muted", title: "Has receipt" },
                          " 📎",
                        )
                      : null,
                  ),
                  h("td", null, t.account_name),
                  h(
                    "td",
                    {
                      class: `num ${t.amount_cents < 0 ? "negative" : "positive"}`,
                    },
                    money(t.amount_cents),
                  ),
                  h("td", null, badge(t.status)),
                  h("td", null, rowActions(t)),
                ),
              ),
            ),
            h(
              "tfoot",
              null,
              h(
                "tr",
                null,
                h("td", { colspan: 3 }, `${txns.length} transaction(s)`),
                h("td", { class: "num" }, money(total)),
                h("td", { colspan: 2 }),
              ),
            ),
          ),
        ),
  );
}
