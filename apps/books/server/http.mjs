// Small HTTP helpers: errors, input validation, and a tiny router.

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value) {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

export function requireDate(value, field) {
  if (!isIsoDate(value)) {
    throw new HttpError(400, `${field} must be a date (YYYY-MM-DD)`);
  }
  return value;
}

export function optionalDate(value, field) {
  return value === undefined || value === null || value === ""
    ? null
    : requireDate(value, field);
}

export function requireText(value, field, max = 200) {
  const text = optionalText(value, field, max);
  if (!text) throw new HttpError(400, `${field} is required`);
  return text;
}

export function optionalText(value, field, max = 2000) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") {
    throw new HttpError(400, `${field} must be text`);
  }
  const text = value.trim();
  if (text.length > max) {
    throw new HttpError(400, `${field} must be at most ${max} characters`);
  }
  return text;
}

export function requireId(value, field) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new HttpError(400, `${field} must be a valid id`);
  }
  return id;
}

export function optionalId(value, field) {
  return value === undefined || value === null || value === ""
    ? null
    : requireId(value, field);
}

export function requireOneOf(value, field, allowed) {
  if (!allowed.includes(value)) {
    throw new HttpError(400, `${field} must be one of: ${allowed.join(", ")}`);
  }
  return value;
}

export function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

/** Router keyed by method; paths use ":name" segments. */
export class Router {
  #routes = [];

  add(method, path, handler) {
    const names = [];
    const pattern = path.replace(/:(\w+)/g, (_, name) => {
      names.push(name);
      return "([^/]+)";
    });
    this.#routes.push({
      method,
      regex: new RegExp(`^${pattern}$`),
      names,
      handler,
    });
  }

  match(method, pathname) {
    let pathMatched = false;
    for (const route of this.#routes) {
      const match = route.regex.exec(pathname);
      if (!match) continue;
      pathMatched = true;
      if (route.method !== method) continue;
      const params = {};
      route.names.forEach((name, index) => {
        params[name] = decodeURIComponent(match[index + 1]);
      });
      return { handler: route.handler, params };
    }
    return pathMatched ? "method-not-allowed" : null;
  }
}
