"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const {
  PUBLICATION_BINDING_VERSION,
  PublicationBindingError,
  normalizeConnectionBinding,
  assertSameConnectionBinding,
  publicationIntentIdentity,
  createPublicationIntent,
  publicationRequestHashFromSnapshot,
  assertPublicationRequestHash,
  assertStoredPublicationRequestHash
} = require("../src/social/publication/connection-binding");

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const CONNECTION_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONNECTION_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const REQUEST_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const REQUEST_B = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function binding(overrides = {}) {
  return {
    connectionId: CONNECTION_A,
    externalId: "17840000000000001",
    connectionRevision: 7,
    ...overrides
  };
}

function input(overrides = {}) {
  return {
    companyId: COMPANY_A,
    clientRequestId: REQUEST_A,
    mediaId: "reviewer_media_fixture_0001",
    mediaMetadataDigest: "a".repeat(64),
    caption: "Legenda de teste\nSem chamada externa.",
    binding: binding(),
    ...overrides
  };
}

function rejectsInvalid(callback) {
  assert.throws(callback, (error) =>
    error instanceof PublicationBindingError &&
    error.code === "publication_binding_invalid" &&
    error.message === "Vinculo de publicacao invalido."
  );
}

test("v2 returns a detached immutable binding with canonical UUID", () => {
  const source = binding({ connectionId: CONNECTION_A.toUpperCase() });
  const result = normalizeConnectionBinding(source);
  assert.equal(result.connectionId, CONNECTION_A);
  assert.equal(result.connectionRevision, 7);
  assert.equal(result.externalId, source.externalId);
  assert.ok(Object.isFrozen(result));
  source.externalId = "17840000000000002";
  assert.notEqual(source.externalId, result.externalId);
  assert.equal(PUBLICATION_BINDING_VERSION, 2);
});

for (const [name, value] of [
  ["missing", undefined], ["null", null], ["array", []], ["string", "x"],
  ["date", new Date(0)], ["partial", { connectionId: CONNECTION_A }],
  ["extra authority", binding({ companyId: COMPANY_B })],
  ["username substitute", { connectionId: CONNECTION_A, username: "same", connectionRevision: 7 }],
  ["missing revision", { connectionId: CONNECTION_A, externalId: "17840000000000001" }],
  ["symbol", { ...binding(), [Symbol("extra")]: 1 }]
]) {
  test(`binding rejects ${name}`, () => rejectsInvalid(() => normalizeConnectionBinding(value)));
}

