"use strict";

const crypto = require("crypto");

const DEFAULT_REJECTED_SECRETS = Object.freeze([
  "TROQUE_ISSO_AGORA",
  "change-me",
  "changeme",
  "secret",
  "password"
]);

function envFlag(name, fallback = false, env = process.env) {
  const raw = env?.[name];
  if (raw === undefined || raw === null || raw === "") return Boolean(fallback);
  return ["1", "true", "yes", "on"].includes(String(raw).trim().toLowerCase());
}

function requireSecret(name, {
  env = process.env,
  minLength = 32,
  rejectedValues = DEFAULT_REJECTED_SECRETS
} = {}) {
  const value = String(env?.[name] || "").trim();
  const rejected = new Set(
    [...DEFAULT_REJECTED_SECRETS, ...rejectedValues]
      .map((item) => String(item || "").trim().toLowerCase())
      .filter(Boolean)
  );

  if (
    !value ||
    value.length < Math.max(1, Number(minLength || 32)) ||
    rejected.has(value.toLowerCase())
  ) {
    const error = new Error(`Configuracao segura obrigatoria ausente ou invalida: ${name}`);
    error.code = "invalid_required_secret";
    throw error;
  }

  return value;
}

function configuredSecrets(...args) {
  let sourceEnv = process.env;
  let normalizedNames = args;
  const lastArgument = args.at(-1);
  if (
    lastArgument &&
    typeof lastArgument === "object" &&
    !Array.isArray(lastArgument) &&
    Object.hasOwn(lastArgument, "env")
  ) {
    sourceEnv = lastArgument.env || {};
    normalizedNames = args.slice(0, -1);
  }
  if (normalizedNames.length === 1 && Array.isArray(normalizedNames[0])) {
    normalizedNames = normalizedNames[0];
  }

  return [...new Set(
    normalizedNames
      .map((name) => String(sourceEnv?.[name] || "").trim())
      .filter(Boolean)
  )];
}

function timingSafeSecretMatch(candidate, acceptedSecrets = []) {
  const candidateBuffer = Buffer.from(String(candidate || ""), "utf8");
  if (!candidateBuffer.length) return false;

  return acceptedSecrets.some((secret) => {
    const secretBuffer = Buffer.from(String(secret || ""), "utf8");
    if (candidateBuffer.length !== secretBuffer.length) return false;
    return crypto.timingSafeEqual(candidateBuffer, secretBuffer);
  });
}

function normalizedRemoteAddress(req) {
  return String(
    req?.socket?.remoteAddress ||
    req?.connection?.remoteAddress ||
    ""
  ).trim().toLowerCase();
}

function requestIsLoopback(req) {
  const address = normalizedRemoteAddress(req);
  return address === "::1" ||
    address === "127.0.0.1" ||
    address === "::ffff:127.0.0.1";
}

