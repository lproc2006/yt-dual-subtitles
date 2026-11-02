import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const TOKEN_PATTERN = /^[0-9a-f]{48}$/;

export function loadOrCreateAccessToken(file) {
  let existing = "";
  try {
    existing = fs.readFileSync(file, "utf8").trim();
  } catch {
    existing = "";
  }
  const token = TOKEN_PATTERN.test(existing) ? existing : crypto.randomBytes(24).toString("hex");
  if (token !== existing) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  }
  try { fs.chmodSync(file, 0o600); } catch { /* ignore */ }
  return token;
}

export function pairResponseHeaders(origin) {
  const value = String(origin || "");
  const headers = {
    "Content-Type": "application/json;charset=utf-8",
    "Cache-Control": "no-store",
  };
  if (value.startsWith("chrome-extension://")) {
    headers["Access-Control-Allow-Origin"] = value;
    headers.Vary = "Origin";
    return { status: 200, headers };
  }
  if (!value) return { status: 200, headers };
  return { status: 403, headers };
}
