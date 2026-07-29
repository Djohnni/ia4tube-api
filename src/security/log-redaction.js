"use strict";

const REDACTED = "[REDACTED]";
const TRUNCATED = "[TRUNCATED]";
const CIRCULAR = "[CIRCULAR]";

const SENSITIVE_KEY_PARTS = Object.freeze([
  "authorization",
  "proxy-authorization",
  "access_token",
  "refresh_token",
  "id_token",
  "oauth_code",
  "authorization_code",
  "token",
  "client_secret",
  "api_key",
  "apikey",
  "jwt",
  "password",
  "senha",
  "secret",
  "signature",
  "private_key",
  "fcm_token",
  "bot_token",
  "cookie",
  "set-cookie",
  "oauth_state",
  "state_token",
  "state",
  "code_verifier",
  "pkce_verifier",
  "nonce",
  "whatsapp",
  "telefone",
  "phone",
  "email",
  "cpf",
  "cnpj"
]);

const SENSITIVE_QUERY_NAME =
  "(?:access_token|refresh_token|id_token|code|code_verifier|pkce_verifier|client_secret|api_key|apikey|password|senha|token|sig|signature|state|nonce)";

const SENSITIVE_TEXT_KEY =
  "(?:authorization|proxy-authorization|access_token|refresh_token|id_token|oauth_code|authorization_code|token|client_secret|api_key|apikey|jwt|password|senha|secret|signature|private_key|fcm_token|bot_token|cookie|set-cookie|oauth_state|state_token|state|code_verifier|pkce_verifier|nonce|whatsapp|telefone|phone|email|cpf|cnpj)";

function isSensitiveKey(key) {
  const normalized = String(key || "").trim().toLowerCase();
  return Boolean(normalized) &&
    SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part));
}

function redactString(value) {
  return String(value ?? "")
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
      REDACTED
    )
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, (match) => {
      const scheme = match.slice(0, match.indexOf(" "));
      return `${scheme} ${REDACTED}`;
    })
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, REDACTED)
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}\b/g, REDACTED)
    .replace(
      new RegExp(`([?&]${SENSITIVE_QUERY_NAME}=)[^&#\\s]*`, "gi"),
      `$1${encodeURIComponent(REDACTED)}`
    )
    .replace(
      new RegExp(`(["']${SENSITIVE_TEXT_KEY}["']\\s*:\\s*["'])[^"']*(["'])`, "gi"),
      `$1${REDACTED}$2`
    )
    .replace(
      new RegExp(`(^|[\\s,;])(${SENSITIVE_TEXT_KEY})\\s*[=:]\\s*([^\\s,;]+)`, "gi"),
      `$1$2=${REDACTED}`
    );
}

function redactLogValue(value, seen = new WeakSet(), depth = 0) {
  if (typeof value === "string") return redactString(value);
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  if (depth > 8) return TRUNCATED;
  if (seen.has(value)) return CIRCULAR;
  seen.add(value);

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      stack: redactString(value.stack || ""),
      code: value.code
    };
  }

  if (Buffer.isBuffer(value)) return `[BUFFER ${value.length} bytes]`;
  if (Array.isArray(value)) {
    return value.map((item) => redactLogValue(item, seen, depth + 1));
  }
  if (value instanceof Date) return value.toISOString();

  return Object.entries(value).reduce((safe, [key, item]) => {
    safe[key] = isSensitiveKey(key)
      ? REDACTED
      : redactLogValue(item, seen, depth + 1);
    return safe;
  }, {});
}

const installedConsoles = new WeakSet();

function installConsoleRedaction(targetConsole = console) {
  if (
    !targetConsole ||
    (typeof targetConsole !== "object" && typeof targetConsole !== "function") ||
    installedConsoles.has(targetConsole)
  ) {
    return targetConsole;
  }

  installedConsoles.add(targetConsole);

  for (const method of ["log", "info", "warn", "error", "debug"]) {
    const original = typeof targetConsole[method] === "function"
      ? targetConsole[method].bind(targetConsole)
      : null;
    if (!original) continue;
    targetConsole[method] = (...args) => original(
      ...args.map((arg) => redactLogValue(arg))
    );
  }

  return targetConsole;
}

function createRedactingLogger(targetConsole = console) {
  const logger = {};
  for (const method of ["log", "info", "warn", "error", "debug"]) {
    const original = typeof targetConsole?.[method] === "function"
      ? targetConsole[method].bind(targetConsole)
      : () => {};
    logger[method] = (...args) => original(
      ...args.map((arg) => redactLogValue(arg))
    );
  }
  return Object.freeze(logger);
}

module.exports = {
  CIRCULAR,
  REDACTED,
  SENSITIVE_KEY_PARTS,
  TRUNCATED,
  createRedactingLogger,
  installConsoleRedaction,
  isSensitiveKey,
  redactLogValue,
  redactString
};