for (const revision of [0, -1, 1.5, "7", 7n, true, null, undefined, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
  test(`binding rejects revision type/value ${String(revision)}`, () =>
    rejectsInvalid(() => normalizeConnectionBinding(binding({ connectionRevision: revision })))
  );
}

test("binding accepts safe integer revision boundaries without coercion", () => {
  for (const connectionRevision of [1, Number.MAX_SAFE_INTEGER]) {
    assert.equal(normalizeConnectionBinding(binding({ connectionRevision })).connectionRevision,
      connectionRevision);
  }
});

for (const [name, externalId] of [
  ["number", 17840000000000001], ["short", "1234"], ["long", "1".repeat(65)],
  ["trim", " 17840000000000001"], ["sign", "+17840000000000001"],
  ["exponent", "1e17"], ["decimal", "17840.1"], ["username", "same_username"],
  ["url", "https://example.invalid/17840000000000001"], ["newline", "17840\n"],
  ["unicode digits", "１２３４５"]
]) {
  test(`binding rejects external ID ${name}`, () =>
    rejectsInvalid(() => normalizeConnectionBinding(binding({ externalId })))
  );
}

test("external identifier is kept as exact decimal text", () => {
  for (const externalId of ["12345", "1".repeat(64), "0012345"]) {
    assert.equal(normalizeConnectionBinding(binding({ externalId })).externalId, externalId);
  }
});

test("getter, custom prototype and non-enumerable fields are refused", () => {
  let getterInvoked = false;
  const getter = { ...binding() };
  Object.defineProperty(getter, "externalId", {
    enumerable: true, get() { getterInvoked = true; throw new Error("fixture-private-text"); }
  });
  rejectsInvalid(() => normalizeConnectionBinding(getter));
  assert.equal(getterInvoked, false);
  rejectsInvalid(() => normalizeConnectionBinding(Object.create(binding())));
  const hidden = binding();
  Object.defineProperty(hidden, "connectionRevision", { value: 7, enumerable: false });
  rejectsInvalid(() => normalizeConnectionBinding(hidden));
  const nullPrototype = Object.assign(Object.create(null), binding());
  assert.deepEqual(normalizeConnectionBinding(nullPrototype), binding());
});

test("proxy exceptions and malformed values never leak supplied error content", () => {
  const proxy = new Proxy({}, { getPrototypeOf() { throw new Error("fixture-private-text"); } });
  rejectsInvalid(() => normalizeConnectionBinding(proxy));
  const error = new PublicationBindingError("fixture-private-text");
  assert.equal(error.code, "publication_binding_invalid");
  assert.doesNotMatch(error.message, /fixture-private-text/);
  const hostileCode = { toString() { throw new Error("fixture-private-text"); } };
  assert.equal(new PublicationBindingError(hostileCode).code, "publication_binding_invalid");
});

test("matching binding does not accept a change of account, connection or revision", () => {
  assert.deepEqual(assertSameConnectionBinding(binding(), binding()), binding());
  for (const actual of [binding({ connectionId: CONNECTION_B }),
    binding({ externalId: "17840000000000002" }), binding({ connectionRevision: 8 })]) {
    assert.throws(() => assertSameConnectionBinding(binding(), actual),
      { code: "publication_binding_conflict" });
  }
  rejectsInvalid(() => assertSameConnectionBinding(binding(), null));
});

test("intent IDs are stable and are isolated by company and client request", () => {
  const first = publicationIntentIdentity({ companyId: COMPANY_A, clientRequestId: REQUEST_A });
  assert.deepEqual(first, publicationIntentIdentity({ companyId: COMPANY_A, clientRequestId: REQUEST_A }));
  assert.notEqual(first.publicationId, first.operationId);
  assert.ok(Object.isFrozen(first));
  for (const source of [{ companyId: COMPANY_B, clientRequestId: REQUEST_A },
    { companyId: COMPANY_A, clientRequestId: REQUEST_B }]) {
    const other = publicationIntentIdentity(source);
    assert.notEqual(first.publicationId, other.publicationId);
    assert.notEqual(first.operationId, other.operationId);
  }
});

test("changing account/content never creates a second intent ID for the same request", () => {
  const first = createPublicationIntent(input());
  for (const source of [input({ binding: binding({ externalId: "17840000000000002" }) }),
    input({ binding: binding({ connectionId: CONNECTION_B }) }),
    input({ binding: binding({ connectionRevision: 8 }) }),
    input({ mediaId: "reviewer_media_fixture_0002" }),
    input({ mediaMetadataDigest: "b".repeat(64) }), input({ caption: "Outra legenda" })]) {
    const changed = createPublicationIntent(source);
    assert.equal(first.publicationId, changed.publicationId);
    assert.equal(first.operationId, changed.operationId);
    assert.notEqual(first.requestHash, changed.requestHash);
    assert.throws(() => assertPublicationRequestHash(first.requestHash, source),
      { code: "publication_intent_conflict" });
  }
});

test("hash has a fixed-order, domain-separated canonical representation", () => {
  const source = input();
  const result = createPublicationIntent(source);
  const independentHash = crypto.createHash("sha256").update(JSON.stringify([
    "ia4tube:instagram:publication-request:v2",
    COMPANY_A, result.publicationId, result.operationId,
    CONNECTION_A, "17840000000000001", 7,
    source.mediaId, "a".repeat(64), source.caption
  ]), "utf8").digest("hex");
  assert.equal(result.requestHash, independentHash);
  const reordered = Object.fromEntries(Object.entries(source).reverse());
  reordered.binding = Object.fromEntries(Object.entries(source.binding).reverse());
  assert.deepEqual(result, createPublicationIntent(reordered));
  assert.equal(result.contractVersion, 2);
  assert.equal(result.provider, "instagram");
  assert.equal(result.caption, source.caption);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.binding));
});

test("versioned identity and request commitment match the frozen fixture vector", () => {
  const result = createPublicationIntent(input());
  assert.equal(result.publicationId, "fce46d49-f69b-5cbd-aa76-eafcb0369496");
  assert.equal(result.operationId, "d712079e-fe67-5ee7-9bdf-539ecc647e3d");
  assert.equal(result.requestHash,
    "314eeae8ed40a4ab567ad55a2db9933fd7a57e7d97795e2ca8904fbf78feb946");
});

test("UUID letter case is normalized without creating another intent", () => {
  assert.deepEqual(createPublicationIntent(input()), createPublicationIntent(input({
    clientRequestId: REQUEST_A.toUpperCase(),
    binding: binding({ connectionId: CONNECTION_A.toUpperCase() })
  })));
});

test("caption whitespace and Unicode are not silently normalized", () => {
  const hashes = ["Legenda", " Legenda", "Legenda ", "é", "e\u0301"]
    .map((caption) => createPublicationIntent(input({ caption })).requestHash);
  assert.equal(new Set(hashes).size, hashes.length);
  assert.equal(createPublicationIntent(input({ caption: "x".repeat(2200) })).caption.length, 2200);
});

