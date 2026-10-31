// App shell: login, navigation and hash-based routing.

import { api, field, h, input, onSubmit, showError } from "./lib.mjs";
import { refreshReferenceData, state } from "./state.mjs";
import { dashboardPage } from "./pages/dashboard.mjs";
import { contactListPage, contactPage } from "./pages/contacts.mjs";
import { documentEditPage } from "./pages/documentEditor.mjs";
import { documentListPage, documentViewPage } from "./pages/documents.mjs";
import { importPage } from "./pages/import.mjs";
import { transactionsPage } from "./pages/transactions.mjs";
import { accountsPage, journalPage, ledgerPage } from "./pages/accounts.mjs";
import { reportPage, reportsIndexPage } from "./pages/reports.mjs";
import { settingsPage } from "./pages/settings.mjs";

const root = document.getElementById("app");

const ROUTES = [
  ["/", dashboardPage],
  ["/customers", () => contactListPage("customer")],
  ["/customers/:id", ({ id }) => contactPage("customer", id)],
  ["/vendors", () => contactListPage("vendor")],
  ["/vendors/:id", ({ id }) => contactPage("vendor", id)],
  ["/invoices", (_, q) => documentListPage("invoice", q)],
  ["/invoices/new", (_, q) => documentEditPage("invoice", null, q)],
  ["/invoices/:id", ({ id }) => documentViewPage("invoice", id)],
  ["/invoices/:id/edit", ({ id }) => documentEditPage("invoice", id)],
  ["/bills", (_, q) => documentListPage("bill", q)],
  ["/bills/new", (_, q) => documentEditPage("bill", null, q)],
  ["/bills/:id", ({ id }) => documentViewPage("bill", id)],
  ["/bills/:id/edit", ({ id }) => documentEditPage("bill", id)],
  ["/transactions", (_, q) => transactionsPage(q)],
  ["/transactions/import", () => importPage()],
  ["/accounts", accountsPage],
  ["/accounts/:id", ({ id }, q) => ledgerPage(id, q)],
  ["/journal", journalPage],
  ["/reports", reportsIndexPage],
  ["/reports/:name", ({ name }, q) => reportPage(name, q)],
  ["/settings", settingsPage],
];

const NAV = [
  ["Dashboard", "/"],
  ["Sales", null],
  ["Invoices", "/invoices"],
  ["Customers", "/customers"],
  ["Purchases", null],
  ["Bills", "/bills"],
  ["Vendors", "/vendors"],
  ["Accounting", null],
  ["Transactions", "/transactions"],
  ["Chart of accounts", "/accounts"],
  ["Journal entries", "/journal"],
  ["Reports", "/reports"],
  ["Settings", "/settings"],
];

function matchRoute(path) {
  for (const [pattern, page] of ROUTES) {
    const names = [];
    const regex = new RegExp(
      `^${pattern.replace(/:(\w+)/g, (_, n) => (names.push(n), "([^/]+)"))}$`,
    );
    const match = regex.exec(path);
    if (match) {
      return {
        page,
        params: Object.fromEntries(
          names.map((n, i) => [n, decodeURIComponent(match[i + 1])]),
        ),
      };
    }
  }
  return null;
}

function currentPath() {
  const raw = location.hash.slice(1) || "/";
  const [path, queryString = ""] = raw.split("?");
  return { path, query: Object.fromEntries(new URLSearchParams(queryString)) };
}

function shell(content) {
  const { path } = currentPath();
  const active = (href) =>
    href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`);
  return h(
    "div",
    { class: "layout" },
    h(
      "aside",
      { class: "sidebar" },
      h(
        "div",
        { class: "brand" },
        h("span", { class: "brand-mark" }, "B"),
        h("span", null, state.settings.business_name || "Books"),
      ),
      h(
        "nav",
        null,
        NAV.map(([label, href]) =>
          href
            ? h(
                "a",
                { href: `#${href}`, class: active(href) ? "active" : null },
                label,
              )
            : h("div", { class: "nav-section" }, label),
        ),
      ),
      h(
        "button",
        { class: "btn btn-ghost logout", type: "button", onclick: logout },
        "Log out",
      ),
    ),
    h("main", { class: "content", id: "main" }, content),
  );
}

let renderToken = 0;

async function render() {
  const token = ++renderToken;
  const { path, query } = currentPath();
  const route = matchRoute(path);
  if (!route) {
    root.replaceChildren(shell(h("p", { class: "empty" }, "Page not found.")));
    return;
  }
  root.replaceChildren(shell(h("p", { class: "loading" }, "Loading…")));
  try {
    const content = await route.page(route.params, query);
    if (token === renderToken) {
      root.replaceChildren(shell(content));
      window.scrollTo(0, 0);
    }
  } catch (error) {
    if (token === renderToken) {
      root.replaceChildren(
        shell(h("div", { class: "error-box" }, error.message)),
      );
    }
  }
}

async function logout() {
  await api("POST", "/api/auth/logout", {}).catch(() => {});
  showAuth();
}

async function showAuth() {
  const status = await api("GET", "/api/auth/status");
  if (status.authenticated) return start();
  const setUp = status.set_up;
  const form = h(
    "form",
    {
      class: "auth-card",
      onsubmit: onSubmit(async ({ password, confirm }) => {
        if (!setUp && password !== confirm)
          throw new Error("Passwords do not match");
        await api("POST", setUp ? "/api/auth/login" : "/api/auth/setup", {
          password,
        });
        await start();
      }),
    },
    h(
      "div",
      { class: "brand brand-large" },
      h("span", { class: "brand-mark" }, "B"),
      h("span", null, "Books"),
    ),
    h(
      "p",
      null,
      setUp
        ? "Log in to your books."
        : "Welcome! Choose a password to protect your books (at least 10 characters).",
    ),
    field(
      "Password",
      input("password", "", {
        type: "password",
        required: true,
        autocomplete: setUp ? "current-password" : "new-password",
        autofocus: true,
      }),
    ),
    setUp
      ? null
      : field(
          "Confirm password",
          input("confirm", "", {
            type: "password",
            required: true,
            autocomplete: "new-password",
          }),
        ),
    h(
      "button",
      { class: "btn btn-primary btn-block", type: "submit" },
      setUp ? "Log in" : "Create password",
    ),
  );
  root.replaceChildren(h("div", { class: "auth" }, form));
  form.querySelector("input")?.focus();
}

let started = false;

async function start() {
  await refreshReferenceData();
  if (!started) {
    started = true;
    window.addEventListener("hashchange", render);
    window.addEventListener("books:reload", render);
  }
  render();
}

window.addEventListener("books:logged-out", () => {
  showAuth().catch(showError);
});

showAuth().catch((error) => {
  root.replaceChildren(
    h(
      "div",
      { class: "error-box" },
      `Could not reach the server: ${error.message}`,
    ),
  );
});
