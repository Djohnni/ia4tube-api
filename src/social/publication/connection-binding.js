"use strict";

const crypto = require("node:crypto");

const PUBLICATION_BINDING_VERSION = 2;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EXTERNAL_ID_PATTERN = /^[0-9]{5,64}$/;
const MEDIA_ID_PATTERN = /^[A-Za-z0-9:_-]{20,200}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const CAPTION_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const MESSAGES = Object.freeze({
  publication_binding_invalid: "Vinculo de publicacao invalido.",
  publication_binding_conflict: "Vinculo de publicacao divergente.",
  publication_intent_conflict: "Intencao de publicacao divergente."
});

class PublicationBindingError extends Error {
  constructor(code) {
    const safeCode = typeof code === "string" && Object.hasOwn(MESSAGES, code)
      ? code
      : "publication_binding_invalid";
    super(MESSAGES[safeCode]);
    this.name = "PublicationBindingError";
    this.code = safeCode;
  }
}

function fail(code = "publication_binding_invalid") {
  throw new PublicationBindingError(code);
}

// HTTP adapters must supply companyId from verified server context. This pure
// module validates data; it neither authenticates a company nor acquires locks.
function exactRecord(value, keys) {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail();
    const actualKeys = Reflect.ownKeys(value);
    if (actualKeys.length !== keys.length) fail();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result = Object.create(null);
    for (const key of actualKeys) {
      if (typeof key !== "string" || !keys.includes(key)) fail();
      const descriptor = descriptors[key];
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) fail();
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    // Never propagate attacker-controlled exception text or invoke accessors.
    fail();
  }
}

function uuid(value) {
  if (typeof value !== "string") fail();
  const normalized = value.toLowerCase();
  if (!UUID_PATTERN.test(normalized)) fail();
  return normalized;
}

function digest(value) {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) fail();
  return value;
}

function normalizeConnectionBinding(value) {
  const source = exactRecord(value, [
    "connectionId", "externalId", "connectionRevision"
  ]);
  if (
    typeof source.externalId !== "string" ||
    !EXTERNAL_ID_PATTERN.test(source.externalId) ||
    !Number.isSafeInteger(source.connectionRevision) ||
    source.connectionRevision < 1
  ) fail();
  return Object.freeze({
    connectionId: uuid(source.connectionId),
    externalId: source.externalId,
    connectionRevision: source.connectionRevision
  });
}

function assertSameConnectionBinding(expected, actual) {
  const cleanExpected = normalizeConnectionBinding(expected);
  const cleanActual = normalizeConnectionBinding(actual);
  if (
    cleanExpected.connectionId !== cleanActual.connectionId ||
    cleanExpected.externalId !== cleanActual.externalId ||
    cleanExpected.connectionRevision !== cleanActual.connectionRevision
  ) fail("publication_binding_conflict");
  return cleanExpected;
}

// Application-specific SHA-256 derivation, with UUID version/variant bits
// matching the existing connector's accepted identifier format. Not UUIDv5's
// standard SHA-1 derivation. The encoded arrays are the versioned wire contract.
function derivedUuid(parts) {
  const bytes = crypto.createHash("sha256")
    .update(JSON.stringify(parts), "utf8").digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  bytes.fill(0);
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16),
    hex.slice(16, 20), hex.slice(20)].join("-");
}

function publicationIntentIdentity(value) {
  const source = exactRecord(value, ["companyId", "clientRequestId"]);
  const companyId = uuid(source.companyId);
  const clientRequestId = uuid(source.clientRequestId);
  // Account, revision, media and caption deliberately do NOT affect these IDs.
  // The same client request with different content must conflict, not fork.
  return Object.freeze({
    publicationId: derivedUuid([
      "ia4tube:instagram:publication-id:v2", companyId, clientRequestId
    ]),
    operationId: derivedUuid([
      "ia4tube:instagram:initial-operation-id:v2", companyId, clientRequestId
    ])
  });
}

