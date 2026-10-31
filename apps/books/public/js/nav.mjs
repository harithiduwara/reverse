// Navigation helpers (kept separate so pages do not import the app shell).

export function navigate(path) {
  if (location.hash === `#${path}`) reload();
  else location.hash = path;
}

/** Re-render the current page after a change. */
export function reload() {
  window.dispatchEvent(new Event("books:reload"));
}
