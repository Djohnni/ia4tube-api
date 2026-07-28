"use strict";

const TOKEN_PATTERN = /^[^\s\u0000-\u001f\u007f]{1,4096}$/;
const REGISTER_FIELDS = new Set([
  "token",
  "platform",
  "previous_token"
]);
const DEACTIVATE_FIELDS = new Set([
  "token",
  "platform"
]);

class FcmTokenApiContractError extends Error {
  constructor(code) {
    super("Requisicao de dispositivo recusada por um contrato de seguranca.");
    this.name = "FcmTokenApiContractError";
    this.code = code;
  }
}

function fail(code) {
  throw new FcmTokenApiContractError(code);
}

function validateToken(value, field) {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    !TOKEN_PATTERN.test(value)
  ) {
    fail(`fcm_${field}_invalid`);
  }
  return value;
}

function validateBodyObject(body, allowedFields) {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some((field) => !allowedFields.has(field))
  ) {
    fail("fcm_token_request_invalid");
  }
  if (body.platform !== "android") {
    fail("fcm_token_platform_invalid");
  }
}

function parseRegisterFcmTokenBody(body) {
  validateBodyObject(body, REGISTER_FIELDS);
  const token = validateToken(body.token, "token");
  const previousToken = Object.hasOwn(body, "previous_token")
    ? validateToken(body.previous_token, "previous_token")
    : "";
  return Object.freeze({
    token,
    platform: "android",
    previousToken
  });
}

function parseDeactivateFcmTokenBody(body) {
  validateBodyObject(body, DEACTIVATE_FIELDS);
  return Object.freeze({
    token: validateToken(body.token, "token"),
    platform: "android"
  });
}

module.exports = {
  FcmTokenApiContractError,
  parseDeactivateFcmTokenBody,
  parseRegisterFcmTokenBody
};
