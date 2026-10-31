import {
  api,
  field,
  h,
  input,
  modal,
  onSubmit,
  pageHeader,
  select,
  table,
  toast,
} from "../lib.mjs";
import { reload } from "../nav.mjs";
import { refreshReferenceData, state } from "../state.mjs";

const CURRENCIES = [
  "USD",
  "CAD",
  "EUR",
  "GBP",
  "AUD",
  "NZD",
  "INR",
  "LKR",
  "SGD",
  "ZAR",
  "JPY",
  "CHF",
  "MXN",
  "BRL",
];

function editTax(existing) {
  return modal(existing ? "Edit sales tax" : "New sales tax", (close) =>
    h(
      "form",
      {
        class: "form",
        onsubmit: onSubmit(async (values) => {
          const body = {
            name: values.name,
            rate: values.rate,
            recoverable: values.recoverable === true,
            archived: values.archived === true,
          };
          if (existing) await api("PUT", `/api/taxes/${existing.id}`, body);
          else await api("POST", "/api/taxes", body);
          await refreshReferenceData();
          toast("Saved");
          close(true);
        }),
      },
      h(
        "div",
        { class: "grid-2" },
        field(
          "Name",
          input("name", existing?.name, {
            required: true,
            maxlength: 60,
            placeholder: "e.g. GST",
          }),
        ),
        field(
          "Rate (%)",
          input("rate", existing ? existing.rate_bp / 100 : "", {
            type: "number",
            step: "0.001",
            min: 0,
            required: true,
          }),
        ),
      ),
      h(
        "label",
        { class: "check" },
        h("input", {
          type: "checkbox",
          name: "recoverable",
          checked: existing ? Boolean(existing.recoverable) : true,
        }),
        " Tax paid on bills is recoverable (claimable as an input tax credit)",
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
      existing
        ? h(
            "p",
            { class: "hint" },
            "Once a tax is used on a document its rate is locked. If the rate changes, archive this tax and add a new one.",
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

export async function settingsPage() {
  await refreshReferenceData();
  const s = state.settings;
  return h(
    "div",
    null,
    pageHeader("Settings"),
    h(
      "form",
      {
        class: "card form",
        onsubmit: onSubmit(async (values) => {
          await api("PUT", "/api/settings", values);
          await refreshReferenceData();
          toast("Settings saved");
          reload();
        }),
      },
      h("h2", null, "Business"),
      h(
        "div",
        { class: "grid-2" },
        field(
          "Business name",
          input("business_name", s.business_name, {
            required: true,
            maxlength: 200,
          }),
        ),
        field(
          "Currency",
          select(
            "currency",
            CURRENCIES.map((c) => ({ value: c, label: c })),
            s.currency,
          ),
        ),
      ),
      field(
        "Address",
        h(
          "textarea",
          { name: "business_address", rows: 3 },
          s.business_address,
        ),
      ),
      h(
        "div",
        { class: "grid-2" },
        field(
          "Email",
          input("business_email", s.business_email, { type: "email" }),
        ),
        field("Phone", input("business_phone", s.business_phone)),
      ),
      h("h2", null, "Invoices"),
      h(
        "div",
        { class: "grid-3" },
        field(
          "Number prefix",
          input("invoice_prefix", s.invoice_prefix, { maxlength: 20 }),
        ),
        field(
          "Next number",
          input("next_invoice_number", s.next_invoice_number, {
            type: "number",
            min: 1,
          }),
        ),
        field(
          "Payment terms (days)",
          input("payment_terms_days", s.payment_terms_days, {
            type: "number",
            min: 0,
          }),
        ),
      ),
      field(
        "Invoice footer",
        h("textarea", { name: "invoice_footer", rows: 2 }, s.invoice_footer),
      ),
      h(
        "div",
        { class: "form-actions" },
        h(
          "button",
          { class: "btn btn-primary", type: "submit" },
          "Save settings",
        ),
      ),
    ),
    h(
      "section",
      { class: "card" },
      h(
        "div",
        { class: "section-head" },
        h("h2", null, "Sales taxes"),
        h(
          "button",
          {
            class: "btn btn-small",
            type: "button",
            onclick: async () => {
              if (await editTax()) reload();
            },
          },
          "Add tax",
        ),
      ),
      table(
        [
          {
            label: "Name",
            render: (t) => [
              t.name,
              t.archived ? h("span", { class: "muted" }, " (archived)") : null,
            ],
          },
          { label: "Rate", render: (t) => `${t.rate_bp / 100}%` },
          {
            label: "Recoverable",
            render: (t) => (t.recoverable ? "Yes" : "No"),
          },
          {
            label: "",
            render: (t) =>
              h(
                "button",
                {
                  class: "btn btn-small",
                  type: "button",
                  onclick: async () => {
                    if (await editTax(t)) reload();
                  },
                },
                "Edit",
              ),
          },
        ],
        state.taxes,
        {
          empty:
            "No sales taxes. Add one if you charge sales tax, GST, HST or VAT.",
        },
      ),
    ),
    h(
      "form",
      {
        class: "card form",
        onsubmit: onSubmit(async (values, event) => {
          if (values.next !== values.confirm)
            throw new Error("New passwords do not match");
          await api("POST", "/api/settings/password", {
            current: values.current,
            next: values.next,
          });
          event.target.reset();
          toast("Password changed. Please log in again.");
          window.dispatchEvent(new Event("books:logged-out"));
        }),
      },
      h("h2", null, "Change password"),
      h(
        "div",
        { class: "grid-3" },
        field(
          "Current password",
          input("current", "", {
            type: "password",
            required: true,
            autocomplete: "current-password",
          }),
        ),
        field(
          "New password",
          input("next", "", {
            type: "password",
            required: true,
            minlength: 10,
            autocomplete: "new-password",
          }),
        ),
        field(
          "Confirm new password",
          input("confirm", "", {
            type: "password",
            required: true,
            autocomplete: "new-password",
          }),
        ),
      ),
      h(
        "div",
        { class: "form-actions" },
        h("button", { class: "btn", type: "submit" }, "Change password"),
      ),
    ),
    h(
      "section",
      { class: "card" },
      h("h2", null, "Backup"),
      h(
        "p",
        null,
        "Download a complete copy of your books as a single SQLite file. Keep it somewhere safe. To restore, stop the app and replace the data file with the backup.",
      ),
      h(
        "a",
        { class: "btn", href: "/api/backup", download: "" },
        "Download backup",
      ),
    ),
  );
}