function publicationSnapshot(value) {
  const source = exactRecord(value, [
    "companyId", "publicationId", "operationId", "mediaId", "mediaMetadataDigest",
    "caption", "binding"
  ]);
  const companyId = uuid(source.companyId);
  const publicationId = uuid(source.publicationId);
  const operationId = uuid(source.operationId);
  const binding = normalizeConnectionBinding(source.binding);
  if (
    typeof source.mediaId !== "string" ||
    !MEDIA_ID_PATTERN.test(source.mediaId) ||
    typeof source.caption !== "string" ||
    source.caption.length < 1 || source.caption.length > 2200 ||
    CAPTION_CONTROLS.test(source.caption)
  ) fail();
  const mediaMetadataDigest = digest(source.mediaMetadataDigest);
  // Fixed-order typed array: no dependence on object-key insertion order or
  // delimiter concatenation. Caption is exact (no trimming/Unicode folding).
  // The raw client UUID is deliberately absent: these IDs already commit to
  // it, and both are persisted. Recovery must work without the client witness.
  const requestHash = crypto.createHash("sha256").update(JSON.stringify([
    "ia4tube:instagram:publication-request:v2",
    companyId, publicationId, operationId,
    binding.connectionId, binding.externalId, binding.connectionRevision,
    source.mediaId, mediaMetadataDigest, source.caption
  ]), "utf8").digest("hex");
  return Object.freeze({
    contractVersion: PUBLICATION_BINDING_VERSION,
    companyId,
    provider: "instagram",
    publicationId,
    operationId,
    binding,
    mediaId: source.mediaId,
    mediaMetadataDigest,
    caption: source.caption,
    requestHash
  });
}

function createPublicationIntent(value) {
  const source = exactRecord(value, [
    "companyId", "clientRequestId", "mediaId", "mediaMetadataDigest",
    "caption", "binding"
  ]);
  const companyId = uuid(source.companyId);
  const clientRequestId = uuid(source.clientRequestId);
  const identity = publicationIntentIdentity({ companyId, clientRequestId });
  const snapshot = publicationSnapshot({
    companyId,
    ...identity,
    mediaId: source.mediaId,
    mediaMetadataDigest: source.mediaMetadataDigest,
    caption: source.caption,
    binding: source.binding
  });
  return Object.freeze({ ...snapshot, clientRequestId });
}

function publicationRequestHashFromSnapshot(snapshotInput) {
  return publicationSnapshot(snapshotInput).requestHash;
}

function assertHashMatches(storedHash, actualHash) {
  const expectedHash = digest(storedHash);
  const expectedBytes = Buffer.from(expectedHash, "hex");
  const actualBytes = Buffer.from(actualHash, "hex");
  let matches;
  try {
    matches = crypto.timingSafeEqual(expectedBytes, actualBytes);
  } finally {
    expectedBytes.fill(0);
    actualBytes.fill(0);
  }
  if (!matches) fail("publication_intent_conflict");
}

function assertPublicationRequestHash(storedHash, intentInput) {
  const intent = createPublicationIntent(intentInput);
  assertHashMatches(storedHash, intent.requestHash);
  return intent;
}

function assertStoredPublicationRequestHash(storedHash, snapshotInput) {
  // These values must come from the authorized, locked persistence snapshot;
  // this function does not establish that authority or acquire the lock.
  const snapshot = publicationSnapshot(snapshotInput);
  assertHashMatches(storedHash, snapshot.requestHash);
  return snapshot;
}

module.exports = Object.freeze({
  PUBLICATION_BINDING_VERSION,
  PublicationBindingError,
  normalizeConnectionBinding,
  assertSameConnectionBinding,
  publicationIntentIdentity,
  createPublicationIntent,
  publicationRequestHashFromSnapshot,
  assertPublicationRequestHash,
  assertStoredPublicationRequestHash
});
