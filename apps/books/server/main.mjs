// HTTP server: serves the web app and the JSON API.

import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRouter } from "./api.mjs";
import * as auth from "./auth.mjs";
import { openDatabase } from "./db.mjs";
import { HttpError } from "./http.mjs";

const PUBLIC_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../public",
);
const MAX_BODY_BYTES = 25 * 1024 * 1024;
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data: blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

function sendJson(res, status, value, headers = {}) {
  send(res, status, JSON.stringify(value), {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "Request is too large");
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("not an object");
    }
    return value;
  } catch {
    throw new HttpError(400, "Request body must be a JSON object");
  }
}

function serveStatic(req, res, pathname) {
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  const file = normalize(join(PUBLIC_DIR, relative));
  if (!file.startsWith(PUBLIC_DIR + sep)) return send(res, 404, "Not found");
  try {
    const body = readFileSync(file);
    send(res, 200, body, {
      "Content-Type": MIME[extname(file)] ?? "application/octet-stream",
      "Cache-Control": "no-cache",
    });
  } catch {
    // Unknown paths fall back to the app shell (client-side routing).
    send(res, 200, readFileSync(join(PUBLIC_DIR, "index.html")), {
      "Content-Type": MIME[".html"],
    });
  }
}

function sendBackup(db, res) {
  const dir = join(tmpdir(), `books-backup-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "books.sqlite");
  try {
    db.prepare("VACUUM INTO ?").run(file);
    const stamp = new Date().toISOString().slice(0, 10);
    send(res, 200, readFileSync(file), {
      "Content-Type": "application/vnd.sqlite3",
      "Content-Disposition": `attachment; filename="books-backup-${stamp}.sqlite"`,
      "Cache-Control": "no-store",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function handleAuth(db, req, res, pathname, options) {
  const cookie = (token) => ({
    "Set-Cookie": auth.sessionCookie(token, options.secureCookies),
  });
  if (pathname === "/api/auth/status" && req.method === "GET") {
    return sendJson(res, 200, {
      set_up: auth.isSetUp(db),
      authenticated: auth.isAuthenticated(db, req),
    });
  }
  if (req.method !== "POST") throw new HttpError(405, "Method not allowed");
  const body = await readJson(req);
  if (pathname === "/api/auth/setup") {
    auth.setUpPassword(db, body.password);
    return sendJson(res, 200, { ok: true }, cookie(auth.createSession(db)));
  }
  if (pathname === "/api/auth/login") {
    return sendJson(
      res,
      200,
      { ok: true },
      cookie(auth.login(db, body.password)),
    );
  }
  if (pathname === "/api/auth/logout") {
    auth.logout(db, auth.sessionToken(req));
    return sendJson(res, 200, { ok: true }, cookie(""));
  }
  throw new HttpError(404, "Not found");
}

async function handleApi(db, router, req, res, url, options) {
  const { pathname } = url;
  if (req.method !== "GET" && req.method !== "HEAD") {
    // JSON-only bodies block cross-site form posts (CSRF) on top of SameSite.
    const type = req.headers["content-type"] ?? "";
    if (!type.startsWith("application/json")) {
      throw new HttpError(415, "Use application/json");
    }
  }
  if (pathname.startsWith("/api/auth/")) {
    return handleAuth(db, req, res, pathname, options);
  }
  if (!auth.isAuthenticated(db, req)) throw new HttpError(401, "Please log in");
  if (pathname === "/api/backup" && req.method === "GET") {
    return sendBackup(db, res);
  }
  const match = router.match(req.method, pathname);
  if (match === "method-not-allowed")
    throw new HttpError(405, "Method not allowed");
  if (!match) throw new HttpError(404, "Not found");
  const body = req.method === "GET" ? {} : await readJson(req);
  const query = Object.fromEntries(url.searchParams);
  const result = match.handler({ db, params: match.params, query, body });
  if (result?.raw) {
    const safeName = result.filename.replace(/[^\w.\- ]/g, "_");
    return send(res, 200, result.data, {
      "Content-Type": result.mime,
      "Content-Disposition": `inline; filename="${safeName}"`,
      "Cache-Control": "private, no-store",
    });
  }
  return sendJson(
    res,
    req.method === "POST" ? 201 : 200,
    result ?? { ok: true },
  );
}

export function createApp({ databasePath, secureCookies = false }) {
  const db = openDatabase(databasePath);
  const router = buildRouter();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname.startsWith("/api/")) {
        await handleApi(db, router, req, res, url, { secureCookies });
      } else if (req.method === "GET" || req.method === "HEAD") {
        serveStatic(req, res, url.pathname);
      } else {
        throw new HttpError(405, "Method not allowed");
      }
    } catch (error) {
      if (error instanceof HttpError) {
        sendJson(res, error.status, { error: error.message });
      } else {
        console.error(error);
        sendJson(res, 500, { error: "Something went wrong" });
      }
    }
  });
  server.on("close", () => db.close());
  return { server, db };
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.BOOKS_PORT ?? 4300);
  const host = process.env.BOOKS_HOST ?? "127.0.0.1";
  const databasePath = resolve(process.env.BOOKS_DB ?? "data/books.sqlite");
  mkdirSync(dirname(databasePath), { recursive: true });
  const { server } = createApp({
    databasePath,
    secureCookies: process.env.BOOKS_SECURE_COOKIES === "1",
  });
  server.listen(port, host, () => {
    console.log(`Books is running at http://${host}:${port}`);
    console.log(`Data file: ${databasePath}`);
  });
}
