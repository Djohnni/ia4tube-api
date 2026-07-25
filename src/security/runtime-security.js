"use strict";

const crypto = require("crypto");

function envFlag(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(raw).trim().toLowerCase());
}

function requireSecret(name, { minLength = 32, rejectedValues = [] } = {}) {
  const value = String(process.env[name] || "").trim();
  const rejected = new Set(rejectedValues.map((item) => String(item || "").trim()));

  if (!value || value.length < minLength || rejected.has(value)) {
    throw new Error(
      `Configuracao segura obrigatoria ausente ou invalida: ${name} deve possuir pelo menos ${minLength} caracteres.`
    );
  }

  return value;
}

function configuredSecrets(...names) {
  return [...new Set(
    names
      .map((name) => String(process.env[name] || "").trim())
      .filter(Boolean)
  )];
}

function timingSafeSecretMatch(candidate, acceptedSecrets = []) {
  const candidateBuffer = Buffer.from(String(candidate || ""), "utf8");

  return acceptedSecrets.some((secret) => {
    const secretBuffer = Buffer.from(String(secret || ""), "utf8");
    if (candidateBuffer.length !== secretBuffer.length) return false;
    return crypto.timingSafeEqual(candidateBuffer, secretBuffer);
  });
}

function requestIsHttps(req) {
  if (req.secure) return true;
  const forwarded = String(req.headers["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim()
    .toLowerCase();
  return forwarded === "https";
}

function requestIsLoopback(req) {
  const address = String(req.socket?.remoteAddress || "")
    .trim()
    .toLowerCase();
  return address === "::1" || address === "127.0.0.1" || address === "::ffff:127.0.0.1";
}

function createHttpsEnforcement({ enabled, allowLocalHttp } = {}) {
  const shouldEnforce = enabled ?? envFlag(
    "HTTPS_ENFORCE",
    String(process.env.NODE_ENV || "").toLowerCase() === "production"
  );
  const mayUseLocalHttp = allowLocalHttp ?? envFlag(
    "HTTPS_ALLOW_LOCAL_HTTP",
    String(process.env.NODE_ENV || "").toLowerCase() !== "production"
  );

  return function enforceHttps(req, res, next) {
    if (
      !shouldEnforce ||
      requestIsHttps(req) ||
      (mayUseLocalHttp && requestIsLoopback(req))
    ) {
      return next();
    }

    if (["GET", "HEAD"].includes(req.method)) {
      const host = String(req.get("host") || "").replace(/[\r\n]/g, "");
      if (!host) {
        return res.status(426).json({
          ok: false,
          code: "https_required",
          error: "Conexao segura HTTPS obrigatoria."
        });
      }
      return res.redirect(308, `https://${host}${req.originalUrl || req.url || "/"}`);
    }

    return res.status(426).json({
      ok: false,
      code: "https_required",
      error: "Conexao segura HTTPS obrigatoria."
    });
  };
}

function essentialSecurityHeaders(req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Resource-Policy", "same-site");
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=()");

  if (requestIsHttps(req)) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }

  return next();
}

function requestIp(req) {
  return String(req.ip || req.socket?.remoteAddress || "unknown").trim() || "unknown";
}

function createRateLimiter({
  windowMs,
  max,
  keyGenerator = requestIp,
  skipSuccessfulRequests = false,
  code = "rate_limit_exceeded",
  message = "Muitas tentativas. Aguarde alguns minutos e tente novamente."
}) {
  const entries = new Map();
  const safeWindowMs = Math.max(1000, Number(windowMs || 60_000));
  const safeMax = Math.max(1, Number(max || 10));
  let lastCleanupAt = 0;

  function cleanup(now) {
    if (now - lastCleanupAt < safeWindowMs) return;
    lastCleanupAt = now;
    for (const [key, entry] of entries.entries()) {
      if (entry.resetAt <= now) entries.delete(key);
    }
  }

  return function rateLimit(req, res, next) {
    const now = Date.now();
    cleanup(now);

    const key = String(keyGenerator(req) || "unknown");
    let entry = entries.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + safeWindowMs };
      entries.set(key, entry);
    }

    const retryAfterSeconds = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    res.setHeader("RateLimit-Limit", String(safeMax));
    res.setHeader("RateLimit-Remaining", String(Math.max(0, safeMax - entry.count)));
    res.setHeader("RateLimit-Reset", String(Math.ceil(entry.resetAt / 1000)));

    if (entry.count >= safeMax) {
      res.setHeader("Retry-After", String(retryAfterSeconds));
      return res.status(429).json({ ok: false, code, error: message });
    }

    entry.count += 1;
    res.setHeader("RateLimit-Remaining", String(Math.max(0, safeMax - entry.count)));

    if (skipSuccessfulRequests) {
      res.once("finish", () => {
        if (res.statusCode < 400) {
          const current = entries.get(key);
          if (!current) return;
          current.count = Math.max(0, current.count - 1);
          if (current.count === 0) entries.delete(key);
        }
      });
    }

    return next();
  };
}

module.exports = {
  configuredSecrets,
  createHttpsEnforcement,
  createRateLimiter,
  envFlag,
  essentialSecurityHeaders,
  requestIp,
  requestIsHttps,
  requestIsLoopback,
  requireSecret,
  timingSafeSecretMatch
};
