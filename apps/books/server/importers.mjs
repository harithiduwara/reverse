// Parse bank statement files (CSV and OFX/QFX) into plain transactions.

import { createHash } from "node:crypto";
import { HttpError, isIsoDate } from "./http.mjs";
import { parseStatementAmount } from "./money.mjs";

const MAX_ROWS = 20000;

/** RFC 4180-style CSV parser (quoted fields, embedded commas/newlines). */
export function parseCsv(text, delimiter = ",") {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"' && field === "") {
      quoted = true;
    } else if (char === delimiter) {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field);
      if (row.some((cell) => cell.trim() !== "")) rows.push(row);
      row = [];
      field = "";
      if (rows.length > MAX_ROWS) throw new HttpError(400, "File is too large");
    } else {
      field += char;
    }
  }
  row.push(field);
  if (row.some((cell) => cell.trim() !== "")) rows.push(row);
  return rows;
}

export function detectDelimiter(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const counts = [",", ";", "\t"].map((d) => [d, firstLine.split(d).length]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][0];
}

export const DATE_FORMATS = ["YYYY-MM-DD", "MM/DD/YYYY", "DD/MM/YYYY"];

export function parseStatementDate(raw, format) {
  const text = String(raw ?? "").trim();
  let year;
  let month;
  let day;
  if (format === "YYYY-MM-DD") {
    [year, month, day] = text.split(/[-/.]/);
  } else if (format === "MM/DD/YYYY") {
    [month, day, year] = text.split(/[-/.]/);
  } else {
    [day, month, year] = text.split(/[-/.]/);
  }
  if (year?.length === 2) year = `20${year}`;
  const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return isIsoDate(iso) ? iso : null;
}

/** Guess which date format a column uses from sample values. */
export function guessDateFormat(values) {
  for (const format of DATE_FORMATS) {
    if (values.every((value) => parseStatementDate(value, format))) {
      return format;
    }
  }
  return DATE_FORMATS[0];
}

export function previewCsv(text) {
  const rows = parseCsv(text, detectDelimiter(text));
  if (rows.length === 0) throw new HttpError(400, "The file is empty");
  const headers = rows[0].map((h, i) => h.trim() || `Column ${i + 1}`);
  const lower = headers.map((h) => h.toLowerCase());
  const find = (...names) =>
    lower.findIndex((h) => names.some((name) => h.includes(name)));
  const dateColumn = find("date", "posted");
  const sample = rows.slice(1, 21);
  return {
    headers,
    rows: sample,
    total_rows: rows.length - 1,
    suggested: {
      date: dateColumn,
      description: find("description", "payee", "name", "memo", "details"),
      amount: find("amount"),
      debit: find("debit", "withdrawal", "money out"),
      credit: find("credit", "deposit", "money in"),
      date_format:
        dateColumn >= 0
          ? guessDateFormat(sample.map((r) => r[dateColumn]).filter(Boolean))
          : DATE_FORMATS[0],
    },
  };
}

function columnIndex(value, headers, name, required) {
  if (value === undefined || value === null || value === "" || value === -1) {
    if (required) throw new HttpError(400, `Choose the ${name} column`);
    return -1;
  }
  const index = Number(value);
  if (!Number.isInteger(index) || index < 0 || index >= headers.length) {
    throw new HttpError(400, `Invalid ${name} column`);
  }
  return index;
}

/** Map CSV rows to transactions using the column mapping the user chose. */
export function transactionsFromCsv(text, mapping) {
  const rows = parseCsv(text, detectDelimiter(text));
  const headers = rows[0] ?? [];
  const dateCol = columnIndex(mapping.date, headers, "date", true);
  const descCol = columnIndex(
    mapping.description,
    headers,
    "description",
    true,
  );
  const amountCol = columnIndex(mapping.amount, headers, "amount", false);
  const debitCol = columnIndex(mapping.debit, headers, "debit", false);
  const creditCol = columnIndex(mapping.credit, headers, "credit", false);
  if (amountCol < 0 && debitCol < 0 && creditCol < 0) {
    throw new HttpError(
      400,
      "Choose an amount column, or debit/credit columns",
    );
  }
  const format = DATE_FORMATS.includes(mapping.date_format)
    ? mapping.date_format
    : DATE_FORMATS[0];
  const transactions = [];
  const skipped = [];
  const seen = new Map();
  rows.slice(1).forEach((row, index) => {
    const date = parseStatementDate(row[dateCol], format);
    let amount = null;
    if (amountCol >= 0) {
      amount = parseStatementAmount(row[amountCol]);
      if (amount !== null && mapping.flip_sign) amount = -amount;
    } else {
      const out = parseStatementAmount(row[debitCol]) ?? 0;
      const into = parseStatementAmount(row[creditCol]) ?? 0;
      amount = Math.abs(into) - Math.abs(out);
    }
    const description = String(row[descCol] ?? "").trim() || "(no description)";
    if (!date || amount === null || amount === 0) {
      skipped.push({
        row: index + 2,
        reason: !date ? "bad date" : "no amount",
      });
      return;
    }
    // Same date/amount/description can repeat; count occurrences so a
    // re-import of the same file is recognized as duplicates.
    const base = `${date}|${amount}|${description.toLowerCase()}`;
    const occurrence = (seen.get(base) ?? 0) + 1;
    seen.set(base, occurrence);
    transactions.push({
      date,
      description: description.slice(0, 300),
      amount_cents: amount,
      fingerprint: `csv:${hash(`${base}|${occurrence}`)}`,
    });
  });
  return { transactions, skipped };
}

function ofxTag(block, tag) {
  const match = new RegExp(`<${tag}>([^<\\r\\n]*)`, "i").exec(block);
  return match ? match[1].trim() : "";
}

/** Parse OFX/QFX (SGML or XML flavours) statement transactions. */
export function transactionsFromOfx(text) {
  const blocks = text.split(/<STMTTRN>/i).slice(1);
  if (blocks.length === 0) {
    throw new HttpError(400, "No transactions found in the OFX file");
  }
  const transactions = [];
  const skipped = [];
  blocks.forEach((block, index) => {
    const posted = ofxTag(block, "DTPOSTED");
    const date = `${posted.slice(0, 4)}-${posted.slice(4, 6)}-${posted.slice(6, 8)}`;
    const amount = parseStatementAmount(ofxTag(block, "TRNAMT"));
    const name = ofxTag(block, "NAME");
    const memo = ofxTag(block, "MEMO");
    const description =
      [name, memo].filter(Boolean).join(" – ") || "(no description)";
    if (!isIsoDate(date) || !amount) {
      skipped.push({ row: index + 1, reason: "unreadable transaction" });
      return;
    }
    const fitid = ofxTag(block, "FITID");
    transactions.push({
      date,
      description: decodeEntities(description).slice(0, 300),
      amount_cents: amount,
      fingerprint: fitid
        ? `ofx:${fitid}`
        : `ofx:${hash(`${date}|${amount}|${description}|${index}`)}`,
    });
  });
  return { transactions, skipped };
}

function decodeEntities(text) {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function hash(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

export function looksLikeOfx(text) {
  return /<OFX>|OFXHEADER/i.test(text.slice(0, 2000));
}
