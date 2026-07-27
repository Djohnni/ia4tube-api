"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { atomicWriteJson } = require("./fcm-token-store");

const FORMAT_VERSION = 1;
const EVENT_TYPE = "art_ready";
const EVENT_STATES = new Set(["prepared", "blocked", "sent", "failed"]);
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const FINGERPRINT_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[a-f0-9]{64}$/;

class ArtReadyOutboxError extends Error {
  constructor(code) {
    super("Operacao de notificacao recusada por uma regra de seguranca.");
    this.name = "ArtReadyOutboxError";
    this.code = code;
  }
}

function fail(code) {
  throw new ArtReadyOutboxError(code);
}

function validateSafeId(value, code) {
  const normalized = String(value || "").trim();
  if (!SAFE_ID_PATTERN.test(normalized)) fail(code);
  return normalized;
}

function validateFingerprint(value) {
  const normalized = String(value || "").trim();
  if (!FINGERPRINT_PATTERN.test(normalized)) {
    fail("art_ready_token_fingerprint_invalid");
  }
  return normalized;
}

function idempotencyKey({
  eventType = EVENT_TYPE,
  generationId,
  tokenFingerprint
}) {
  const normalizedEventType = validateSafeId(
    eventType,
    "art_ready_event_type_invalid"
  );
  const normalizedGenerationId = validateSafeId(
    generationId,
    "art_ready_generation_id_invalid"
  );
  const normalizedFingerprint = validateFingerprint(tokenFingerprint);

  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify([
        normalizedEventType,
        normalizedGenerationId,
        normalizedFingerprint
      ]),
      "utf8"
    )
    .digest("hex");
}

function emptyOutbox() {
  return {
    format_version: FORMAT_VERSION,
    events: {}
  };
}

function validateEvent(key, event) {
  if (
    !IDEMPOTENCY_KEY_PATTERN.test(String(key || "")) ||
    !event ||
    typeof event !== "object" ||
    Array.isArray(event)
  ) {
    fail("art_ready_outbox_invalid");
  }

  const allowedFields = new Set([
    "idempotency_key",
    "event_type",
    "generation_id",
    "token_fingerprint",
    "state",
    "created_at",
    "updated_at",
    "blocked_at",
    "prepared_at",
    "sent_at",
    "failed_at",
    "result_code"
  ]);
  if (Object.keys(event).some((field) => !allowedFields.has(field))) {
    fail("art_ready_outbox_invalid");
  }
  if (
    event.idempotency_key !== key ||
    event.event_type !== EVENT_TYPE ||
    !EVENT_STATES.has(event.state) ||
    idempotencyKey({
      eventType: event.event_type,
      generationId: event.generation_id,
      tokenFingerprint: event.token_fingerprint
    }) !== key
  ) {
    fail("art_ready_outbox_invalid");
  }
}

function readOutbox(filePath, fileSystem = fs) {
  if (!fileSystem.existsSync(filePath)) return emptyOutbox();

  let parsed;
  try {
    parsed = JSON.parse(fileSystem.readFileSync(filePath, "utf8"));
  } catch {
    fail("art_ready_outbox_invalid");
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    parsed.format_version !== FORMAT_VERSION ||
    !parsed.events ||
    typeof parsed.events !== "object" ||
    Array.isArray(parsed.events)
  ) {
    fail("art_ready_outbox_invalid");
  }

  for (const [key, event] of Object.entries(parsed.events)) {
    validateEvent(key, event);
  }
  return parsed;
}

function writeOutbox(filePath, outbox, fileSystem = fs) {
  const directory = path.dirname(filePath);
  if (!fileSystem.existsSync(directory)) {
    fileSystem.mkdirSync(directory, {
      recursive: true,
      mode: 0o700
    });
  }
  atomicWriteJson(filePath, outbox, { fileSystem });
}

function createArtReadyOutbox({
  filePath,
  fileSystem = fs,
  now = () => new Date().toISOString()
}) {
  if (!path.isAbsolute(filePath || "")) {
    fail("art_ready_outbox_path_invalid");
  }

  function get({
    generationId,
    tokenFingerprint
  }) {
    const key = idempotencyKey({
      generationId,
      tokenFingerprint
    });
    return readOutbox(filePath, fileSystem).events[key] || null;
  }

  function transition({
    generationId,
    tokenFingerprint,
    state,
    resultCode = ""
  }) {
    if (!EVENT_STATES.has(state)) fail("art_ready_state_invalid");
    const key = idempotencyKey({
      generationId,
      tokenFingerprint
    });
    const outbox = readOutbox(filePath, fileSystem);
    const previous = outbox.events[key] || null;

    if (previous?.state === "sent") return previous;
    if (
      previous?.state === "prepared" &&
      state === "prepared"
    ) {
      return previous;
    }
    if (
      previous?.state === "failed" &&
      state === "prepared"
    ) {
      return previous;
    }

    const timestamp = now();
    const next = {
      idempotency_key: key,
      event_type: EVENT_TYPE,
      generation_id: validateSafeId(
        generationId,
        "art_ready_generation_id_invalid"
      ),
      token_fingerprint: validateFingerprint(tokenFingerprint),
      state,
      created_at: previous?.created_at || timestamp,
      updated_at: timestamp,
      ...(previous?.blocked_at ? { blocked_at: previous.blocked_at } : {}),
      ...(previous?.prepared_at ? { prepared_at: previous.prepared_at } : {}),
      ...(previous?.sent_at ? { sent_at: previous.sent_at } : {}),
      ...(previous?.failed_at ? { failed_at: previous.failed_at } : {}),
      ...(state === "blocked" ? { blocked_at: timestamp } : {}),
      ...(state === "prepared" ? { prepared_at: timestamp } : {}),
      ...(state === "sent" ? { sent_at: timestamp } : {}),
      ...(state === "failed" ? { failed_at: timestamp } : {}),
      ...(resultCode ? {
        result_code: validateSafeId(
          resultCode,
          "art_ready_result_code_invalid"
        )
      } : {})
    };

    validateEvent(key, next);
    outbox.events[key] = next;
    writeOutbox(filePath, outbox, fileSystem);
    return next;
  }

  return Object.freeze({
    filePath,
    get,
    read: () => readOutbox(filePath, fileSystem),
    transition
  });
}

module.exports = {
  ArtReadyOutboxError,
  EVENT_STATES,
  EVENT_TYPE,
  FORMAT_VERSION,
  createArtReadyOutbox,
  idempotencyKey,
  readOutbox
};