function forwardedProto(req) {
  return String(req?.headers?.["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim()
    .toLowerCase();
}

function forwardedFor(req) {
  return String(req?.headers?.["x-forwarded-for"] || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function proxyIsTrusted(req, trustProxy) {
  if (trustProxy === "express") {
    return req?.secure === true;
  }
  if (typeof trustProxy === "function") {
    return trustProxy(normalizedRemoteAddress(req), req) === true;
  }
  return trustProxy === true;
}

function requestIsHttps(req, { trustProxy = false } = {}) {
  if (req?.socket?.encrypted === true) return true;
  if (trustProxy === "express") return req?.secure === true;
  if (!proxyIsTrusted(req, trustProxy)) return false;
  return forwardedProto(req) === "https";
}

function requestIp(req, {
  trustProxy = false,
  trustedProxyHops = 1
} = {}) {
  const directAddress = normalizedRemoteAddress(req) || "unknown";
  if (trustProxy === "express") {
    return String(req?.ip || directAddress).trim() || directAddress;
  }
  if (!proxyIsTrusted(req, trustProxy)) return directAddress;

  const chain = forwardedFor(req);
  if (!chain.length) return directAddress;
  const hops = Math.max(1, Math.floor(Number(trustedProxyHops || 1)));
  const index = Math.max(0, chain.length - hops);
  return chain[index] || directAddress;
}

function requireHttpsOrigin(name, rawValue) {
  const value = String(rawValue || "").trim();
  if (!value) return "";

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    const error = new Error(`Configuracao HTTPS invalida: ${name}`);
    error.code = "invalid_https_origin";
    throw error;
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname && parsed.pathname !== "/")
  ) {
    const error = new Error(`Configuracao HTTPS invalida: ${name}`);
    error.code = "invalid_https_origin";
    throw error;
  }

  return parsed.origin;
}

function createHttpsEnforcement({
  enabled = true,
  allowLocalHttp = false,
  trustProxy = false,
  canonicalOrigin = ""
} = {}) {
  const safeCanonicalOrigin = requireHttpsOrigin("canonicalOrigin", canonicalOrigin);

  return function enforceHttps(req, res, next) {
    if (
      !enabled ||
      requestIsHttps(req, { trustProxy }) ||
      (allowLocalHttp && requestIsLoopback(req))
    ) {
      return next();
    }

    if (safeCanonicalOrigin && ["GET", "HEAD"].includes(String(req?.method || "").toUpperCase())) {
      const requestPath = String(req?.originalUrl || req?.url || "/");
      const safePath = requestPath.startsWith("/") && !/[\r\n]/.test(requestPath)
        ? requestPath
        : "/";
      return res.redirect(308, `${safeCanonicalOrigin}${safePath}`);
    }

    return res.status(426).json({
      ok: false,
      code: "https_required",
      error: "Conexao segura HTTPS obrigatoria."
    });
  };
}

function createEssentialSecurityHeaders({
  trustProxy = false,
  hstsMaxAgeSeconds = 31_536_000,
  includeSubDomains = true,
  contentSecurityPolicy = "",
  crossOriginResourcePolicy = "same-origin"
} = {}) {
  const safeMaxAge = Math.max(0, Math.floor(Number(hstsMaxAgeSeconds || 0)));
  const safeResourcePolicy = new Set(["same-origin", "same-site", "cross-origin"])
    .has(crossOriginResourcePolicy)
    ? crossOriginResourcePolicy
    : "same-origin";

  return function essentialSecurityHeaders(req, res, next) {
    if (typeof res.removeHeader === "function") {
      res.removeHeader("X-Powered-By");
    }
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cross-Origin-Resource-Policy", safeResourcePolicy);
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Permissions-Policy", "camera=(), geolocation=(), microphone=()");

    if (contentSecurityPolicy) {
      res.setHeader("Content-Security-Policy", String(contentSecurityPolicy));
    }

    if (safeMaxAge > 0 && requestIsHttps(req, { trustProxy })) {
      const subdomains = includeSubDomains ? "; includeSubDomains" : "";
      res.setHeader("Strict-Transport-Security", `max-age=${safeMaxAge}${subdomains}`);
    }

    return next();
  };
}

function essentialSecurityHeaders(req, res, next) {
  return createEssentialSecurityHeaders()(req, res, next);
}

function createInMemoryRateLimitStore({
  clock = Date.now,
  maxEntries = 10_000
} = {}) {
  const entries = new Map();
  const safeMaxEntries = Math.max(100, Math.floor(Number(maxEntries || 10_000)));

  function cleanup(now = Number(clock())) {
    for (const [key, entry] of entries.entries()) {
      if (!entry || entry.resetAt <= now) entries.delete(key);
    }
  }

  function ensureCapacity(now) {
    if (entries.size < safeMaxEntries) return;
    cleanup(now);
    if (entries.size < safeMaxEntries) return;
    const error = new Error("Rate limit store capacity reached.");
    error.code = "rate_limit_store_capacity";
    throw error;
  }

  return Object.freeze({
    increment(key, { windowMs, now = Number(clock()) } = {}) {
      const normalizedKey = String(key || "unknown");
      const safeWindowMs = Math.max(1_000, Number(windowMs || 60_000));
      let entry = entries.get(normalizedKey);

      if (!entry || entry.resetAt <= now) {
        if (entry) entries.delete(normalizedKey);
        ensureCapacity(now);
        entry = { count: 0, resetAt: now + safeWindowMs };
        entries.set(normalizedKey, entry);
      }

      entry.count += 1;
      return { count: entry.count, resetAt: entry.resetAt };
    },

    decrement(key) {
      const normalizedKey = String(key || "unknown");
      const entry = entries.get(normalizedKey);
      if (!entry) return;
      entry.count = Math.max(0, entry.count - 1);
      if (entry.count === 0) entries.delete(normalizedKey);
    },

    reset(key) {
      entries.delete(String(key || "unknown"));
    },

    cleanup,

    size() {
      return entries.size;
    }
  });
}

function createRateLimiter({
  windowMs = 60_000,
  max = 10,
  keyGenerator = (req) => requestIp(req),
  skipSuccessfulRequests = false,
  code = "rate_limit_exceeded",
  message = "Muitas tentativas. Aguarde alguns minutos e tente novamente.",
  store = createInMemoryRateLimitStore(),
  clock = Date.now,
  failClosed = true
} = {}) {
  if (!store || typeof store.increment !== "function") {
    throw new TypeError("Rate limit store invalido.");
  }

  const safeWindowMs = Math.max(1_000, Number(windowMs || 60_000));
  const safeMax = Math.max(1, Math.floor(Number(max || 10)));

  return function rateLimit(req, res, next) {
    let key;
    let result;
    try {
      key = String(keyGenerator(req) || "unknown");
      result = store.increment(key, {
        windowMs: safeWindowMs,
        now: Number(clock())
      });
    } catch {
      if (!failClosed) return next();
      return res.status(503).json({
        ok: false,
        code: "rate_limit_unavailable",
        error: "Protecao temporariamente indisponivel."
      });
    }

    const count = Math.max(0, Number(result?.count || 0));
    const resetAt = Math.max(Number(clock()), Number(result?.resetAt || 0));
    const retryAfterSeconds = Math.max(1, Math.ceil((resetAt - Number(clock())) / 1_000));
    res.setHeader("RateLimit-Limit", String(safeMax));
    res.setHeader("RateLimit-Remaining", String(Math.max(0, safeMax - count)));
    res.setHeader("RateLimit-Reset", String(Math.ceil(resetAt / 1_000)));

    if (count > safeMax) {
      res.setHeader("Retry-After", String(retryAfterSeconds));
      return res.status(429).json({ ok: false, code, error: message });
    }

    if (
      skipSuccessfulRequests &&
      typeof store.decrement === "function" &&
      typeof res.once === "function"
    ) {
      res.once("finish", () => {
        if (res.statusCode < 400) store.decrement(key);
      });
    }

    return next();
  };
}

function createConcurrencyLimiter({
  maxGlobal = 4,
  maxPerKey = 1,
  keyGenerator = () => "global",
  code = "concurrency_limit_exceeded",
  message = "Ja existe uma operacao semelhante em andamento."
} = {}) {
  const safeGlobal = Math.max(1, Math.floor(Number(maxGlobal || 4)));
  const safePerKey = Math.max(1, Math.floor(Number(maxPerKey || 1)));
  const activeByKey = new Map();
  let activeTotal = 0;

  return function concurrencyLimit(req, res, next) {
    let key;
    try {
      key = String(keyGenerator(req) || "unknown");
    } catch {
      return res.status(503).json({
        ok: false,
        code: "concurrency_limit_unavailable",
        error: "Protecao temporariamente indisponivel."
      });
    }

    const activeForKey = Number(activeByKey.get(key) || 0);
    if (activeTotal >= safeGlobal || activeForKey >= safePerKey) {
      res.setHeader("Retry-After", "5");
      return res.status(429).json({ ok: false, code, error: message });
    }
    if (typeof res.once !== "function") {
      return res.status(503).json({
        ok: false,
        code: "concurrency_limit_unavailable",
        error: "Protecao temporariamente indisponivel."
      });
    }

    activeTotal += 1;
    activeByKey.set(key, activeForKey + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      activeTotal = Math.max(0, activeTotal - 1);
      const remaining = Math.max(0, Number(activeByKey.get(key) || 0) - 1);
      if (remaining) activeByKey.set(key, remaining);
      else activeByKey.delete(key);
    };
    res.once("finish", release);
    res.once("close", release);

    try {
      return next();
    } catch (error) {
      release();
      throw error;
    }
  };
}

module.exports = {
  DEFAULT_REJECTED_SECRETS,
  configuredSecrets,
  createConcurrencyLimiter,
  createEssentialSecurityHeaders,
  createHttpsEnforcement,
  createInMemoryRateLimitStore,
  createRateLimiter,
  envFlag,
  essentialSecurityHeaders,
  forwardedFor,
  forwardedProto,
  requestIp,
  requestIsHttps,
  requestIsLoopback,
  requireHttpsOrigin,
  requireSecret,
  timingSafeSecretMatch
};
