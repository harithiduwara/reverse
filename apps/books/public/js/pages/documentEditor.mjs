// Invoice/bill editor with live totals.

import {
  addDays,
  api,
  field,
  h,
  input,
  money,
  pageHeader,
  plainAmount,
  select,
  today,
  toast,
} from "../lib.mjs";
import { navigate } from "../nav.mjs";
import { accountOptions, state, taxOptions } from "../state.mjs";
import { editContact } from "./contacts.mjs";
import { KINDS } from "./documentKinds.mjs";

function lineRow(kind, line, onChange, onRemove) {
  const k = KINDS[kind];
  const defaultAccount = state.accounts.find(
    (a) => a.system_key === (kind === "invoice" ? "sales" : "uncat_expense"),
  )?.id;
  const amount = h("td", { class: "num line-amount" });
  const row = h(
    "tr",
    { class: "line" },
    h(
      "td",
      null,
      input("description", line.description, {
        placeholder: "Description",
        maxlength: 1000,
        "aria-label": "Description",
      }),
    ),
    h(
      "td",
      null,
      select(
        "account_id",
        accountOptions(k.lineAccounts),
        line.account_id ?? defaultAccount,
        { "aria-label": "Account" },
      ),
    ),
    h(
      "td",
      null,
      input("quantity", line.quantity ?? 1, {
        type: "number",
        step: "any",
        class: "narrow",
        "aria-label": "Quantity",
      }),
    ),
    h(
      "td",
      null,
      input("unit_price", line.unit_price ?? "", {
        inputmode: "decimal",
        class: "narrow",
        placeholder: "0.00",
        "aria-label": "Price",
      }),
    ),
    h(
      "td",
      null,
      select("tax_id", taxOptions(), line.tax_id ?? "", {
        "aria-label": "Tax",
      }),
    ),
    amount,
    h(
      "td",
      null,
      h(
        "button",
        {
          class: "icon-btn",
          type: "button",
          "aria-label": "Remove line",
          onclick: () => {
            row.remove();
            onRemove();
          },
        },
        "×",
      ),
    ),
  );
  row.addEventListener("input", onChange);
  row.addEventListener("change", onChange);
  row.amountCell = amount;
  return row;
}

function readLine(row) {
  const get = (name) => row.querySelector(`[name="${name}"]`).value;
  return {
    description: get("description"),
    account_id: get("account_id"),
    quantity: get("quantity") === "" ? 1 : Number(get("quantity")),
    unit_price: get("unit_price") || "0",
    tax_id: get("tax_id") || null,
  };
}

/** Client-side preview of totals; the server recomputes authoritatively. */
function previewTotals(rows) {
  let subtotal = 0;
  let tax = 0;
  for (const row of rows) {
    const line = readLine(row);
    const price =
      Math.round(
        Number(String(line.unit_price).replace(/[,$\s]/g, "")) * 100,
      ) || 0;
    const amount = Math.round(line.quantity * price);
    const rate =
      state.taxes.find((t) => String(t.id) === String(line.tax_id))?.rate_bp ??
      0;
    subtotal += amount;
    tax += Math.round((amount * rate) / 10000);
    row.amountCell.textContent = money(amount);
  }
  return { subtotal, tax, total: subtotal + tax };
}

