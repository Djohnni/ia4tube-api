"use strict";

const crypto = require("crypto");
const { requireHttpsOrigin, requireSecret } = require("./runtime-security");

const ALLOWED_VARIANTS = new Set(["preview", "thumbnail"]);
const ORDER_MEDIA_PATH_PATTERN = /^\/pedidos\/([^/]+)\/(preview|thumbnail)$/i;
const SIGNATURE_VERSION = "ia4tube-order-media-v2";
const DEFAULT_TTL_SECONDS = 15 * 60;
const MAX_TTL_SECONDS = 7 * 24 * 60 * 60;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

function normalizedMediaBaseUrl(rawValue, { allowLoopbackHttp = false } = {}) {
  const value = String(rawValue || "").trim();
  if (/^https:\/\//i.test(value)) {
    return requireHttpsOrigin("baseUrl", value);
  }
  if (allowLoopbackHttp) {
    const parsed = new URL(value);
    if (
      parsed.protocol === "http:" &&
      ["127.0.0.1", "localhost"].includes(parsed.hostname) &&
      !parsed.username &&
      !parsed.password
    ) {
      return parsed.origin;
    }
  }
  const error = new Error("Base HTTPS obrigatoria para URL de midia.");
  error.code = "invalid_https_origin";
  throw error;
}

function normalizeVariant(value, allowedVariants = ALLOWED_VARIANTS) {
  const variant = String(value || "").trim().toLowerCase();
  return allowedVariants.has(variant) ? variant : "";
}

