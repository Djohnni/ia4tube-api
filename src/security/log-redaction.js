"use strict";

const REDACTED = "[REDACTED]";
const SENSITIVE_KEY_PARTS = [
  "authorization",
  "access_token",
  "refresh_token",
  "id_token",
  "oauth_code",
  "authorization_code",
  "client_secret",
  "jwt",
  "password",
  "senha",
  "secret",
  "signature",
  "private_key",
  "encryption_key",
  "hmac_key",
  "fcm_token",
  "bot_token"
];
const SENSITIVE_EXACT_KEYS = new Set([
  "token",
  "iv",
  "tag",
  "ciphertext",
  "fingerprint"
]);

function isSensitiveKey(key) {
  const normalized = String(key || "").trim().toLowerCase();
  return Boolean(normalized) && (
    SENSITIVE_EXACT_KEYS.has(normalized) ||
    SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part))
  );
}

function redactString(value) {
  return String(value || "")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, REDACTED)
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, REDACTED)
    .replace(
      /([?&](?:access_token|refresh_token|id_token|code|client_secret|password|senha|token|sig|signature)=)[^&#\s]*/gi,
      `$1${encodeURIComponent(REDACTED)}`
    );
}

function redactLogValue(value, seen = new WeakSet(), depth = 0) {
  if (typeof value === "string") return redactString(value);
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  if (depth > 8) return "[TRUNCATED]";
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      stack: redactString(value.stack || "")
    };
  }

  if (Buffer.isBuffer(value)) return `[BUFFER ${value.length} bytes]`;
  if (Array.isArray(value)) {
    return value.map((item) => redactLogValue(item, seen, depth + 1));
  }

  return Object.entries(value).reduce((safe, [key, item]) => {
    safe[key] = isSensitiveKey(key)
      ? REDACTED
      : redactLogValue(item, seen, depth + 1);
    return safe;
  }, {});
}

let installed = false;

function installConsoleRedaction(targetConsole = console) {
  if (installed) return;
  installed = true;

  for (const method of ["log", "info", "warn", "error", "debug"]) {
    const original = targetConsole[method]?.bind(targetConsole);
    if (!original) continue;
    targetConsole[method] = (...args) => original(...args.map((arg) => redactLogValue(arg)));
  }
}

module.exports = {
  REDACTED,
  installConsoleRedaction,
  isSensitiveKey,
  redactLogValue,
  redactString
};
