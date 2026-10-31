// Shared settings for invoices and bills in the UI.

export const KINDS = {
  invoice: {
    title: "Invoices",
    one: "Invoice",
    api: "/api/invoices",
    page: "/invoices",
    partyApi: "/api/customers",
    partyKind: "customer",
    partyLabel: "Customer",
    lineAccounts: (a) => a.type === "income",
    postLabel: "Approve",
  },
  bill: {
    title: "Bills",
    one: "Bill",
    api: "/api/bills",
    page: "/bills",
    partyApi: "/api/vendors",
    partyKind: "vendor",
    partyLabel: "Vendor",
    lineAccounts: (a) =>
      (a.type === "expense" || a.type === "asset") &&
      !a.is_cash &&
      a.system_key !== "ar",
    postLabel: "Approve",
  },
};
