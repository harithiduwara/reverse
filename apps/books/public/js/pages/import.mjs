// Bank statement import (CSV with column mapping, or OFX/QFX).

import { api, field, h, pageHeader, select, toast } from "../lib.mjs";
import { cashAccounts, refreshReferenceData } from "../state.mjs";

export async function importPage() {
  const accounts = cashAccounts();
  const area = h("div");
  let content = "";
  const accountSel = select(
    "account_id",
    accounts.map((a) => ({ value: a.id, label: a.name })),
    accounts[1]?.id ?? accounts[0]?.id,
  );
  const fileInput = h("input", {
    type: "file",
    accept: ".csv,.ofx,.qfx,text/csv",
  });

  const finish = (result) => {
    area.replaceChildren(
      h(
        "div",
        { class: "card" },
        h("h2", null, "Import complete"),
        h(
          "p",
          null,
          `${result.imported} new transaction(s) imported, ${result.duplicates} duplicate(s) skipped.`,
        ),
        result.skipped.length
          ? h(
              "p",
              { class: "muted" },
              `${result.skipped.length} row(s) could not be read: `,
              result.skipped
                .slice(0, 10)
                .map((s) => `row ${s.row} (${s.reason})`)
                .join(", "),
            )
          : null,
        h(
          "a",
          { class: "btn btn-primary", href: "#/transactions?status=new" },
          "Review transactions",
        ),
      ),
    );
  };

  const doImport = async (mapping) => {
    try {
      finish(
        await api("POST", "/api/transactions/import", {
          account_id: accountSel.value,
          content,
          mapping,
        }),
      );
      await refreshReferenceData();
    } catch (error) {
      toast(error.message, "error");
    }
  };

  const showMapping = (preview) => {
    const cols = [
      { value: "-1", label: "— none —" },
      ...preview.headers.map((name, i) => ({ value: i, label: name })),
    ];
    const s = preview.suggested;
    const form = h(
      "form",
      {
        class: "card form",
        onsubmit: (event) => {
          event.preventDefault();
          const v = Object.fromEntries(
            [...form.elements]
              .filter((e) => e.name)
              .map((e) => [
                e.name,
                e.type === "checkbox" ? e.checked : e.value,
              ]),
          );
          doImport({
            ...v,
            amount: v.mode === "single" ? v.amount : -1,
            debit: v.mode === "split" ? v.debit : -1,
            credit: v.mode === "split" ? v.credit : -1,
          });
        },
      },
      h("h2", null, `Match columns (${preview.total_rows} rows)`),
      h(
        "div",
        { class: "grid-3" },
        field("Date column", select("date", cols, s.date)),
        field(
          "Date format",
          select(
            "date_format",
            ["YYYY-MM-DD", "MM/DD/YYYY", "DD/MM/YYYY"].map((f) => ({
              value: f,
              label: f,
            })),
            s.date_format,
          ),
        ),
        field("Description column", select("description", cols, s.description)),
      ),
      field(
        "Amounts are in",
        select(
          "mode",
          [
            { value: "single", label: "One column (negative = money out)" },
            { value: "split", label: "Separate debit and credit columns" },
          ],
          s.amount >= 0 || s.debit < 0 ? "single" : "split",
        ),
      ),
      h(
        "div",
        { class: "grid-3" },
        field("Amount column", select("amount", cols, s.amount)),
        field("Money out (debit) column", select("debit", cols, s.debit)),
        field("Money in (credit) column", select("credit", cols, s.credit)),
      ),
      h(
        "label",
        { class: "check" },
        h("input", { type: "checkbox", name: "flip_sign" }),
        " Flip signs (use if deposits show as negative)",
      ),
      h(
        "div",
        { class: "table-wrap" },
        h(
          "table",
          { class: "table small" },
          h(
            "thead",
            null,
            h(
              "tr",
              null,
              preview.headers.map((x) => h("th", null, x)),
            ),
          ),
          h(
            "tbody",
            null,
            preview.rows.slice(0, 8).map((r) =>
              h(
                "tr",
                null,
                r.map((c) => h("td", null, c)),
              ),
            ),
          ),
        ),
      ),
      h(
        "div",
        { class: "form-actions" },
        h(
          "button",
          { class: "btn btn-primary", type: "submit" },
          "Import transactions",
        ),
      ),
    );
    area.replaceChildren(form);
  };

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files[0];
    if (!file) return;
    content = await file.text();
    try {
      if (/OFXHEADER|<OFX>/i.test(content.slice(0, 2000))) {
        await doImport({});
      } else {
        showMapping(
          await api("POST", "/api/transactions/import/preview", { content }),
        );
      }
    } catch (error) {
      toast(error.message, "error");
    }
  });

  return h(
    "div",
    null,
    h("a", { class: "back", href: "#/transactions" }, "← Transactions"),
    pageHeader("Import a bank statement"),
    h(
      "div",
      { class: "card form" },
      h(
        "p",
        null,
        "Download a CSV, OFX or QFX statement from your bank's website and upload it here. Transactions you've already imported are skipped automatically.",
      ),
      h(
        "div",
        { class: "grid-2" },
        field("Bank account", accountSel),
        field("Statement file", fileInput),
      ),
      accounts.length === 0
        ? h(
            "p",
            { class: "hint" },
            "Add a bank account in the chart of accounts first.",
          )
        : null,
    ),
    area,
  );
}