function normalizeOpaqueIdentifier(value, label = "identifier") {
  const identifier = String(value ?? "").trim();
  if (
    !identifier ||
    identifier.length > 200 ||
    identifier === "." ||
    identifier === ".." ||
    /[\/\\?#\u0000-\u001f\u007f]/.test(identifier)
  ) {
    const error = new Error(`Identificador invalido: ${label}`);
    error.code = "invalid_media_identifier";
    throw error;
  }
  return identifier;
}

function safeTtlSeconds(value, fallback = DEFAULT_TTL_SECONDS, maximum = MAX_TTL_SECONDS) {
  const fallbackNumber = Number(fallback);
  const safeFallback = Number.isFinite(fallbackNumber)
    ? Math.max(1, Math.min(Math.floor(fallbackNumber), maximum))
    : DEFAULT_TTL_SECONDS;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return safeFallback;
  return Math.max(1, Math.min(Math.floor(parsed), maximum));
}

function normalizeNonce(value) {
  const nonce = String(value || "").trim();
  if (!NONCE_PATTERN.test(nonce)) {
    const error = new Error("Nonce de midia invalido.");
    error.code = "invalid_media_nonce";
    throw error;
  }
  return nonce;
}

function signaturePayload({ owner, orderId, variant, nonce, expiresAt }) {
  return [
    SIGNATURE_VERSION,
    owner,
    orderId,
    variant,
    nonce,
    String(expiresAt)
  ].join("\n");
}

function deriveSigningKey(secret) {
  return crypto
    .createHmac("sha256", Buffer.from(secret, "utf8"))
    .update(`${SIGNATURE_VERSION}:signing-key`)
    .digest();
}

function deriveOwnerContextKey(secret) {
  return crypto
    .createHmac("sha256", Buffer.from(secret, "utf8"))
    .update(`${SIGNATURE_VERSION}:owner-context-key`)
    .digest();
}

function createInMemoryNonceStore({ clock = Date.now, maxEntries = 20_000 } = {}) {
  const consumed = new Map();
  const safeMaxEntries = Math.max(100, Math.floor(Number(maxEntries || 20_000)));

  function cleanup(nowSeconds = Math.floor(Number(clock()) / 1_000)) {
    for (const [key, expiresAt] of consumed.entries()) {
      if (!Number.isSafeInteger(expiresAt) || expiresAt <= nowSeconds) {
        consumed.delete(key);
      }
    }
  }

  return Object.freeze({
    consume(key, expiresAt, now = Number(clock())) {
      const normalizedKey = String(key || "");
      const normalizedExpiration = Number(expiresAt);
      const nowSeconds = Math.floor(Number(now) / 1_000);
      if (
        !normalizedKey ||
        !Number.isSafeInteger(normalizedExpiration) ||
        normalizedExpiration < nowSeconds
      ) {
        return false;
      }

      cleanup(nowSeconds);
      if (consumed.has(normalizedKey)) return false;

      if (consumed.size >= safeMaxEntries) {
        return false;
      }

      consumed.set(normalizedKey, normalizedExpiration);
      return true;
    },

    cleanup,

    size() {
      return consumed.size;
    }
  });
}

function createOrderMediaAccess({
  secret,
  env = process.env,
  secretName = "ORDER_MEDIA_SIGNING_SECRET",
  defaultTtlSeconds = DEFAULT_TTL_SECONDS,
  maxTtlSeconds = MAX_TTL_SECONDS,
  allowedVariants = ALLOWED_VARIANTS,
  nonceFactory = () => crypto.randomBytes(18).toString("base64url"),
  nonceStore = null,
  allowLoopbackHttp = false
} = {}) {
  const validatedSecret = secret === undefined
    ? requireSecret(secretName, { env })
    : requireSecret(secretName, { env: { [secretName]: secret } });
  const signingKey = deriveSigningKey(validatedSecret);
  const ownerContextKey = deriveOwnerContextKey(validatedSecret);
  const maximumTtl = safeTtlSeconds(maxTtlSeconds, MAX_TTL_SECONDS, MAX_TTL_SECONDS);
  const defaultTtl = safeTtlSeconds(defaultTtlSeconds, DEFAULT_TTL_SECONDS, maximumTtl);
  const variants = new Set(
    [...allowedVariants].map((value) => String(value || "").trim().toLowerCase()).filter(Boolean)
  );

  if (!variants.size) {
    throw new TypeError("Ao menos uma variante de midia deve ser permitida.");
  }
  if (nonceStore && typeof nonceStore.consume !== "function") {
    throw new TypeError("Nonce store invalido.");
  }

  function normalizeClaims({ owner, orderId, variant, nonce, expiresAt }) {
    const normalizedVariant = normalizeVariant(variant, variants);
    if (!normalizedVariant) {
      const error = new Error("Variante de midia invalida.");
      error.code = "invalid_media_variant";
      throw error;
    }

    const normalizedExpiration = Number(expiresAt);
    if (!Number.isSafeInteger(normalizedExpiration)) {
      const error = new Error("Expiracao de midia invalida.");
      error.code = "invalid_media_expiration";
      throw error;
    }

    return {
      owner: normalizeOpaqueIdentifier(owner, "owner"),
      orderId: normalizeOpaqueIdentifier(orderId, "orderId"),
      variant: normalizedVariant,
      nonce: normalizeNonce(nonce),
      expiresAt: normalizedExpiration
    };
  }

  function sign(claims) {
    return crypto
      .createHmac("sha256", signingKey)
      .update(signaturePayload(normalizeClaims(claims)))
      .digest("base64url");
  }

  function sealOwnerContext(owner) {
    const normalizedOwner = normalizeOpaqueIdentifier(owner, "owner");
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", ownerContextKey, iv);
    cipher.setAAD(Buffer.from(SIGNATURE_VERSION, "utf8"));
    const ciphertext = Buffer.concat([
      cipher.update(normalizedOwner, "utf8"),
      cipher.final()
    ]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, ciphertext]).toString("base64url");
  }

  function openOwnerContext(value) {
    try {
      const encoded = String(value || "");
      if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) return "";
      const packed = Buffer.from(encoded, "base64url");
      if (packed.toString("base64url") !== encoded) return "";
      if (packed.length < 29) return "";
      const iv = packed.subarray(0, 12);
      const tag = packed.subarray(12, 28);
      const ciphertext = packed.subarray(28);
      const decipher = crypto.createDecipheriv("aes-256-gcm", ownerContextKey, iv);
      decipher.setAAD(Buffer.from(SIGNATURE_VERSION, "utf8"));
      decipher.setAuthTag(tag);
      const owner = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final()
      ]).toString("utf8");
      return normalizeOpaqueIdentifier(owner, "owner");
    } catch {
      return "";
    }
  }

  function buildPath({
    owner,
    orderId,
    variant,
    ttlSeconds = defaultTtl,
    now = Date.now(),
    nonce = nonceFactory()
  }) {
    const nowNumber = Number(now);
    if (!Number.isFinite(nowNumber)) {
      throw new TypeError("Relogio invalido.");
    }
    const expiresAt = Math.floor(nowNumber / 1_000) +
      safeTtlSeconds(ttlSeconds, defaultTtl, maximumTtl);
    const claims = normalizeClaims({ owner, orderId, variant, nonce, expiresAt });
    const signature = sign(claims);
    const ownerContext = sealOwnerContext(claims.owner);

    return `/pedidos/${encodeURIComponent(claims.orderId)}/${claims.variant}` +
      `?exp=${claims.expiresAt}&nonce=${encodeURIComponent(claims.nonce)}` +
      `&ctx=${encodeURIComponent(ownerContext)}` +
      `&sig=${encodeURIComponent(signature)}`;
  }

  function buildUrl({ baseUrl, ...options }) {
    const safeBaseUrl = normalizedMediaBaseUrl(baseUrl, { allowLoopbackHttp });
    return `${safeBaseUrl}${buildPath(options)}`;
  }

  function verify({
    owner,
    orderId,
    variant,
    nonce,
    expiresAt,
    signature,
    now = Date.now()
  }) {
    try {
      const nowSeconds = Math.floor(Number(now) / 1_000);
      if (!Number.isSafeInteger(nowSeconds)) return false;

      const claims = normalizeClaims({ owner, orderId, variant, nonce, expiresAt });
      if (
        claims.expiresAt <= nowSeconds ||
        claims.expiresAt > nowSeconds + maximumTtl
      ) {
        return false;
      }

      const expected = Buffer.from(sign(claims), "utf8");
      const received = Buffer.from(String(signature || ""), "utf8");
      return received.length === expected.length &&
        crypto.timingSafeEqual(expected, received);
    } catch {
      return false;
    }
  }

  function verifyAndConsume(options) {
    if (!nonceStore || !verify(options)) return false;
    const claims = normalizeClaims(options);
    const replayKey = signaturePayload(claims);
    return nonceStore.consume(replayKey, claims.expiresAt, options.now);
  }

  function protectPayload(value, {
    owner,
    baseUrl,
    ttlSeconds = defaultTtl,
    now = Date.now(),
    buildMediaUrl = null
  } = {}, depth = 0) {
    if (depth > 12 || value === null || value === undefined) return value;
    if (Array.isArray(value)) {
      return value.map((item) => protectPayload(
        item,
        { owner, baseUrl, ttlSeconds, now, buildMediaUrl },
        depth + 1
      ));
    }
    if (typeof value !== "object") return value;

    return Object.entries(value).reduce((result, [key, item]) => {
      if (typeof item === "string") {
        let pathname = "";
        try {
          pathname = item.startsWith("/")
            ? new URL(item, "https://ia4tube.invalid").pathname
            : new URL(item).pathname;
        } catch {}

        const match = pathname.match(ORDER_MEDIA_PATH_PATTERN);
        if (match) {
          let decodedOrderId = "";
          try {
            decodedOrderId = decodeURIComponent(match[1]);
          } catch {
            result[key] = item;
            return result;
          }

          result[key] = typeof buildMediaUrl === "function"
            ? buildMediaUrl({
              baseUrl,
              owner,
              orderId: decodedOrderId,
              variant: match[2],
              ttlSeconds,
              now
            })
            : buildUrl({
              baseUrl,
              owner,
              orderId: decodedOrderId,
              variant: match[2],
              ttlSeconds,
              now
            });
          return result;
        }
      }

      result[key] = protectPayload(
        item,
        { owner, baseUrl, ttlSeconds, now, buildMediaUrl },
        depth + 1
      );
      return result;
    }, {});
  }

  return Object.freeze({
    buildPath,
    buildUrl,
    normalizeVariant: (value) => normalizeVariant(value, variants),
    openOwnerContext,
    protectPayload,
    sealOwnerContext,
    sign,
    verify,
    verifyAndConsume
  });
}

module.exports = {
  ALLOWED_VARIANTS,
  DEFAULT_TTL_SECONDS,
  MAX_TTL_SECONDS,
  NONCE_PATTERN,
  ORDER_MEDIA_PATH_PATTERN,
  SIGNATURE_VERSION,
  createInMemoryNonceStore,
  createOrderMediaAccess,
  normalizeOpaqueIdentifier,
  normalizeVariant,
  safeTtlSeconds
};
