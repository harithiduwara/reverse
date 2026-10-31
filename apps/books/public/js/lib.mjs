// Shared UI helpers: DOM builder, API client, formatting, modals, toasts.

/** Build DOM nodes without innerHTML (safe against injected markup). */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === "class") {
      el.className = value;
    } else if (key in el && key !== "list" && typeof value !== "string") {
      el[key] = value;
    } else if (key === "value") {
      el.value = value;
    } else {
      el.setAttribute(key, value === true ? "" : String(value));
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(el, child);
    else el.append(child instanceof Node ? child : String(child));
  }
}

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith("/api/auth/")) {
      window.dispatchEvent(new Event("books:logged-out"));
    }
    throw new ApiError(
      res.status,
      data.error ?? `Request failed (${res.status})`,
    );
  }
  return data;
}

// Formatting

let currency = "USD";
let moneyFormat = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency,
});

export function setCurrency(code) {
  try {
    moneyFormat = new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: code,
    });
    currency = code;
  } catch {
    // Keep the previous currency if the code is not recognised.
  }
}

export const money = (cents) => moneyFormat.format((cents ?? 0) / 100);
export const plainAmount = (cents) => ((cents ?? 0) / 100).toFixed(2);

export function formatDate(iso) {
  if (!iso) return "";
  const date = new Date(`${iso}T00:00:00`);
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export const today = () => {
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  return now.toISOString().slice(0, 10);
};

export function addDays(iso, days) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + Number(days || 0));
  return date.toISOString().slice(0, 10);
}

const STATUS_LABEL = {
  draft: "Draft",
  unpaid: "Unpaid",
  partial: "Partial",
  overdue: "Overdue",
  paid: "Paid",
  void: "Void",
  new: "Review",
  categorized: "Categorized",
  matched: "Matched",
  excluded: "Excluded",
};

export const badge = (status) =>
  h("span", { class: `badge badge-${status}` }, STATUS_LABEL[status] ?? status);

// Toasts and modals

export function toast(message, kind = "ok") {
  document.querySelectorAll(".toast").forEach((old) => old.remove());
  const el = h(
    "div",
    { class: `toast toast-${kind}`, role: "status" },
    message,
  );
  document.body.append(el);
  setTimeout(() => el.remove(), 3500);
}

export function showError(error) {
  toast(error?.message ?? String(error), "error");
}

/**
 * Open a modal. `build(close)` returns the body content.
 * Resolves with whatever is passed to close().
 */
export function modal(title, build, { wide = false } = {}) {
  return new Promise((resolve) => {
    const close = (value) => {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      resolve(value);
    };
    const onKey = (event) => {
      if (event.key === "Escape") close(undefined);
    };
    const dialog = h(
      "div",
      {
        class: `modal${wide ? " modal-wide" : ""}`,
        role: "dialog",
        "aria-modal": "true",
        "aria-label": title,
      },
      h(
        "header",
        { class: "modal-header" },
        h("h2", null, title),
        h(
          "button",
          {
            class: "icon-btn",
            type: "button",
            "aria-label": "Close",
            onclick: () => close(undefined),
          },
          "×",
        ),
      ),
      h("div", { class: "modal-body" }, build(close)),
    );
    const overlay = h(
      "div",
      {
        class: "overlay",
        onmousedown: (event) => {
          if (event.target === overlay) close(undefined);
        },
      },
      dialog,
    );
    document.addEventListener("keydown", onKey);
    document.body.append(overlay);
    dialog.querySelector("input, select, textarea")?.focus();
  });
}

export function confirmDialog(
  message,
  actionLabel = "Confirm",
  danger = false,
) {
  return modal("Are you sure?", (close) => [
    h("p", null, message),
    h(
      "div",
      { class: "form-actions" },
      h(
        "button",
        { class: "btn", type: "button", onclick: () => close(false) },
        "Cancel",
      ),
      h(
        "button",
        {
          class: `btn ${danger ? "btn-danger" : "btn-primary"}`,
          type: "button",
          onclick: () => close(true),
        },
        actionLabel,
      ),
    ),
  ]);
}

// Forms

export function field(label, control, hint) {
  return h(
    "label",
    { class: "field" },
    h("span", { class: "field-label" }, label),
    control,
    hint ? h("small", { class: "hint" }, hint) : null,
  );
}

export function input(name, value = "", attrs = {}) {
  return h("input", { name, value: value ?? "", ...attrs });
}

export function select(name, options, selected, attrs = {}) {
  return h(
    "select",
    { name, ...attrs },
    options.map((opt) =>
      opt.group
        ? h(
            "optgroup",
            { label: opt.group },
            opt.options.map((o) => option(o, selected)),
          )
        : option(opt, selected),
    ),
  );
}

function option(opt, selected) {
  return h(
    "option",
    {
      value: String(opt.value ?? ""),
      selected: String(opt.value ?? "") === String(selected ?? ""),
    },
    opt.label,
  );
}

export function formValues(form) {
  const values = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    values[el.name] = el.type === "checkbox" ? el.checked : el.value;
  }
  return values;
}

/** Submit handler wrapper: disables the button and shows errors. */
export function onSubmit(handler) {
  return async (event) => {
    event.preventDefault();
    const form = event.target.closest("form") ?? event.target;
    const buttons = form.querySelectorAll("button");
    buttons.forEach((b) => (b.disabled = true));
    try {
      await handler(formValues(form), event);
    } catch (error) {
      showError(error);
    } finally {
      buttons.forEach((b) => (b.disabled = false));
    }
  };
}

// Tables and CSV export

export function table(
  columns,
  rows,
  { onRowClick, empty = "Nothing here yet." } = {},
) {
  if (rows.length === 0) return h("p", { class: "empty" }, empty);
  return h(
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
          columns.map((c) =>
            h("th", { class: c.align === "right" ? "num" : null }, c.label),
          ),
        ),
      ),
      h(
        "tbody",
        null,
        rows.map((row) =>
          h(
            "tr",
            {
              class: onRowClick ? "clickable" : null,
              onclick: onRowClick ? () => onRowClick(row) : null,
            },
            columns.map((c) =>
              h(
                "td",
                { class: c.align === "right" ? "num" : null },
                c.render(row),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

export function downloadCsv(filename, rows) {
  const escape = (value) => {
    const text = String(value ?? "");
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const csv = rows.map((row) => row.map(escape).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const link = h("a", { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function pageHeader(title, ...actions) {
  return h(
    "div",
    { class: "page-header" },
    h("h1", null, title),
    h("div", { class: "actions" }, actions),
  );
}

export function readFileAsText(file) {
  return file.text();
}

export async function readFileAsBase64(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
