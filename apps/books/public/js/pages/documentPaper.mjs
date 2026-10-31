// Printable invoice/bill layout and email link.

import { formatDate, h, money } from "../lib.mjs";
import { state } from "../state.mjs";

export function paper(kind, doc) {
  const s = state.settings;
  return h(
    "article",
    { class: "paper" },
    h(
      "header",
      { class: "paper-head" },
      h(
        "div",
        null,
        h("div", { class: "paper-business" }, s.business_name),
        h(
          "div",
          { class: "pre muted" },
          [s.business_address, s.business_email, s.business_phone]
            .filter(Boolean)
            .join("\n"),
        ),
      ),
      h(
        "div",
        { class: "paper-title" },
        h("div", null, kind === "invoice" ? "INVOICE" : "BILL"),
        h("div", { class: "muted" }, doc.number ? `# ${doc.number}` : ""),
      ),
    ),
    h(
      "div",
      { class: "paper-meta" },
      h(
        "div",
        null,
        h("div", { class: "muted" }, kind === "invoice" ? "Bill to" : "From"),
        h("strong", null, doc.party_name),
        h(
          "div",
          { class: "pre" },
          [doc.party_address, doc.party_email].filter(Boolean).join("\n"),
        ),
      ),
      h(
        "dl",
        { class: "details" },
        h("dt", null, "Date"),
        h("dd", null, formatDate(doc.issue_date)),
        h("dt", null, "Due"),
        h("dd", null, formatDate(doc.due_date)),
        h("dt", null, "Amount due"),
        h(
          "dd",
          null,
          h(
            "strong",
            null,
            money(
              doc.status === "posted" ? doc.balance_cents : doc.total_cents,
            ),
          ),
        ),
      ),
    ),
    h(
      "table",
      { class: "table paper-lines" },
      h(
        "thead",
        null,
        h(
          "tr",
          null,
          h("th", null, "Item"),
          h("th", { class: "num" }, "Qty"),
          h("th", { class: "num" }, "Price"),
          h("th", { class: "num" }, "Amount"),
        ),
      ),
      h(
        "tbody",
        null,
        doc.lines.map((l) =>
          h(
            "tr",
            null,
            h("td", { class: "pre" }, l.description),
            h("td", { class: "num" }, String(l.quantity)),
            h("td", { class: "num" }, money(l.unit_price_cents)),
            h("td", { class: "num" }, money(l.amount_cents)),
          ),
        ),
      ),
    ),
    h(
      "div",
      { class: "totals" },
      h(
        "div",
        null,
        h("span", null, "Subtotal"),
        h("span", null, money(doc.subtotal_cents)),
      ),
      doc.taxes.map((t) =>
        h(
          "div",
          null,
          h("span", null, `${t.name} ${t.rate_bp / 100}%`),
          h("span", null, money(t.amount_cents)),
        ),
      ),
      h(
        "div",
        { class: "grand" },
        h("span", null, "Total"),
        h("span", null, money(doc.total_cents)),
      ),
      doc.paid_cents
        ? h(
            "div",
            null,
            h("span", null, "Paid"),
            h("span", null, `−${money(doc.paid_cents)}`),
          )
        : null,
      doc.status === "posted"
        ? h(
            "div",
            { class: "grand" },
            h("span", null, "Amount due"),
            h("span", null, money(doc.balance_cents)),
          )
        : null,
    ),
    doc.notes ? h("p", { class: "pre paper-notes" }, doc.notes) : null,
    kind === "invoice" && s.invoice_footer
      ? h("footer", { class: "paper-footer" }, s.invoice_footer)
      : null,
  );
}

export function mailtoLink(doc) {
  const subject = `Invoice ${doc.number} from ${state.settings.business_name}`;
  const text = `Hello ${doc.party_name},\n\nPlease find invoice ${doc.number} for ${money(doc.total_cents)}, due ${formatDate(doc.due_date)}. Amount due: ${money(doc.balance_cents)}.\n\n(Attach the PDF saved from the Print button.)\n\nThank you,\n${state.settings.business_name}`;
  return `mailto:${encodeURIComponent(doc.party_email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`;
}