for (const [name, overrides] of [
  ["unknown provider", { provider: "instagram" }], ["caller publication ID", { publicationId: REQUEST_B }],
  ["caller operation ID", { operationId: REQUEST_B }], ["empty caption", { caption: "" }],
  ["long caption", { caption: "x".repeat(2201) }], ["NUL caption", { caption: "x\0" }],
  ["URL media", { mediaId: "https://example.invalid/media" }], ["short media", { mediaId: "short" }],
  ["long media", { mediaId: "x".repeat(201) }], ["metadata digest uppercase", { mediaMetadataDigest: "A".repeat(64) }],
  ["metadata digest absent", { mediaMetadataDigest: undefined }], ["legacy binding absent", { binding: undefined }],
  ["invalid company", { companyId: "company-a" }], ["invalid request UUID", { clientRequestId: "request-a" }],
  ["UUID whitespace", { clientRequestId: ` ${REQUEST_A}` }]
]) {
  test(`intent rejects ${name}`, () => rejectsInvalid(() => createPublicationIntent(input(overrides))));
}

test("identity rejects account/content and incomplete authority fields", () => {
  rejectsInvalid(() => publicationIntentIdentity({ companyId: COMPANY_A }));
  rejectsInvalid(() => publicationIntentIdentity({ companyId: COMPANY_A, clientRequestId: REQUEST_A,
    externalId: "17840000000000001" }));
});

test("stored hash must be exact v2 proof; there is no legacy/current-account fallback", () => {
  const source = input();
  const expected = createPublicationIntent(source);
  assert.deepEqual(assertPublicationRequestHash(expected.requestHash, source), expected);
  assert.throws(() => assertPublicationRequestHash("0".repeat(64), source),
    { code: "publication_intent_conflict" });
  for (const stored of [null, undefined, 123, "A".repeat(64), "0".repeat(63)]) {
    rejectsInvalid(() => assertPublicationRequestHash(stored, source));
  }
  assert.throws(() => assertPublicationRequestHash(expected.requestHash, input({ companyId: COMPANY_B })),
    { code: "publication_intent_conflict" });
});

function persistedSnapshot(intent, overrides = {}) {
  return {
    companyId: intent.companyId,
    publicationId: intent.publicationId,
    // The publication's immutable initial idempotency_key, not a new reconcile operation.
    operationId: intent.operationId,
    mediaId: intent.mediaId,
    mediaMetadataDigest: intent.mediaMetadataDigest,
    caption: intent.caption,
    binding: { ...intent.binding },
    ...overrides
  };
}

test("hash is recoverable from persisted IDs and original snapshot without client witness", () => {
  const original = createPublicationIntent(input());
  const stored = persistedSnapshot(original);
  assert.equal(Object.hasOwn(stored, "clientRequestId"), false);
  assert.equal(publicationRequestHashFromSnapshot(stored), original.requestHash);
  const verified = assertStoredPublicationRequestHash(original.requestHash, stored);
  assert.equal(verified.requestHash, original.requestHash);
  assert.equal(Object.hasOwn(verified, "clientRequestId"), false);
  assert.ok(Object.isFrozen(verified));
  assert.ok(Object.isFrozen(verified.binding));
  stored.binding.externalId = "17840000000000002";
  assert.equal(verified.binding.externalId, original.binding.externalId);
});

test("recovered snapshot rejects changed original IDs, content, account or revision", () => {
  const original = createPublicationIntent(input());
  for (const overrides of [
    { companyId: COMPANY_B }, { publicationId: REQUEST_B }, { operationId: REQUEST_B },
    { mediaId: "reviewer_media_fixture_0002" }, { mediaMetadataDigest: "b".repeat(64) },
    { caption: "Legenda alterada" }, { binding: binding({ connectionId: CONNECTION_B }) },
    { binding: binding({ externalId: "17840000000000002" }) },
    { binding: binding({ connectionRevision: 8 }) }
  ]) {
    assert.throws(() => assertStoredPublicationRequestHash(original.requestHash,
      persistedSnapshot(original, overrides)), { code: "publication_intent_conflict" });
  }
});

test("recovered snapshot does not accept a client witness or unknown legacy binding", () => {
  const original = createPublicationIntent(input());
  for (const overrides of [
    { clientRequestId: REQUEST_A }, { binding: null }, { binding: undefined },
    { operationId: undefined }, { publicationId: undefined }
  ]) {
    rejectsInvalid(() => assertStoredPublicationRequestHash(original.requestHash,
      persistedSnapshot(original, overrides)));
  }
});
