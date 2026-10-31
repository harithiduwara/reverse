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
  table,
  toast,
} from "../lib.mjs";
import { navigate, reload } from "../nav.mjs";

const PATHS = {
  customer: {
    api: "/api/customers",
    page: "/customers",
    docs: "invoices",
    docLabel: "Invoices",
    title: "Customers",
    one: "customer",
  },
  vendor: {
    api: "/api/vendors",
    page: "/vendors",
    docs: "bills",
    docLabel: "Bills",
    title: "Vendors",
    one: "vendor",
  },
};

/** Add/edit form. Resolves with the saved contact, or undefined. */
export function editContact(kind, existing) {
  const p = PATHS[kind];
  return modal(existing ? `Edit ${p.one}` : `New ${p.one}`, (close) =>
    h(
      "form",
      {
        class: "form",
        onsubmit: onSubmit(async (values) => {
          const body = { ...values, archived: values.archived === true };
          const saved = existing
            ? await api("PUT", `${p.api}/${existing.id}`, body)
            : await api("POST", p.api, body);
          toast("Saved");
          close(saved);
        }),
      },
      field(
        "Name",
        input("name", existing?.name, { required: true, maxlength: 200 }),
      ),
      h(
        "div",
        { class: "grid-2" },
        field(
          "Email",
          input("email", existing?.email, { type: "email", maxlength: 200 }),
        ),
        field("Phone", input("phone", existing?.phone, { maxlength: 60 })),
      ),
      field(
        "Address",
        h(
          "textarea",
          { name: "address", rows: 3, maxlength: 1000 },
          existing?.address ?? "",
        ),
      ),
      field(
        "Notes",
        h(
          "textarea",
          { name: "notes", rows: 2, maxlength: 5000 },
          existing?.notes ?? "",
        ),
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
            " Archived (hide from lists)",
          )
        : null,
      h(
        "div",
        { class: "form-actions" },
        h(
          "button",
          { class: "btn", type: "button", onclick: () => close(undefined) },
          "Cancel",
        ),
        h("button", { class: "btn btn-primary", type: "submit" }, "Save"),
      ),
    ),
  );
}

export async function contactListPage(kind) {
  const p = PATHS[kind];
  const contacts = await api("GET", p.api);
  const docs = await api("GET", `/api/${p.docs}`);
  const balances = new Map();
  for (const doc of docs) {
    balances.set(
      doc.party_id,
      (balances.get(doc.party_id) ?? 0) + doc.balance_cents,
    );
  }
  const search = input("search", "", {
    type: "search",
    placeholder: `Search ${p.title.toLowerCase()}…`,
    class: "search",
  });
  const list = h("div");
  const draw = () => {
    const q = search.value.trim().toLowerCase();
    const rows = contacts.filter(
      (c) => !q || `${c.name} ${c.email} ${c.phone}`.toLowerCase().includes(q),
    );
    list.replaceChildren(
      table(
        [
          {
            label: "Name",
            render: (c) => [
              c.name,
              c.archived ? h("span", { class: "muted" }, " (archived)") : null,
            ],
          },
          { label: "Email", render: (c) => c.email },
          { label: "Phone", render: (c) => c.phone },
          {
            label: "Balance due",
            align: "right",
            render: (c) => money(balances.get(c.id) ?? 0),
          },
        ],
        rows,
        {
          onRowClick: (c) => navigate(`${p.page}/${c.id}`),
          empty: `No ${p.title.toLowerCase()} yet.`,
        },
      ),
    );
  };
  search.addEventListener("input", draw);
  draw();
  return h(
    "div",
    null,
    pageHeader(
      p.title,
      h(
        "button",
        {
          class: "btn btn-primary",
          type: "button",
          onclick: async () => {
            const saved = await editContact(kind);
            if (saved) navigate(`${p.page}/${saved.id}`);
          },
        },
        `Add ${p.one}`,
      ),
    ),
    h("div", { class: "toolbar" }, search),
    list,
  );
}

export async function contactPage(kind, id) {
  const p = PATHS[kind];
  const [contact, docs] = await Promise.all([
    api("GET", `${p.api}/${id}`),
    api("GET", `/api/${p.docs}?party_id=${encodeURIComponent(id)}`),
  ]);
  const balance = docs.reduce((s, d) => s + d.balance_cents, 0);
  const docKind = kind === "customer" ? "invoice" : "bill";
  return h(
    "div",
    null,
    pageHeader(
      contact.name,
      h(
        "a",
        {
          class: "btn btn-primary",
          href: `#/${p.docs}/new?party_id=${contact.id}`,
        },
        `New ${docKind}`,
      ),
      h(
        "button",
        {
          class: "btn",
          type: "button",
          onclick: async () => {
            if (await editContact(kind, contact)) reload();
          },
        },
        "Edit",
      ),
      h(
        "button",
        {
          class: "btn btn-danger-outline",
          type: "button",
          onclick: async () => {
            if (
              !(await confirmDialog(`Delete ${contact.name}?`, "Delete", true))
            )
              return;
            try {
              await api("DELETE", `${p.api}/${contact.id}`);
              toast("Deleted");
              navigate(p.page);
            } catch (error) {
              toast(error.message, "error");
            }
          },
        },
        "Delete",
      ),
    ),
    h(
      "div",
      { class: "card contact-card" },
      h(
        "dl",
        { class: "details" },
        h("dt", null, "Email"),
        h(
          "dd",
          null,
          contact.email
            ? h("a", { href: `mailto:${contact.email}` }, contact.email)
            : "—",
        ),
        h("dt", null, "Phone"),
        h("dd", null, contact.phone || "—"),
        h("dt", null, "Address"),
        h("dd", { class: "pre" }, contact.address || "—"),
        contact.notes
          ? [h("dt", null, "Notes"), h("dd", { class: "pre" }, contact.notes)]
          : null,
        h("dt", null, "Balance due"),
        h("dd", null, h("strong", null, money(balance))),
      ),
    ),
    h("h2", null, p.docLabel),
    table(
      [
        { label: "Status", render: (d) => badge(d.display_status) },
        { label: "Date", render: (d) => formatDate(d.issue_date) },
        { label: "Number", render: (d) => d.number || "—" },
        { label: "Due", render: (d) => formatDate(d.due_date) },
        { label: "Total", align: "right", render: (d) => money(d.total_cents) },
        {
          label: "Balance",
          align: "right",
          render: (d) => money(d.balance_cents),
        },
      ],
      docs,
      {
        onRowClick: (d) => navigate(`/${p.docs}/${d.id}`),
        empty: `No ${p.docLabel.toLowerCase()} yet.`,
      },
    ),
  );
}

export { PATHS as CONTACT_PATHS };
