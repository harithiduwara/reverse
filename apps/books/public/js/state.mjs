// Cached reference data (settings, chart of accounts, taxes).

import { api, setCurrency } from "./lib.mjs";

export const state = { settings: {}, accounts: [], taxes: [] };

export async function refreshReferenceData() {
  const [settings, accounts, taxes] = await Promise.all([
    api("GET", "/api/settings"),
    api("GET", "/api/accounts"),
    api("GET", "/api/taxes"),
  ]);
  Object.assign(state, { settings, accounts, taxes });
  setCurrency(settings.currency || "USD");
}

const TYPE_LABELS = {
  asset: "Assets",
  liability: "Liabilities",
  equity: "Equity",
  income: "Income",
  expense: "Expenses",
};

export const accountTypeLabel = (type) => TYPE_LABELS[type] ?? type;

/** Grouped <select> options for accounts matching a filter. */
export function accountOptions(filter = () => true, { blank } = {}) {
  const groups = Object.keys(TYPE_LABELS)
    .map((type) => ({
      group: TYPE_LABELS[type],
      options: state.accounts
        .filter((a) => a.type === type && !a.archived && filter(a))
        .map((a) => ({ value: a.id, label: `${a.code} · ${a.name}` })),
    }))
    .filter((g) => g.options.length > 0);
  return blank ? [{ value: "", label: blank }, ...groups] : groups;
}

export const cashAccounts = () =>
  state.accounts.filter((a) => a.is_cash && !a.archived);

export function taxOptions() {
  return [
    { value: "", label: "No tax" },
    ...state.taxes
      .filter((t) => !t.archived)
      .map((t) => ({ value: t.id, label: `${t.name} (${t.rate_bp / 100}%)` })),
  ];
}