export async function documentEditPage(kind, id, query = {}) {
  const k = KINDS[kind];
  const [doc, parties] = await Promise.all([
    id ? api("GET", `${k.api}/${id}`) : null,
    api("GET", k.partyApi),
  ]);
  const terms = Number(state.settings.payment_terms_days || 30);
  const issue = doc?.issue_date ?? today();
  const partyOptions = () => [
    { value: "", label: `Choose a ${k.partyLabel.toLowerCase()}…` },
    ...parties
      .filter((p) => !p.archived || p.id === doc?.party_id)
      .map((p) => ({ value: p.id, label: p.name })),
  ];
  let partySelect = select(
    "party_id",
    partyOptions(),
    doc?.party_id ?? query.party_id ?? "",
    { required: true },
  );
  const partyField = h(
    "div",
    { class: "party-picker" },
    partySelect,
    h(
      "button",
      {
        class: "btn btn-small",
        type: "button",
        onclick: async () => {
          const saved = await editContact(k.partyKind);
          if (!saved) return;
          parties.push(saved);
          const next = select("party_id", partyOptions(), saved.id, {
            required: true,
          });
          partySelect.replaceWith(next);
          partySelect = next;
        },
      },
      "+ New",
    ),
  );
  const issueInput = input("issue_date", issue, {
    type: "date",
    required: true,
  });
  const dueInput = input("due_date", doc?.due_date ?? addDays(issue, terms), {
    type: "date",
    required: true,
  });
  issueInput.addEventListener("change", () => {
    if (!doc) dueInput.value = addDays(issueInput.value, terms);
  });

  const body = h("tbody");
  const totalsBox = h("div", { class: "totals" });
  const refresh = () => {
    const t = previewTotals([...body.children]);
    totalsBox.replaceChildren(
      h(
        "div",
        null,
        h("span", null, "Subtotal"),
        h("span", null, money(t.subtotal)),
      ),
      h("div", null, h("span", null, "Tax"), h("span", null, money(t.tax))),
      h(
        "div",
        { class: "grand" },
        h("span", null, "Total"),
        h("span", null, money(t.total)),
      ),
    );
  };
  const addLine = (line = {}) => {
    body.append(lineRow(kind, line, refresh, refresh));
    refresh();
  };
  const initial = doc?.lines.map((l) => ({
    ...l,
    unit_price: plainAmount(l.unit_price_cents),
  })) ?? [{}];
  initial.forEach(addLine);

  const save = async (post) => {
    const form = document.getElementById("doc-form");
    if (!form.reportValidity()) return;
    const payload = {
      party_id: partySelect.value,
      number: form.elements.number.value,
      issue_date: issueInput.value,
      due_date: dueInput.value,
      notes: form.elements.notes.value,
      lines: [...body.children].map(readLine),
      post,
    };
    const saved = doc
      ? await api("PUT", `${k.api}/${doc.id}`, payload)
      : await api("POST", k.api, payload);
    toast(post ? `${k.one} saved and approved` : `${k.one} saved`);
    navigate(`${k.page}/${saved.id}`);
  };
  const run = (post) => async (event) => {
    event.preventDefault();
    const buttons = document.querySelectorAll("#doc-form button");
    buttons.forEach((b) => (b.disabled = true));
    try {
      await save(post);
    } catch (error) {
      toast(error.message, "error");
    } finally {
      buttons.forEach((b) => (b.disabled = false));
    }
  };

  const posted = doc?.status === "posted";
  return h(
    "div",
    null,
    pageHeader(
      doc
        ? `Edit ${k.one.toLowerCase()} ${doc.number}`
        : `New ${k.one.toLowerCase()}`,
    ),
    h(
      "form",
      {
        id: "doc-form",
        class: "card form",
        onsubmit: (event) => event.preventDefault(),
      },
      h(
        "div",
        { class: "grid-4" },
        field(k.partyLabel, partyField),
        field(
          kind === "invoice" ? "Invoice number" : "Bill number",
          input("number", doc?.number ?? "", {
            maxlength: 60,
            placeholder: kind === "invoice" ? "Automatic" : "Optional",
          }),
        ),
        field("Date", issueInput),
        field("Due date", dueInput),
      ),
      h(
        "div",
        { class: "table-wrap" },
        h(
          "table",
          { class: "table lines" },
          h(
            "thead",
            null,
            h(
              "tr",
              null,
              h("th", null, "Item"),
              h("th", null, "Account"),
              h("th", null, "Qty"),
              h("th", null, "Price"),
              h("th", null, "Tax"),
              h("th", { class: "num" }, "Amount"),
              h("th"),
            ),
          ),
          body,
        ),
      ),
      h(
        "button",
        { class: "btn btn-small", type: "button", onclick: () => addLine() },
        "+ Add a line",
      ),
      totalsBox,
      field(
        kind === "invoice" ? "Notes / terms (shown on invoice)" : "Notes",
        h(
          "textarea",
          { name: "notes", rows: 3, maxlength: 5000 },
          doc?.notes ?? "",
        ),
      ),
      posted
        ? h(
            "p",
            { class: "hint" },
            "This document is approved; saving updates its accounting entries.",
          )
        : null,
      h(
        "div",
        { class: "form-actions" },
        h(
          "a",
          { class: "btn", href: doc ? `#${k.page}/${doc.id}` : `#${k.page}` },
          "Cancel",
        ),
        posted
          ? null
          : h(
              "button",
              { class: "btn", type: "button", onclick: run(false) },
              "Save as draft",
            ),
        h(
          "button",
          { class: "btn btn-primary", type: "button", onclick: run(true) },
          posted ? "Save" : `Save & ${k.postLabel.toLowerCase()}`,
        ),
      ),
    ),
  );
}
