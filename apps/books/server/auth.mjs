// Single-user password login with server-side sessions.

import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { getSetting, setSetting } from "./db.mjs";
import { HttpError } from "./http.mjs";

const SESSION_DAYS = 30;
const COOKIE = "books_session";
const MIN_PASSWORD = 10;

function hashPassword(password, salt = randomBytes(16)) {
  const key = scryptSync(password, salt, 64);
  return `scrypt:${salt.toString("hex")}:${key.toString("hex")}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltHex, keyHex] = String(stored).split(":");
  if (scheme !== "scrypt" || !saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, "hex");
  const actual = scryptSync(
    password,
    Buffer.from(saltHex, "hex"),
    expected.length,
  );
  return timingSafeEqual(expected, actual);
}

function tokenHash(token) {
  return createHash("sha256").update(token).digest("hex");
}

function validatePassword(password) {
  if (typeof password !== "string" || password.length < MIN_PASSWORD) {
    throw new HttpError(
      400,
      `Password must be at least ${MIN_PASSWORD} characters`,
    );
  }
  if (password.length > 1000) throw new HttpError(400, "Password is too long");
}

export function isSetUp(db) {
  return Boolean(getSetting(db, "password_hash"));
}

export function setUpPassword(db, password) {
  if (isSetUp(db)) throw new HttpError(409, "A password is already set");
  validatePassword(password);
  setSetting(db, "password_hash", hashPassword(password));
}

export function changePassword(db, current, next) {
  if (!verifyPassword(String(current ?? ""), getSetting(db, "password_hash"))) {
    throw new HttpError(400, "Current password is incorrect");
  }
  validatePassword(next);
  setSetting(db, "password_hash", hashPassword(next));
  db.exec("DELETE FROM sessions");
}

// Slow down repeated wrong guesses (in memory; resets on restart).
let failedAttempts = 0;
let lockedUntil = 0;

export function login(db, password) {
  if (Date.now() < lockedUntil) {
    throw new HttpError(429, "Too many attempts. Try again in a minute.");
  }
  const stored = getSetting(db, "password_hash");
  if (!stored || !verifyPassword(String(password ?? ""), stored)) {
    failedAttempts += 1;
    if (failedAttempts >= 5) {
      lockedUntil = Date.now() + 60_000;
      failedAttempts = 0;
    }
    throw new HttpError(401, "Incorrect password");
  }
  failedAttempts = 0;
  return createSession(db);
}

export function createSession(db) {
  const token = randomBytes(32).toString("base64url");
  const expires = Date.now() + SESSION_DAYS * 86400000;
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(Date.now());
  db.prepare("INSERT INTO sessions (token_hash, expires_at) VALUES (?, ?)").run(
    tokenHash(token),
    expires,
  );
  return token;
}

export function logout(db, token) {
  if (token) {
    db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(
      tokenHash(token),
    );
  }
}

export function sessionToken(req) {
  const header = req.headers.cookie ?? "";
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE) return rest.join("=");
  }
  return null;
}

export function isAuthenticated(db, req) {
  const token = sessionToken(req);
  if (!token) return false;
  const row = db
    .prepare("SELECT expires_at FROM sessions WHERE token_hash = ?")
    .get(tokenHash(token));
  return Boolean(row && row.expires_at > Date.now());
}

export function sessionCookie(token, secure) {
  const attributes = [
    `${COOKIE}=${token}`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/",
    `Max-Age=${token ? SESSION_DAYS * 86400 : 0}`,
  ];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}
