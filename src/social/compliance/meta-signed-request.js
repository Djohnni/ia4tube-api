"use strict";

const crypto = require("node:crypto");
const { complianceFail } = require("./errors");

const META_SIGNED_REQUEST_ALGORITHM = "HMAC-SHA256";
const META_SIGNED_REQUEST_MAX_LENGTH = 16 * 1024;
const META_SIGNED_REQUEST_MAX_PAYLOAD_BYTES = 12 * 1024;
const META_SIGNED_REQUEST_SIGNATURE_BYTES = 32;
const META_EXTERNAL_USER_ID_PATTERN = /^[0-9]{1,64}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

function strictBase64urlDecode(value, maxBytes, failureCode) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    !BASE64URL_PATTERN.test(value)
  ) {
    complianceFail(failureCode);
  }

  let decoded;
  try {
    decoded = Buffer.from(value, "base64url");
  } catch {
    complianceFail(failureCode);
  }
  if (
    decoded.length < 1 ||
    decoded.length > maxBytes ||
    decoded.toString("base64url") !== value
  ) {
    decoded.fill(0);
    complianceFail(failureCode);
  }
  return decoded;
}

function requireAppSecret(value) {
  let bytes;
  if (Buffer.isBuffer(value)) {
    bytes = Buffer.from(value);
  } else if (typeof value === "string") {
    bytes = Buffer.from(value, "utf8");
  } else {
    complianceFail("meta_compliance_configuration_invalid", 503);
  }
  if (bytes.length < 16 || bytes.length > 4096) {
    bytes.fill(0);
    complianceFail("meta_compliance_configuration_invalid", 503);
  }
  return bytes;
}

function createMetaSignedRequestVerifier(options = {}) {
  const secret = requireAppSecret(options.appSecret);
  const clock = options.clock || Date.now;
  const maxAgeSeconds = options.maxAgeSeconds ?? 24 * 60 * 60;
  const futureSkewSeconds = options.futureSkewSeconds ?? 60;
  if (
    typeof clock !== "function" ||
    !Number.isSafeInteger(maxAgeSeconds) ||
    maxAgeSeconds < 60 ||
    maxAgeSeconds > 7 * 24 * 60 * 60 ||
    !Number.isSafeInteger(futureSkewSeconds) ||
    futureSkewSeconds < 0 ||
    futureSkewSeconds > 5 * 60
  ) {
    secret.fill(0);
    complianceFail("meta_compliance_configuration_invalid", 503);
  }

  let destroyed = false;

  function verify(signedRequest) {
    if (destroyed) {
      complianceFail("meta_compliance_configuration_invalid", 503);
    }
    if (
      typeof signedRequest !== "string" ||
      signedRequest.length < 3 ||
      signedRequest.length > META_SIGNED_REQUEST_MAX_LENGTH
    ) {
      complianceFail("meta_signed_request_invalid");
    }
    const segments = signedRequest.split(".");
    if (segments.length !== 2) {
      complianceFail("meta_signed_request_invalid");
    }
    const [encodedSignature, encodedPayload] = segments;
    const signature = strictBase64urlDecode(
      encodedSignature,
      META_SIGNED_REQUEST_SIGNATURE_BYTES,
      "meta_signed_request_signature_invalid"
    );
    let expected;
    try {
      expected = crypto.createHmac("sha256", secret)
        .update(encodedPayload, "ascii")
        .digest();
      if (
        signature.length !== META_SIGNED_REQUEST_SIGNATURE_BYTES ||
        expected.length !== META_SIGNED_REQUEST_SIGNATURE_BYTES ||
        !crypto.timingSafeEqual(signature, expected)
      ) {
        complianceFail("meta_signed_request_signature_invalid", 401);
      }
    } finally {
      signature.fill(0);
      if (expected) expected.fill(0);
    }

    const payloadBytes = strictBase64urlDecode(
      encodedPayload,
      META_SIGNED_REQUEST_MAX_PAYLOAD_BYTES,
      "meta_signed_request_invalid"
    );
    let payload;
    try {
      payload = JSON.parse(payloadBytes.toString("utf8"));
    } catch {
      complianceFail("meta_signed_request_invalid");
    } finally {
      payloadBytes.fill(0);
    }
    if (
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload) ||
      Object.getPrototypeOf(payload) !== Object.prototype ||
      payload.algorithm !== META_SIGNED_REQUEST_ALGORITHM ||
      !META_EXTERNAL_USER_ID_PATTERN.test(payload.user_id || "") ||
      !Number.isSafeInteger(payload.issued_at) ||
      payload.issued_at < 1
    ) {
      complianceFail("meta_signed_request_invalid");
    }

    const nowMs = Number(clock());
    if (!Number.isFinite(nowMs) || nowMs < 1) {
      complianceFail("meta_compliance_configuration_invalid", 503);
    }
    const nowSeconds = Math.floor(nowMs / 1000);
    if (payload.issued_at > nowSeconds + futureSkewSeconds) {
      complianceFail("meta_signed_request_not_yet_valid", 401);
    }
    if (nowSeconds - payload.issued_at > maxAgeSeconds) {
      complianceFail("meta_signed_request_expired", 401);
    }

    const requestDigest = crypto.createHash("sha256")
      .update("ia4tube-meta-signed-request-v1\0", "utf8")
      .update(signedRequest, "ascii")
      .digest("hex");
    return Object.freeze({
      provider: "instagram",
      externalUserId: payload.user_id,
      issuedAt: new Date(payload.issued_at * 1000).toISOString(),
      requestDigest
    });
  }

  function destroy() {
    if (!destroyed) secret.fill(0);
    destroyed = true;
  }

  return Object.freeze({ verify, destroy });
}

module.exports = {
  META_EXTERNAL_USER_ID_PATTERN,
  META_SIGNED_REQUEST_ALGORITHM,
  META_SIGNED_REQUEST_MAX_LENGTH,
  createMetaSignedRequestVerifier
};
