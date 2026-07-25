"use strict";

const crypto = require("crypto");

const ALLOWED_VARIANTS = new Set(["preview", "thumbnail"]);
const ORDER_MEDIA_PATH_PATTERN = /^\/pedidos\/([^/]+)\/(preview|thumbnail)$/i;

function normalizeVariant(value) {
  const variant = String(value || "").trim().toLowerCase();
  return ALLOWED_VARIANTS.has(variant) ? variant : "";
}

function safeTtlSeconds(value, fallback = 900) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(Math.floor(parsed), 7 * 24 * 60 * 60));
}

function signaturePayload({ owner, orderId, variant, expiresAt }) {
  return [
    "ia4tube-order-media-v1",
    String(owner || ""),
    String(orderId || ""),
    String(variant || ""),
    String(expiresAt || "")
  ].join("\n");
}

function deriveSigningKey(secret) {
  return crypto
    .createHmac("sha256", Buffer.from(String(secret || ""), "utf8"))
    .update("ia4tube-order-media-signing-key-v1")
    .digest();
}

function createOrderMediaAccess({ secret, defaultTtlSeconds = 900 } = {}) {
  const signingKey = deriveSigningKey(secret);
  const defaultTtl = safeTtlSeconds(defaultTtlSeconds, 900);

  function sign({ owner, orderId, variant, expiresAt }) {
    return crypto
      .createHmac("sha256", signingKey)
      .update(signaturePayload({ owner, orderId, variant, expiresAt }))
      .digest("base64url");
  }

  function buildPath({ owner, orderId, variant, ttlSeconds = defaultTtl, now = Date.now() }) {
    const normalizedVariant = normalizeVariant(variant);
    if (!owner || !orderId || !normalizedVariant) {
      throw new Error("Nao foi possivel preparar uma URL protegida para a imagem.");
    }

    const expiresAt = Math.floor(now / 1000) + safeTtlSeconds(ttlSeconds, defaultTtl);
    const signature = sign({
      owner,
      orderId,
      variant: normalizedVariant,
      expiresAt
    });

    return `/pedidos/${encodeURIComponent(orderId)}/${normalizedVariant}?exp=${expiresAt}&sig=${encodeURIComponent(signature)}`;
  }

  function buildUrl({ baseUrl, ...options }) {
    const cleanBaseUrl = String(baseUrl || "").replace(/\/+$/, "");
    return `${cleanBaseUrl}${buildPath(options)}`;
  }

  function verify({ owner, orderId, variant, expiresAt, signature, now = Date.now() }) {
    const normalizedVariant = normalizeVariant(variant);
    const normalizedExpiration = Number(expiresAt);
    if (
      !owner ||
      !orderId ||
      !normalizedVariant ||
      !Number.isSafeInteger(normalizedExpiration) ||
      normalizedExpiration < Math.floor(now / 1000) ||
      !signature
    ) {
      return false;
    }

    const expected = Buffer.from(sign({
      owner,
      orderId,
      variant: normalizedVariant,
      expiresAt: normalizedExpiration
    }), "utf8");
    const received = Buffer.from(String(signature), "utf8");
    return expected.length === received.length && crypto.timingSafeEqual(expected, received);
  }

  function protectPayload(value, {
    owner,
    baseUrl,
    ttlSeconds = defaultTtl,
    now = Date.now()
  } = {}, depth = 0) {
    if (depth > 12 || value === null || value === undefined) return value;
    if (Array.isArray(value)) {
      return value.map((item) => protectPayload(item, { owner, baseUrl, ttlSeconds, now }, depth + 1));
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
          result[key] = buildUrl({
            baseUrl,
            owner,
            orderId: decodeURIComponent(match[1]),
            variant: match[2],
            ttlSeconds,
            now
          });
          return result;
        }
      }

      result[key] = protectPayload(item, { owner, baseUrl, ttlSeconds, now }, depth + 1);
      return result;
    }, {});
  }

  return {
    buildPath,
    buildUrl,
    normalizeVariant,
    protectPayload,
    verify
  };
}

module.exports = {
  ALLOWED_VARIANTS,
  ORDER_MEDIA_PATH_PATTERN,
  createOrderMediaAccess,
  normalizeVariant,
  safeTtlSeconds
};
